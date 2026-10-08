#!/usr/bin/env node
// Headless integration check: drive Chromium over the DevTools protocol
// against a served dist/, and assert what a viewer would see — playback
// advances on verified bytes, flipping the malicious-mirror toggle surfaces
// the tamper alert while playback keeps running, a custom cross-origin
// source plays whether it arrives by query string or through the form, a
// wrong anchor fails loudly without playing a frame, a preset picked while
// another source is still opening wins the hand-off cleanly, the select
// follows hand-edited fields without loading anything, a video + audio
// track pair (the YouTube itag shape, served from a second origin) plays
// through two SourceBuffers, and a YouTube preset, when the build has one,
// survives a tampered track.
//
//   node scripts/serve.mjs dist &
//   node scripts/browser-check.mjs [url]
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureSplitFixture } from './lib/split-fixture.js';
import { serve } from './serve.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:8080/';
const CHROMIUM = process.env.CHROMIUM ?? 'chromium';
const CODECS = 'avc1.640029, mp4a.40.2';
const VERIFY_FAILED = "⛔ the bytes at this URL don't verify against the anchor CID";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'veritiles-check-'));
  const fixture = await ensureSplitFixture(join(repoRoot, 'data'));
  const fixtureServer = await serve(fixture.dir);
  const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}/`;
  const pair = fixture.tracks.map((t) => ({ cid: t.cid, src: new URL(t.file, fixtureBase).href }));
  const browser = spawn(CHROMIUM, [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const cdp = await connect(browser);
    const anchor = await checkDefaultPreset(cdp);
    // Same server, other origin: the loopback host under its other name.
    const src = new URL('bbb.mp4', altOrigin(url)).href;
    await checkCustomSource(cdp, anchor, src);
    await checkWrongAnchor(cdp, anchor, src);
    await checkFormPath(cdp, anchor, src);
    await checkOpeningHandOff(cdp, anchor, src);
    await checkSelectFollowsFields(cdp);
    await checkTrackPair(cdp, pair);
    await checkTrackPairWrongAnchor(cdp, pair);
    await checkYoutubePreset(cdp);
    console.log('browser check OK');
  } finally {
    browser.kill();
    fixtureServer.close();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      browser.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// The built-in preset: honest playback, tamper failover, a seek and a scrub
// burst. Returns the anchor CID the page shows.
async function checkDefaultPreset(cdp) {
  const page = await openPage(cdp, url);
  await page.evaluate(`document.getElementById('video').play(); 'ok'`);
  const playing = await page.until('verified playback', (s) => s.time > 1 && /verified [1-9]/.test(s.counters));
  if (/rejected [1-9]/.test(playing.counters) || playing.alert !== '') {
    throw new Error(`honest playback showed rejections: ${JSON.stringify(playing)}`);
  }
  expect(playing.search === '' && !playing.toggleHidden, 'the default preset should leave the URL alone and offer the toggle', playing);
  expect(playing.originHidden, 'a local preset has no YouTube origin panel', playing);
  console.log(`honest mirror: playing at ${playing.time.toFixed(1)}s — ${playing.counters}`);

  await page.evaluate(`document.getElementById('evilToggle').click(); 'ok'`);
  const caught = await page.until('the tamper alert', (s) => /Tampered/.test(s.alert) && /rejected [1-9]/.test(s.counters));
  console.log(`tampered mirror: ${caught.counters}`);
  const before = (await page.snapshot()).time;
  const after = await page.until('playback to continue past the ban', (s) => s.time > before + 1);
  console.log(`failover: playback advanced ${before.toFixed(1)}s → ${after.time.toFixed(1)}s`);

  await seekAndScrub(page);
  expectNoPageErrors(cdp);
  const anchor = await page.evaluate(`document.getElementById('cid').value`);
  await page.close();
  return anchor;
}

// A seek, then a scrub burst: rapid seeks race the in-flight segment read; a
// stale read must be aborted, never appended past the new target (else the
// target segment is skipped and playback stalls in the gap).
async function seekAndScrub(page) {
  await page.evaluate(`document.getElementById('video').currentTime = 300; 'ok'`);
  const sought = await page.until('playback after seeking to 300s', (s) => s.time > 301 && s.time < 330);
  console.log(`seek: playing at ${sought.time.toFixed(1)}s — ${sought.counters}`);

  const final = await page.evaluate(`(async () => {
    const v = document.getElementById('video');
    for (let i = 0; i < 12; i++) {
      v.currentTime = 30 + ((i * 149) % 570);
      await new Promise((r) => setTimeout(r, 15));
    }
    return v.currentTime;
  })()`);
  const scrubbed = await page.until('playback after a scrub burst', (s) => s.time > final + 0.5 && s.time < final + 30, 10000);
  console.log(`scrub: settled at ${final.toFixed(1)}s, playing at ${scrubbed.time.toFixed(1)}s — ${scrubbed.counters}`);
}

// ?cid&src pointing at the other origin: verified playback, no tamper
// toggle, the host named in the transfer table, codecs read off the moov.
async function checkCustomSource(cdp, anchor, src) {
  const page = await openPage(cdp, sourceUrl([{ cid: anchor, src }]));
  await page.evaluate(`document.getElementById('video').play(); 'ok'`);
  const playing = await page.until('verified cross-origin playback', (s) => s.time > 1 && /verified [1-9]/.test(s.counters));
  expect(!/rejected [1-9]/.test(playing.counters) && playing.alert === '', 'cross-origin playback showed rejections', playing);
  expect(playing.toggleHidden && playing.preset === 'custom', 'a custom source should hide the tamper toggle', playing);
  expect(playing.mirrors.includes(new URL(src).hostname), 'the transfer table should name the video host', playing);
  expect(playing.counters.includes(`codecs ${CODECS}`), `the counters should show codecs ${CODECS}`, playing);
  console.log(`custom source: playing ${src} at ${playing.time.toFixed(1)}s — ${playing.counters}`);
  expectNoPageErrors(cdp);
  await page.close();
}

// A CID that decodes but names other bytes: the alert says so, nothing plays.
async function checkWrongAnchor(cdp, anchor, src) {
  const page = await openPage(cdp, sourceUrl([{ cid: corruptAnchor(anchor), src }]));
  const failed = await page.until('the verification failure', (s) => s.alert.startsWith(VERIFY_FAILED));
  expect(failed.time === 0 && failed.counters === '', 'a wrong anchor must not play', failed);
  console.log(`wrong anchor: ${failed.alert}`);
  expectNoPageErrors(cdp);
  await page.close();
}

// The form on the default page: pick custom…, fill both fields, Load. The
// query string follows and the new source plays.
async function checkFormPath(cdp, anchor, src) {
  const page = await openPage(cdp, url);
  await page.evaluate(`(() => {
    const preset = document.getElementById('preset');
    preset.value = 'custom';
    preset.dispatchEvent(new Event('change'));
    document.getElementById('cid').value = ${JSON.stringify(anchor)};
    document.getElementById('src').value = ${JSON.stringify(src)};
    document.getElementById('load').click();
    return 'ok';
  })()`);
  const host = new URL(src).hostname;
  await page.until('the form source to open', (s) => s.counters !== '' && s.mirrors.includes(host));
  // play() only once the new stream owns the element: a play pending across
  // the preset stream's teardown would be cancelled with it.
  await page.evaluate(`document.getElementById('video').play(); 'ok'`);
  const playing = await page.until('playback from the form', (s) => s.time > 1 && /verified [1-9]/.test(s.counters));
  const params = new URLSearchParams(playing.search);
  expect(params.get('cid') === anchor && params.get('src') === src, 'the query string should carry the form source', playing);
  expect(playing.preset === 'custom' && playing.toggleHidden && playing.alert === '', 'the page should show a clean custom source', playing);
  console.log(`form: ${playing.search} playing at ${playing.time.toFixed(1)}s — ${playing.counters}`);
  expectNoPageErrors(cdp);
  await page.close();
}

// A preset picked while the form source is still opening: loading the form
// source and switching back to the preset in the same task guarantees the
// second start() finds an in-flight open to supersede; the preset must own
// the page once the dust settles.
async function checkOpeningHandOff(cdp, anchor, src) {
  const page = await openPage(cdp, url);
  await page.evaluate(`(() => {
    const preset = document.getElementById('preset');
    preset.value = 'custom';
    preset.dispatchEvent(new Event('change'));
    document.getElementById('cid').value = ${JSON.stringify(anchor)};
    document.getElementById('src').value = ${JSON.stringify(src)};
    document.getElementById('load').click();
    preset.value = 'bbb';
    preset.dispatchEvent(new Event('change'));
    return 'ok';
  })()`);
  await page.until('the preset to win the hand-off', (s) => s.counters !== '' && s.mirrors.includes('honest mirror'));
  await page.evaluate(`document.getElementById('video').play(); 'ok'`);
  const playing = await page.until('playback after the hand-off', (s) => s.time > 1 && /verified [1-9]/.test(s.counters));
  expect(playing.preset === 'bbb' && !playing.toggleHidden && playing.alert === '', 'the preset should own the page after the hand-off', playing);
  expect(JSON.stringify(playing.mirrors) === JSON.stringify(['honest mirror', 'proof files']), 'only the preset sources should be listed', playing);
  console.log(`hand-off: preset wins, playing at ${playing.time.toFixed(1)}s — ${playing.counters}`);
  expectNoPageErrors(cdp);
  await page.close();
}

// Hand-editing a field flips the select to custom… without loading anything;
// restoring the preset's exact value flips it back.
async function checkSelectFollowsFields(cdp) {
  const page = await openPage(cdp, url);
  const state = await page.evaluate(`(() => {
    const cid = document.getElementById('cid');
    const preset = document.getElementById('preset');
    cid.value += 'x';
    cid.dispatchEvent(new Event('input'));
    const edited = { preset: preset.value, search: location.search };
    cid.value = cid.value.slice(0, -1);
    cid.dispatchEvent(new Event('input'));
    return { edited, restored: preset.value };
  })()`);
  expect(state.edited.preset === 'custom' && state.edited.search === '', 'an edited CID should flip the select to custom without loading', state);
  expect(state.restored === 'bbb', 'restoring the CID should flip the select back to the preset', state);
  console.log(`select: edited CID flips to custom and back to ${state.restored}`);
  expectNoPageErrors(cdp);
  await page.close();
}

// A video-only + audio-only track pair from a second origin, by repeated
// cid/src query pairs: verified playback through two SourceBuffers, both
// tracks in the transfer table and the counters, a seek and a scrub burst.
async function checkTrackPair(cdp, pair) {
  const page = await openPage(cdp, sourceUrl(pair));
  await page.evaluate(`document.getElementById('video').play(); 'ok'`);
  const playing = await page.until('dual-track playback', (s) => s.time > 1 && /verified [1-9]/.test(s.counters));
  expect(!/rejected [1-9]/.test(playing.counters) && playing.alert === '', 'dual-track playback showed rejections', playing);
  expect(playing.counters.includes(`codecs ${CODECS}`) && /segment \d+\/\d+ \+ \d+\/\d+/.test(playing.counters), 'the counters should show both tracks', playing);
  const host = new URL(pair[0].src).hostname;
  expect(['track 1 · ' + host, 'track 1 · proof files', 'track 2 · ' + host, 'track 2 · proof files'].every((l) => playing.mirrors.includes(l)), 'both tracks should be listed', playing);
  expect(playing.preset === 'custom' && playing.toggleHidden, 'a custom track pair has no tamper toggle', playing);
  const fieldCids = await page.evaluate(`document.getElementById('cid').value`);
  expect(fieldCids === pair.map((t) => t.cid).join(' '), 'the CID field should list both anchors', { fieldCids });
  console.log(`track pair: playing at ${playing.time.toFixed(1)}s — ${playing.counters}`);
  await seekAndScrub(page);
  expectNoPageErrors(cdp);
  await page.close();
}

// A wrong anchor on the audio track alone: the pair fails closed.
async function checkTrackPairWrongAnchor(cdp, pair) {
  const [video, audio] = pair;
  const page = await openPage(cdp, sourceUrl([video, { ...audio, cid: corruptAnchor(audio.cid) }]));
  const failed = await page.until('the verification failure', (s) => s.alert.startsWith(VERIFY_FAILED));
  expect(failed.time === 0 && failed.counters === '', 'a wrong anchor on one track must not play', failed);
  console.log(`track pair, wrong audio anchor: ${failed.alert}`);
  expectNoPageErrors(cdp);
  await page.close();
}

// A YouTube preset, when the build has one (after yt-ingest): the origin
// panel shows, honest playback runs, and the tamper toggle routes the evil
// track through its malicious mirror — caught, banned, playback continues.
async function checkYoutubePreset(cdp) {
  const page = await openPage(cdp, url);
  const ids = await page.evaluate(`[...document.getElementById('preset').options].map((o) => o.value).filter((v) => v.startsWith('yt-'))`);
  if (ids.length === 0) {
    console.log('youtube preset: none in this build — tamper failover on separate tracks not exercised (run yt-ingest)');
    await page.close();
    return;
  }
  await page.evaluate(`(() => {
    const preset = document.getElementById('preset');
    preset.value = ${JSON.stringify(ids[0])};
    preset.dispatchEvent(new Event('change'));
    return 'ok';
  })()`);
  await page.until('the youtube preset to open', (s) => s.preset === ids[0] && s.counters !== '');
  await page.evaluate(`document.getElementById('video').play(); 'ok'`);
  const playing = await page.until('youtube preset playback', (s) => s.time > 1 && /verified [1-9]/.test(s.counters));
  expect(!playing.originHidden && !playing.toggleHidden, 'the youtube preset should show its origin panel and the toggle', playing);
  expect(!/rejected [1-9]/.test(playing.counters) && playing.alert === '', 'youtube preset playback showed rejections', playing);
  console.log(`youtube preset ${ids[0]}: playing at ${playing.time.toFixed(1)}s — ${playing.counters}`);

  await page.evaluate(`document.getElementById('evilToggle').click(); 'ok'`);
  const caught = await page.until('the tamper alert on a track', (s) => /Tampered/.test(s.alert) && /rejected [1-9]/.test(s.counters));
  const before = caught.time;
  const after = await page.until('playback to continue past the track ban', (s) => s.time > before + 1);
  console.log(`youtube preset tampered track: ${caught.counters}; playback ${before.toFixed(1)}s → ${after.time.toFixed(1)}s`);
  expectNoPageErrors(cdp);
  await page.close();
}

function sourceUrl(tracks) {
  const page = new URL(url);
  const params = new URLSearchParams();
  for (const { cid, src } of tracks) {
    params.append('cid', cid);
    params.append('src', src);
  }
  page.search = params.toString();
  return page.href;
}

function altOrigin(base) {
  const alt = new URL(base);
  alt.hostname = alt.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
  return alt.href;
}

// Another last character that keeps the CID's padding bits zero, so it
// still decodes and the failure is the fetched root not matching it.
function corruptAnchor(anchor) {
  return anchor.slice(0, -1) + (anchor.endsWith('a') ? 'e' : 'a');
}

function expect(ok, message, state) {
  if (!ok) throw new Error(`${message}: ${JSON.stringify(state)}`);
}

function expectNoPageErrors(cdp) {
  if (cdp.pageErrors.length > 0) throw new Error(`page threw:\n${cdp.pageErrors.join('\n')}`);
}

// -- minimal flat-session CDP client over node's built-in WebSocket ---------

async function connect(browser) {
  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    browser.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) resolve(match[1]);
    });
    browser.on('exit', () => reject(new Error(`chromium exited before DevTools came up:\n${stderr}`)));
  });
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('could not connect to DevTools'));
  });
  const pending = new Map();
  const listeners = new Map();
  const pageErrors = [];
  let nextId = 1;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== undefined) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.data ?? ''})`));
      else resolve(message.result);
      return;
    }
    listeners.get(message.method)?.(message.params, message.sessionId);
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  };
  return {
    pageErrors,
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    }),
    on: (method, handler) => listeners.set(method, handler),
  };
}

