#!/usr/bin/env node
// Headless integration check: drive Chromium over the DevTools protocol
// against a served dist/, and assert what a viewer would see — playback
// advances on verified bytes, and flipping the malicious-mirror toggle
// surfaces the tamper alert while playback keeps running.
//
//   node scripts/serve.mjs dist &
//   node scripts/browser-check.mjs [url]
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8080/';
const CHROMIUM = process.env.CHROMIUM ?? 'chromium';

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'veritiles-check-'));
  const browser = spawn(CHROMIUM, [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const cdp = await connect(browser);
    const page = await openPage(cdp, url);
    await run(cdp, page);
    console.log('browser check OK');
  } finally {
    browser.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      browser.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function run(cdp, sessionId) {
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

  await evaluate(`document.getElementById('video').play(); 'ok'`);
  const playing = await until('verified playback', (s) => s.time > 1 && /verified [1-9]/.test(s.counters));
  if (/rejected [1-9]/.test(playing.counters) || playing.alert !== '') {
    throw new Error(`honest playback showed rejections: ${JSON.stringify(playing)}`);
  }
  console.log(`honest mirror: playing at ${playing.time.toFixed(1)}s — ${playing.counters}`);

  await evaluate(`document.getElementById('evilToggle').click(); 'ok'`);
  const caught = await until('the tamper alert', (s) => /Tampered/.test(s.alert) && /rejected [1-9]/.test(s.counters));
  console.log(`tampered mirror: ${caught.counters}`);
  const before = (await snapshot()).time;
  const after = await until('playback to continue past the ban', (s) => s.time > before + 1);
  console.log(`failover: playback advanced ${before.toFixed(1)}s → ${after.time.toFixed(1)}s`);

  await evaluate(`document.getElementById('video').currentTime = 300; 'ok'`);
  const sought = await until('playback after seeking to 300s', (s) => s.time > 301 && s.time < 330);
  console.log(`seek: playing at ${sought.time.toFixed(1)}s — ${sought.counters}`);

  // Scrub burst: rapid seeks race the in-flight segment read; a stale read
  // must be aborted, never appended past the new target (else the target
  // segment is skipped and playback stalls in the gap).
  const final = await evaluate(`(async () => {
    const v = document.getElementById('video');
    for (let i = 0; i < 12; i++) {
      v.currentTime = 30 + ((i * 149) % 570);
      await new Promise((r) => setTimeout(r, 15));
    }
    return v.currentTime;
  })()`);
  const scrubbed = await until('playback after a scrub burst', (s) => s.time > final + 0.5 && s.time < final + 30, 10000);
  console.log(`scrub: settled at ${final.toFixed(1)}s, playing at ${scrubbed.time.toFixed(1)}s — ${scrubbed.counters}`);
  if (cdp.pageErrors.length > 0) {
    throw new Error(`page threw:\n${cdp.pageErrors.join('\n')}`);
  }
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
    listeners.get(message.method)?.(message.params);
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

async function openPage(cdp, pageUrl) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
  await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
  await loaded;
  return sessionId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
