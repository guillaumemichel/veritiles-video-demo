// Media Source Extensions player over a veritiles VerifiedFile: the codecs
// come from the file's moov and the segment index from its global sidx,
// playback is sequential verified segment reads with a buffered-ahead
// watermark, and seeks jump the read cursor to the covering segment. Every
// byte handed to the decoder has been verified against the anchor CID;
// tampered responses never reach it.
import { parseCodecs, parseIndex, segmentAt } from './mp4.js';

const TARGET_AHEAD_S = 30; // stop fetching once this much is buffered ahead
const TRIM_KEEP_S = 10; // history kept behind the playhead on quota pressure
const HEAD_PROBE = 64 * 1024;
const HEAD_PROBE_MAX = 8 * 1024 * 1024;
const UPDATE_MS = 500;

// { video, cid, sources, proof, VerifiedFile, labels?, onUpdate?, signal? }
// → { stop(), snapshot(), vf }. The VerifiedFile class is injected so this
// module stays import-free of the library bundle (testable in node); signal
// aborts the opening reads so a superseding source needn't wait them out.
export async function startStream({ video, cid, sources, proof, VerifiedFile, labels, onUpdate, signal: openSignal }) {
  if (typeof MediaSource === 'undefined') {
    throw new Error('this browser has no Media Source Extensions');
  }

  const transfers = trackTransfers([...sources, proof], labels);
  const vf = new VerifiedFile({ cid, source: sources, proof, fetchFn: transfers.fetchFn });
  const { index, codecs } = await readHead(vf, openSignal);
  const mime = `video/mp4; codecs="${codecs}"`;
  if (!MediaSource.isTypeSupported(mime)) {
    throw new Error(`this browser cannot play ${mime} through Media Source Extensions`);
  }

  const ctl = new AbortController();
  const { signal } = ctl;
  const state = { next: 0, pumping: false, pendingAppend: null, readCtl: null, ended: false, stopped: false, error: null };

  const ms = new MediaSource();
  video.src = URL.createObjectURL(ms);
  await once(ms, 'sourceopen', signal);
  const sb = ms.addSourceBuffer(mime);
  // The fragmented init segment carries no duration; without this the
  // seekable range (and the native scrubber) would only span the buffer.
  ms.duration = index.duration;
  sb.appendBuffer(await abortableRead(vf, 0, index.initEnd, openSignal));

  sb.addEventListener('updateend', onUpdateEnd, { signal });
  sb.addEventListener('error', () => fail(new Error('SourceBuffer error — append rejected by the decoder')), { signal });
  video.addEventListener('timeupdate', pump, { signal });
  video.addEventListener('seeking', onSeek, { signal });
  const timer = setInterval(report, UPDATE_MS);

  function onUpdateEnd() {
    if (state.stopped) return;
    if (state.pendingAppend) {
      const bytes = state.pendingAppend;
      state.pendingAppend = null;
      append(bytes);
      return;
    }
    maybeEnd();
    void pump();
  }

  async function pump() {
    if (state.stopped || state.pumping || state.pendingAppend || sb.updating) return;
    if (state.next >= index.segments.length) return maybeEnd();
    if (bufferedAhead() >= TARGET_AHEAD_S) return; // timeupdate re-drives
    const at = state.next;
    const segment = index.segments[at];
    const ctl = new AbortController();
    state.pumping = true;
    state.readCtl = ctl;
    let bytes = null;
    try {
      bytes = await vf.read(segment.offset, segment.size, { signal: ctl.signal });
    } catch (err) {
      if (!ctl.signal.aborted) fail(err); // an aborted read is a seek, not a failure
    } finally {
      state.pumping = false;
      if (state.readCtl === ctl) state.readCtl = null;
    }
    if (state.stopped || state.error !== null) return;
    if (bytes === null || state.next !== at) return void pump(); // superseded by a seek
    state.next = at + 1;
    append(bytes);
    report();
  }

  function append(bytes) {
    try {
      sb.appendBuffer(bytes);
    } catch (err) {
      if (err.name !== 'QuotaExceededError') return fail(err);
      // Trim history and let updateend retry this append once room exists.
      const keepFrom = Math.max(0, video.currentTime - TRIM_KEEP_S);
      if (keepFrom <= 0) return fail(err);
      state.pendingAppend = bytes;
      sb.remove(0, keepFrom);
    }
  }

  function onSeek() {
    if (state.stopped) return;
    state.next = segmentAt(index.segments, video.currentTime);
    state.ended = false;
    state.pendingAppend = null;
    state.readCtl?.abort(); // stop the in-flight read: its bandwidth now belongs to the target
    if (sb.updating) sb.abort();
    void pump();
  }

  function maybeEnd() {
    if (state.ended || state.next < index.segments.length || sb.updating) return;
    if (ms.readyState !== 'open') return;
    state.ended = true;
    ms.endOfStream();
  }

  function bufferedAhead() {
    const t = video.currentTime;
    for (let i = 0; i < sb.buffered.length; i++) {
      if (t >= sb.buffered.start(i) - 0.1 && t <= sb.buffered.end(i)) return sb.buffered.end(i) - t;
    }
    return 0;
  }

  function fail(err) {
    state.error = err;
    report();
  }

  function snapshot() {
    return {
      stats: { ...vf.stats },
      transfers: transfers.snapshot(),
      segment: Math.min(state.next, index.segments.length),
      segments: index.segments.length,
      duration: index.duration,
      codecs,
      aheadSeconds: bufferedAhead(),
      error: state.error,
    };
  }

  function report() {
    if (!state.stopped) onUpdate?.(snapshot());
  }

  function stop() {
    state.stopped = true;
    state.readCtl?.abort();
    clearInterval(timer);
    ctl.abort();
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }

  report();
  return { stop, snapshot, vf };
}