// A fresh tab navigated to pageUrl, with the page helpers bound to it.
async function openPage(cdp, pageUrl) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', (_, from) => { if (from === sessionId) resolve(); }));
  await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
  await loaded;
  return pageHelpers(cdp, sessionId, targetId);
}

function pageHelpers(cdp, sessionId, targetId) {
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (exceptionDetails) throw new Error(`page evaluation failed: ${exceptionDetails.text} ${result?.description ?? ''}`);
    return result.value;
  };
  const snapshot = () => evaluate(`({
    time: document.getElementById('video').currentTime,
    counters: document.getElementById('counters').textContent.replace(/\\s+/g, ' ').trim(),
    alert: document.getElementById('alert').hidden ? '' : document.getElementById('alert').textContent,
    mirrors: [...document.querySelectorAll('#mirrors tr')].map((tr) => tr.cells[0].textContent),
    toggleHidden: document.getElementById('toggle').hidden,
    originHidden: document.getElementById('origin').hidden,
    preset: document.getElementById('preset').value,
    search: location.search,
  })`);
  const until = async (label, predicate, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await snapshot();
      if (predicate(state)) return state;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(await snapshot())}`);
  };
  const close = () => cdp.send('Target.closeTarget', { targetId });
  return { evaluate, snapshot, until, close };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
