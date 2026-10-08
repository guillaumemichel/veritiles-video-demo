// Page controller. A source is one or more tracks, each an (anchor CID,
// URL) pair — a muxed file is one track, a YouTube-derived video is its
// video and audio itags. Sources come from the built-in presets or from the
// form (one CID and one URL per track, whitespace-separated) and live in
// the query string as repeated cid/src pairs, so every source is a
// shareable link. Wires the form, the tamper toggle, the transfer table,
// the counters, the alert and the YouTube origin panel around startStream.
// Strings that can come from the user or a host only ever reach the DOM
// through textContent.

const CUSTOM = 'custom';
const IDS = ['video', 'source', 'preset', 'cid', 'src', 'toggle', 'evilToggle', 'mirrors', 'counters', 'alert',
  'origin', 'originLink', 'originMeta', 'recipe'];
const TAMPER_BANNER = '⛔ Tampered bytes caught and rejected — the malicious mirror is banned for this '
  + 'session, and playback continues from the honest one. Not one altered byte was rendered.';

// { config: { presets }, veritiles: the library namespace, startStream }
export function boot({ config, veritiles, startStream }) {
  const els = Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)]));
  const presets = (config.presets ?? []).map(resolvePreset);
  let active = null; // { tracks: [{ cid, src, evil? }], preset? } — what playback runs on
  let current = null;
  let opening = null; // the startStream call in flight
  let openCtl = null; // aborts that open's reads when a newer start supersedes it
  let generation = 0;
  let shownStreamAlert = null; // the sticky stream alert already painted

  els.preset.replaceChildren(...presets.map((p) => option(p.id, p.label)), option(CUSTOM, 'custom…'));
  els.preset.addEventListener('change', onPresetChange);
  els.cid.addEventListener('input', reflectPreset);
  els.src.addEventListener('input', reflectPreset);
  els.source.addEventListener('submit', (event) => { event.preventDefault(); applyFields(); });
  els.evilToggle.addEventListener('change', () => { if (active) void start(true); });

  const query = readQuery();
  if (query) {
    setFields(query);
    applyFields();
  } else if (presets.length > 0) {
    load({ tracks: presets[0].tracks });
  } else {
    showAlert('✗ no source: open the page with ?cid=<anchor>&src=<video url>');
  }

  function fields() {
    return { cid: els.cid.value.trim(), src: els.src.value.trim() };
  }

  function setFields({ cid, src }) {
    els.cid.value = cid;
    els.src.value = src;
  }

  function fieldsOf(tracks) {
    return { cid: tracks.map((t) => t.cid).join(' '), src: tracks.map((t) => t.src).join(' ') };
  }

  function presetFor({ tracks }) {
    return presets.find((p) => sameTracks(p.tracks, tracks));
  }

  function reflectPreset() {
    const parsed = parseSource(fields());
    els.preset.value = (parsed.source && presetFor(parsed.source)?.id) ?? CUSTOM;
  }

  function onPresetChange() {
    const preset = presets.find((p) => p.id === els.preset.value);
    if (!preset) return els.cid.focus();
    setFields(fieldsOf(preset.tracks));
    applyFields();
  }

  function applyFields() {
    const { source, error } = parseSource(fields());
    if (error) return showAlert(error);
    history.replaceState(null, '', `?${queryOf(source.tracks)}`);
    load(source);
  }

  // A source switch: fields, select, toggle and origin panel follow;
  // playback restarts at 0. A preset's own tracks carry its evil mirrors.
  function load(source) {
    const preset = presetFor(source);
    active = { tracks: preset ? preset.tracks : source.tracks, preset };
    setFields(fieldsOf(active.tracks));
    reflectPreset();
    els.toggle.hidden = !active.tracks.some((t) => t.evil);
    els.evilToggle.checked = false;
    renderOrigin(preset);
    void start(false);
  }

  async function start(resume) {
    const gen = ++generation;
    const { tracks } = active;
    const resumeAt = resume && current ? els.video.currentTime : 0;
    const wasPlaying = resume && current !== null && !els.video.paused && !els.video.ended;
    els.evilToggle.disabled = true;
    current?.stop();
    current = null;
    render(null);
    // A stream still opening claims the video element when it resolves; abort
    // its reads and let it finish (superseded, it stops itself) before the
    // next one does.
    openCtl?.abort();
    if (opening) await opening.catch(() => {});
    if (gen !== generation) return;
    openCtl = new AbortController();
    const tampered = els.evilToggle.checked;
    opening = startStream({
      video: els.video,
      tracks: tracks.map((t) => ({ cid: t.cid, sources: tampered && t.evil ? [t.evil, t.src] : [t.src], proof: proofOf(t.src) })),
      VerifiedFile: veritiles.VerifiedFile,
      labels: labelsFor(active),
      onUpdate: (snapshot) => { if (gen === generation) render(snapshot); },
      signal: openCtl.signal,
    });
    let stream;
    try {
      stream = await opening;
    } catch (err) {
      if (gen === generation) showAlert(describe(err, tracks.map((t) => t.src), veritiles));
      return;
    } finally {
      opening = null;
      if (gen === generation) els.evilToggle.disabled = false;
    }
    if (gen !== generation) {
      stream.stop(); // superseded while opening
      return;
    }
    current = stream;
    if (resumeAt > 0) els.video.currentTime = resumeAt;
    if (wasPlaying) els.video.play().catch(() => {});
  }

  function render(snapshot) {
    if (snapshot === null) {
      els.mirrors.replaceChildren();
      els.counters.replaceChildren();
      els.alert.hidden = true;
      shownStreamAlert = null;
      return;
    }
    const { stats, transfers } = snapshot;
    const proofs = new Set(active.tracks.map((t) => proofOf(t.src)));
    const evils = new Set(active.tracks.map((t) => t.evil).filter(Boolean));
    els.mirrors.replaceChildren(...transfers.map((row) => transferRow(row, proofs.has(row.base), evils.has(row.base) && stats.rejected > 0)));
    els.counters.replaceChildren(
      counter('verified ', stats.verified, ' leaves'),
      counter('rejected ', stats.rejected, '', stats.rejected ? 'bad' : ''),
      counter('segment ', snapshot.tracks.map((t) => `${t.segment}/${t.segments}`).join(' + ')),
      counter('buffered ', `${snapshot.aheadSeconds.toFixed(1)} s`, ' ahead'),
      counter('codecs ', snapshot.codecs),
    );
    // A stream's error and rejections are sticky; paint their alert only when
    // it changes, so a later form error stays readable while the previous
    // source plays on. render(null) resets both on restart.
    const alert = snapshot.error ? describe(snapshot.error, active.tracks.map((t) => t.src), veritiles)
      : stats.rejected > 0 ? TAMPER_BANNER : null;
    if (alert !== null && alert !== shownStreamAlert) {
      shownStreamAlert = alert;
      showAlert(alert);
    }
  }

  // The YouTube origin panel: the link, the licence, and the recipe that
  // reproduces the anchors.
  function renderOrigin(preset) {
    const origin = preset?.youtube;
    els.origin.hidden = !origin;
    if (!origin) return;
    els.originLink.href = origin.url;
    els.originLink.textContent = origin.url;
    els.originMeta.textContent = `${origin.channel ?? 'YouTube'} · ${origin.license} · generation ${origin.generation} · ingested ${origin.ingestedAt}`;
    els.recipe.textContent = origin.recipe.join('\n');
  }

  function showAlert(text) {
    els.alert.textContent = text;
    els.alert.hidden = false;
  }
}

