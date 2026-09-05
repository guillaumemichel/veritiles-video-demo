// Page controller. A source is (anchor CID, video URL): one of the built-in
// presets or anything pasted into the form, kept in the query string so every
// source is a shareable link. Wires the form, the tamper toggle, the transfer
// table, the counters and the alert around startStream. Strings that can come
// from the user or a host only ever reach the DOM through textContent.

const CUSTOM = 'custom';
const IDS = ['video', 'source', 'preset', 'cid', 'src', 'toggle', 'evilToggle', 'mirrors', 'counters', 'alert'];
const TAMPER_BANNER = '⛔ Tampered bytes caught and rejected — the malicious mirror is banned for this '
  + 'session, and playback continues from the honest one. Not one altered byte was rendered.';

// { config: { presets }, veritiles: the library namespace, startStream }
export function boot({ config, veritiles, startStream }) {
  const els = Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)]));
  const presets = (config.presets ?? []).map(resolvePreset);
  let active = null; // { cid, src, preset? } — what playback runs on
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
    load({ cid: presets[0].cid, src: presets[0].src });
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

  function presetFor({ cid, src }) {
    return presets.find((p) => p.cid === cid && p.src === src);
  }

  function reflectPreset() {
    els.preset.value = presetFor(fields())?.id ?? CUSTOM;
  }

  function onPresetChange() {
    const preset = presets.find((p) => p.id === els.preset.value);
    if (!preset) return els.cid.focus();
    setFields(preset);
    applyFields();
  }

  function applyFields() {
    const { source, error } = parseSource(fields());
    if (error) return showAlert(error);
    history.replaceState(null, '', `?${new URLSearchParams(source)}`);
    load(source);
  }

  // A source switch: fields, select and toggle follow; playback restarts at 0.
  function load(source) {
    active = { ...source, preset: presetFor(source) };
    setFields(source);
    reflectPreset();
    els.toggle.hidden = !active.preset?.evil;
    els.evilToggle.checked = false;
    void start(false);
  }

  async function start(resume) {
    const gen = ++generation;
    const { cid, src, preset } = active;
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
    opening = startStream({
      video: els.video,
      cid,
      sources: els.evilToggle.checked && preset?.evil ? [preset.evil, src] : [src],
      proof: proofOf(src),
      VerifiedFile: veritiles.VerifiedFile,
      labels: labelsFor(active),
      onUpdate: (snapshot) => { if (gen === generation) render(snapshot); },
      signal: openCtl.signal,
    });
    let stream;
    try {
      stream = await opening;
    } catch (err) {
      if (gen === generation) showAlert(describe(err, src, veritiles));
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
    const proof = proofOf(active.src);
    const evil = active.preset?.evil;
    els.mirrors.replaceChildren(...transfers.map((row) => transferRow(row, proof, row.base === evil && stats.rejected > 0)));
    els.counters.replaceChildren(
      counter('verified ', stats.verified, ' leaves'),
      counter('rejected ', stats.rejected, '', stats.rejected ? 'bad' : ''),
      counter('segment ', `${snapshot.segment}/${snapshot.segments}`),
      counter('buffered ', `${snapshot.aheadSeconds.toFixed(1)} s`, ' ahead'),
      counter('codecs ', snapshot.codecs),
    );
    // A stream's error and rejections are sticky; paint their alert only when
    // it changes, so a later form error stays readable while the previous
    // source plays on. render(null) resets both on restart.
    const alert = snapshot.error ? describe(snapshot.error, active.src, veritiles)
      : stats.rejected > 0 ? TAMPER_BANNER : null;
    if (alert !== null && alert !== shownStreamAlert) {
      shownStreamAlert = alert;
      showAlert(alert);
    }
  }

  function showAlert(text) {
    els.alert.textContent = text;
    els.alert.hidden = false;
  }
}

// CONFIG carries page-relative paths; a source is always absolute.
function resolvePreset(preset) {
  const abs = (path) => new URL(path, location.href).href;
  return { ...preset, src: abs(preset.src), evil: preset.evil ? abs(preset.evil) : null };
}

function readQuery() {
  const params = new URLSearchParams(location.search);
  const cid = params.get('cid');
  const src = params.get('src');
  return cid !== null && src !== null ? { cid, src } : null;
}

// { source } or { error }: the two fields, checked before any request goes out.
export function parseSource({ cid, src }) {
  if (cid === '') return { error: '✗ enter the anchor CID' };
  const url = parseHttpUrl(src);
  if (url === null) return { error: '✗ the video URL must be absolute (http:// or https://)' };
  // Checked on the canonical href, where ?/# can only be delimiters: a bare
  // trailing one leaves url.search/url.hash empty yet still corrupts the
  // derived <url>.proofs/ base.
  if (/[?#]/.test(url.href)) {
    return { error: '✗ the video URL must not carry a query string or fragment — proofs are read from <url>.proofs/' };
  }
  return { source: { cid, src: url.href } };
}

function parseHttpUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function proofOf(src) {
  return `${src}.proofs`;
}

function labelsFor({ src, preset }) {
  return new Map([
    [src, preset ? 'honest mirror' : new URL(src).hostname],
    [proofOf(src), 'proof files'],
    ...(preset?.evil ? [[preset.evil, 'malicious mirror']] : []),
  ]);
}

// One line for #alert. The library's error classes name the failure; the text
// says what the host must do about it. The client's source loops wrap what
// each source threw in an AggregateError, so a wrong anchor arrives as
// AggregateError[VerificationError('root: digest mismatch')] and a missing
// proof directory as a plain Error('…/root: HTTP 404').
export function describe(err, src, lib) {
  if (err instanceof AggregateError && err.errors.length > 0) return describe(err.errors[0], src, lib);
  const message = err?.message ?? String(err);
  if (err instanceof lib.VerificationError) return `⛔ the bytes at this URL don't verify against the anchor CID — ${message}`;
  if (err instanceof lib.RangeUnsupportedError) return '✗ this host ignores Range requests — it must answer with 206';
  if (err instanceof lib.RangeBlockedError) {
    return '✗ the host refused the cross-origin Range request — it must allow the Range header (Access-Control-Allow-Headers: Range)';
  }
  if (err instanceof lib.NotFoundError || /\bHTTP 404\b/.test(message)) {
    return `✗ not found — proofs must sit beside the video at ${proofOf(src)}/ (${message})`;
  }
  if (err instanceof TypeError) return '✗ the host refused the cross-origin request — it must send Access-Control-Allow-Origin: *';
  return `✗ ${message}`;
}

function transferRow({ base, label, requests, bytes }, proof, tampered) {
  const row = document.createElement('tr');
  row.append(
    cell(label),
    cell(String(requests), 'num'),
    cell(formatBytes(bytes), 'num'),
    cell(status(base === proof, requests, tampered), tampered ? 'bad' : 'ok'),
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