// Grow the head read until the global sidx is fully buffered, then read the
// codecs off the moov that precedes it. Reads clamp at EOF, so a short
// return means the whole file was scanned without a sidx.
async function readHead(vf, signal) {
  for (let probe = HEAD_PROBE; ; probe = Math.min(probe * 4, HEAD_PROBE_MAX)) {
    const head = await abortableRead(vf, 0, probe, signal);
    const index = parseIndex(head);
    if (index !== null) return { index, codecs: parseCodecs(head) };
    if (head.length < probe || probe >= HEAD_PROBE_MAX) {
      throw new Error('no complete sidx index in the file head');
    }
  }
}

// VerifiedFile.read checks its signal only between fetches, and its lazy
// memoized open ignores callers' signals entirely, so a host that never
// answers would pin the read past an abort — race the signal so the promise
// rejects the moment it fires (the stray fetch is left to the browser).
function abortableRead(vf, offset, length, signal) {
  if (signal === undefined) return vf.read(offset, length);
  const aborted = new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('open aborted', 'AbortError')), { once: true });
  });
  return Promise.race([vf.read(offset, length, { signal }), aborted]);
}

// Per-configured-base request/byte counters, fed by the fetchFn seam. Bytes
// are the transported response sizes (Content-Length), counted whether or
// not the payload later verifies — tampered downloads are traffic too.
function trackTransfers(bases, labels) {
  const rows = bases.map((base) => ({ base, label: labels?.get(base) ?? base, requests: 0, bytes: 0 }));
  // Longest matching base wins: every proof URL also starts with the content
  // URL it sits beside (`file.mp4.proofs/…` vs `file.mp4`).
  const rowFor = (url) => rows.reduce(
    (best, row) => (url.startsWith(row.base) && row.base.length > (best?.base.length ?? 0) ? row : best),
    undefined,
  );
  return {
    fetchFn: async (input, init) => {
      const row = rowFor(String(input));
      if (row) row.requests += 1;
      const response = await fetch(input, init);
      if (row) row.bytes += Number(response.headers.get('content-length') ?? 0);
      return response;
    },
    snapshot: () => rows.map((row) => ({ ...row })),
  };
}

function once(target, event, signal) {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, resolve, { once: true, signal });
    signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  });
}