// CONFIG carries page-relative paths; a source is always absolute.
function resolvePreset(preset) {
  const abs = (path) => new URL(path, location.href).href;
  return {
    ...preset,
    tracks: preset.tracks.map((t) => ({ ...t, src: abs(t.src), evil: t.evil ? abs(t.evil) : null })),
  };
}

// The repeated cid/src pairs of the query string, as the two fields hold
// them; null when the page was opened without a source.
function readQuery() {
  const params = new URLSearchParams(location.search);
  const cids = params.getAll('cid');
  const srcs = params.getAll('src');
  return cids.length + srcs.length === 0 ? null : { cid: cids.join(' '), src: srcs.join(' ') };
}

export function queryOf(tracks) {
  const params = new URLSearchParams();
  for (const { cid, src } of tracks) {
    params.append('cid', cid);
    params.append('src', src);
  }
  return params.toString();
}

// { source: { tracks } } or { error }: the two fields, one CID and one URL
// per track, checked before any request goes out.
export function parseSource({ cid, src }) {
  const cids = words(cid);
  const srcs = words(src);
  if (cids.length === 0) return { error: '✗ enter the anchor CID' };
  if (cids.length !== srcs.length) {
    return { error: `✗ ${cids.length} anchor CID${plural(cids.length)} but ${srcs.length} URL${plural(srcs.length)} — one of each per track` };
  }
  const tracks = [];
  for (const [i, text] of srcs.entries()) {
    const url = parseHttpUrl(text);
    if (url === null) return { error: '✗ the video URL must be absolute (http:// or https://)' };
    // Checked on the canonical href, where ?/# can only be delimiters: a bare
    // trailing one leaves url.search/url.hash empty yet still corrupts the
    // derived <url>.proofs/ base.
    if (/[?#]/.test(url.href)) {
      return { error: '✗ the video URL must not carry a query string or fragment — proofs are read from <url>.proofs/' };
    }
    tracks.push({ cid: cids[i], src: url.href });
  }
  return { source: { tracks } };
}

function words(text) {
  return text.split(/\s+/).filter((word) => word !== '');
}

function plural(n) {
  return n === 1 ? '' : 's';
}

function parseHttpUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function sameTracks(a, b) {
  return a.length === b.length && a.every((t, i) => t.cid === b[i].cid && t.src === b[i].src);
}

function proofOf(src) {
  return `${src}.proofs`;
}

// Transfer-table names: a preset's tracks are "honest mirror" / "proof
// files" / "malicious mirror", a custom track is named after its host; with
// several tracks each name carries the preset's track label or its number.
function labelsFor({ tracks, preset }) {
  return new Map(tracks.flatMap((t, i) => {
    const name = t.label ?? (tracks.length > 1 ? `track ${i + 1}` : null);
    const prefix = name ? `${name} · ` : '';
    return [
      [t.src, `${prefix}${preset ? 'honest mirror' : new URL(t.src).hostname}`],
      [proofOf(t.src), `${prefix}proof files`],
      ...(t.evil ? [[t.evil, `${prefix}malicious mirror`]] : []),
    ];
  }));
}

// One line for #alert. The library's error classes name the failure; the text
// says what the host must do about it. The client's source loops wrap what
// each source threw in an AggregateError, so a wrong anchor arrives as
// AggregateError[VerificationError('root: digest mismatch')] and a missing
// proof directory as a plain Error('…/root: HTTP 404'). `src` is the track
// URL, or the list of them.
export function describe(err, src, lib) {
  if (err instanceof AggregateError && err.errors.length > 0) return describe(err.errors[0], src, lib);
  const message = err?.message ?? String(err);
  if (err instanceof lib.VerificationError) return `⛔ the bytes at this URL don't verify against the anchor CID — ${message}`;
  if (err instanceof lib.RangeUnsupportedError) return '✗ this host ignores Range requests — it must answer with 206';
  if (err instanceof lib.RangeBlockedError) {
    return '✗ the host refused the cross-origin Range request — it must allow the Range header (Access-Control-Allow-Headers: Range)';
  }
  if (err instanceof lib.NotFoundError || /\bHTTP 404\b/.test(message)) {
    const srcs = [].concat(src);
    const where = srcs.length === 1 ? `${proofOf(srcs[0])}/` : '<url>.proofs/ beside each track';
    return `✗ not found — proofs must sit beside the video at ${where} (${message})`;
  }
  if (err instanceof TypeError) return '✗ the host refused the cross-origin request — it must send Access-Control-Allow-Origin: *';
  return `✗ ${message}`;
}

function transferRow({ base, label, requests, bytes }, isProof, tampered) {
  const row = document.createElement('tr');
  row.append(
    cell(label),
    cell(String(requests), 'num'),
    cell(formatBytes(bytes), 'num'),
    cell(status(isProof, requests, tampered), tampered ? 'bad' : 'ok'),
  );
  return row;
}

function status(isProof, requests, tampered) {
  if (tampered) return 'tampered — banned';
  if (requests === 0) return 'idle';
  return isProof ? 'verified' : 'serving verified bytes';
}

function counter(before, value, after = '', valueClass = '') {
  const b = document.createElement('b');
  b.textContent = String(value);
  if (valueClass) b.className = valueClass;
  const span = document.createElement('span');
  span.append(before, b, after);
  return span;
}

function cell(text, className = '') {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function option(value, text) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = text;
  return el;
}

function formatBytes(bytes) {
  return bytes < 1e5 ? `${(bytes / 1e3).toFixed(1)} kB` : `${(bytes / 1e6).toFixed(1)} MB`;
}
