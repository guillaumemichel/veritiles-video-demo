// Media Source Extensions player over veritiles VerifiedFiles, one per
// track: a muxed file is one track, a YouTube-style pair (video itag +
// audio itag) is two. Each track owns a SourceBuffer, a segment index read
// off its global sidx and a read cursor; they share one MediaSource and the
// element's clock. Playback is sequential verified segment reads with a
// buffered-ahead watermark, seeks jump every cursor to the covering
// segment, and every byte handed to the decoder has been verified against
// its anchor CID — tampered responses never reach it.
import { HEAD_MAX, mimeType, parseHead, segmentAt } from './mp4.js';

const TARGET_AHEAD_S = 30; // stop fetching once this much is buffered ahead
const TRIM_KEEP_S = 10; // history kept behind the playhead on quota pressure
const HEAD_PROBE = 64 * 1024;
const UPDATE_MS = 500;

// { video, tracks: [{ cid, sources, proof }], VerifiedFile, labels?, onUpdate?, signal? }
// → { stop(), snapshot() }. The VerifiedFile class is injected so this
// module stays import-free of the library bundle (testable in node); signal
// aborts the opening reads so a superseding source needn't wait them out.
export async function startStream({ video, tracks, VerifiedFile, labels, onUpdate, signal: openSignal }) {
  if (typeof MediaSource === 'undefined') {
    throw new Error('this browser has no Media Source Extensions');
  }
  if (tracks.length === 0) throw new Error('no tracks to play');

  const transfers = trackTransfers(tracks.flatMap((t) => [...t.sources, t.proof]), labels);
  // One track's head failing aborts the others' reads: nobody is left to
  // consume them.
  const headCtl = new AbortController();
  const headSignal = merge(openSignal, headCtl.signal);
  let opened;
  try {
    opened = await Promise.all(tracks.map(async ({ cid, sources, proof }) => {
      const vf = new VerifiedFile({ cid, source: sources, proof, fetchFn: transfers.fetchFn });
      const { index, codecs } = await readHead(vf, headSignal);
      const mime = mimeType(codecs);
      if (!MediaSource.isTypeSupported(mime)) {
        throw new Error(`this browser cannot play ${mime} through Media Source Extensions`);
      }
      return { vf, index, codecs, mime };
    }));
  } catch (err) {
    headCtl.abort();
    throw err;
  }

  const ctl = new AbortController();
  const { signal } = ctl;
  const shared = { ended: false, stopped: false, error: null };

  const ms = new MediaSource();
  video.src = URL.createObjectURL(ms);
  let players;
  // From here the element is ours; a failure hands it back clean.
  try {
    await once(ms, 'sourceopen', merge(openSignal, signal));
    // The fragmented init segments carry no duration; without this the
    // seekable range (and the native scrubber) would only span the buffer.
    ms.duration = Math.max(...opened.map((t) => t.index.duration));
    players = opened.map((t) => trackPlayer(t, ms.addSourceBuffer(t.mime)));
    await Promise.all(players.map((p) => p.init()));
  } catch (err) {
    ctl.abort();
    detach();
    throw err;
  }

  video.addEventListener('timeupdate', pumpAll, { signal });
  video.addEventListener('seeking', onSeek, { signal });
  const timer = setInterval(report, UPDATE_MS);

  // One track's read loop: cursor, in-flight read, and the append it owes.
  function trackPlayer({ vf, index, codecs }, sb) {
    const state = { next: 0, pumping: false, pendingAppend: null, readCtl: null, removing: false };
    sb.addEventListener('updateend', onUpdateEnd, { signal });
    sb.addEventListener('error', () => fail(new Error('SourceBuffer error — append rejected by the decoder')), { signal });

    async function init() {
      sb.appendBuffer(await abortableRead(vf, 0, index.initEnd, openSignal));
    }

    function onUpdateEnd() {
      state.removing = false;
      if (shared.stopped) return;
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
      if (shared.stopped || state.pumping || state.pendingAppend || sb.updating) return;
      if (state.next >= index.segments.length) return maybeEnd();
      if (bufferedAhead(sb) >= TARGET_AHEAD_S) return; // timeupdate re-drives
      const at = state.next;
      const segment = index.segments[at];
      const readCtl = new AbortController();
      state.pumping = true;
      state.readCtl = readCtl;
      let bytes = null;
      try {
        bytes = await vf.read(segment.offset, segment.size, { signal: readCtl.signal });
      } catch (err) {
        if (!readCtl.signal.aborted) fail(err); // an aborted read is a seek, not a failure
      } finally {
        state.pumping = false;
        if (state.readCtl === readCtl) state.readCtl = null;
      }
      if (shared.stopped || shared.error !== null) return;
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
        state.removing = true;
        sb.remove(0, keepFrom);
      }
    }

    function seek() {
      state.next = segmentAt(index.segments, video.currentTime);
      state.pendingAppend = null;
      state.readCtl?.abort(); // stop the in-flight read: its bandwidth now belongs to the target
      // A running removal cannot be aborted (InvalidStateError); its own
      // updateend re-drives the pump from the new cursor.
      if (sb.updating && !state.removing) sb.abort();
      void pump();
    }

    return {
      init,
      pump,
      seek,
      vf,
      drained: () => state.next >= index.segments.length && !sb.updating,
      abort: () => state.readCtl?.abort(),
      snapshot: () => ({
        codecs,
        segment: Math.min(state.next, index.segments.length),
        segments: index.segments.length,
        duration: index.duration,
        aheadSeconds: bufferedAhead(sb),
      }),
    };
  }

  function pumpAll() {
    for (const player of players) void player.pump();
  }

  function onSeek() {
    if (shared.stopped) return;
    shared.ended = false;
    for (const player of players) player.seek();
  }

  function maybeEnd() {
    if (shared.ended || !players.every((p) => p.drained())) return;
    if (ms.readyState !== 'open') return;
    shared.ended = true;
    ms.endOfStream();
  }

  function bufferedAhead(sb) {
    const t = video.currentTime;
    for (let i = 0; i < sb.buffered.length; i++) {
      if (t >= sb.buffered.start(i) - 0.1 && t <= sb.buffered.end(i)) return sb.buffered.end(i) - t;
    }
    return 0;
  }

  function fail(err) {
    shared.error = err;
    report();
  }

  function snapshot() {
    const perTrack = players.map((p) => p.snapshot());
    return {
      stats: players.reduce((sum, p) => ({ verified: sum.verified + p.vf.stats.verified, rejected: sum.rejected + p.vf.stats.rejected }), { verified: 0, rejected: 0 }),
      transfers: transfers.snapshot(),
      tracks: perTrack,
      codecs: perTrack.map((t) => t.codecs).join(', '),
      duration: ms.duration,
      aheadSeconds: Math.min(...perTrack.map((t) => t.aheadSeconds)),
      error: shared.error,
    };
  }

  function report() {
    if (!shared.stopped) onUpdate?.(snapshot());
  }

  function detach() {
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }

  function stop() {
    shared.stopped = true;
    for (const player of players) player.abort();
    clearInterval(timer);
    ctl.abort();
    detach();
  }

  report();
  return { stop, snapshot };
}

// Grow the head read until the global sidx is fully buffered; the codecs
// come off the moov that precedes it. Reads clamp at EOF, so a short return
// means the whole file was scanned without a sidx.
async function readHead(vf, signal) {
  for (let probe = HEAD_PROBE; ; probe = Math.min(probe * 4, HEAD_MAX)) {
    const head = await abortableRead(vf, 0, probe, signal);
    const parsed = parseHead(head);
    if (parsed !== null) return parsed;
    if (head.length < probe || probe >= HEAD_MAX) {
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

function merge(optional, signal) {
  return optional === undefined ? signal : AbortSignal.any([optional, signal]);
}

// Per-configured-base request/byte counters, fed by the fetchFn seam. Bytes
// are the transported response sizes (Content-Length), counted whether or
// not the payload later verifies — tampered downloads are traffic too.
function trackTransfers(bases, labels) {
  const rows = [...new Set(bases)].map((base) => ({ base, label: labels?.get(base) ?? base, requests: 0, bytes: 0 }));
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
    signal.addEventListener('abort', () => reject(new DOMException('open aborted', 'AbortError')), { once: true });
  });
}
