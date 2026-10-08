// The multi-track MSE player driven from node: real veritiles VerifiedFiles
// over in-memory hosts, a fake MediaSource that buffers the time span of
// each verified segment, and the test moving the clock — the lifecycle
// scripts/browser-check.mjs checks in Chromium, minus real decoding.
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';

import { VerificationError, VerifiedFile } from 'veritiles';

import { packFixed } from '../scripts/lib/pack-fixed.js';
import { mimeType, parseHead } from '../web/mp4.js';
import { startStream } from '../web/player.js';
import { fakeMse } from './lib/fake-mse.js';
import { memFetch, syntheticTrack, tampered } from './lib/track-fixture.js';

function fixture(name, options) {
  const { bytes, codecs } = syntheticTrack(options);
  const { anchor, proofs } = packFixed(bytes);
  const url = `https://cdn.example/${name}.mp4`;
  return { name, url, bytes, anchor, proofs, mime: mimeType(codecs), segments: parseHead(bytes).index.segments };
}

// 40 s of video, 28 s of audio: from t=0 the 30 s read-ahead drains the
// audio but not the video. Both span several 1 MiB leaves, so a later leaf
// can be tampered behind an honest head.
const video = fixture('video', { kind: 'video', segments: 8, segmentSize: 300_000, segmentSeconds: 5, seed: 2 });
const audio = fixture('audio', { kind: 'audio', segments: 7, segmentSize: 200_000, segmentSeconds: 4, seed: 3 });
const fixtures = [video, audio];
const EVIL = 'https://evil.example/video.mp4';

// Names an append after the fixture bytes it equals (`video:init`,
// `audio:3`); anything else — tampered bytes — is `video:?`.
function describe(mime, bytes) {
  const track = fixtures.find((f) => f.mime === mime);
  const equals = (offset) => Buffer.compare(bytes, track.bytes.subarray(offset, offset + bytes.length)) === 0;
  if (equals(0)) return { label: `${track.name}:init` };
  const i = track.segments.findIndex((s) => s.size === bytes.length && equals(s.offset));
  if (i < 0) return { label: `${track.name}:?` };
  const { time, duration } = track.segments[i];
  return { label: `${track.name}:${i}`, start: time, end: time + duration };
}

// What the player appended for one track, in order: 'init', '0', '1', …
const appended = (env, { name }) => env.log.filter((e) => e.startsWith(`${name}:`)).map((e) => e.slice(name.length + 1));
const upTo = (last) => ['init', ...Array.from({ length: last + 1 }, (_, i) => String(i))];
const listeners = (target, ...types) => types.reduce((n, type) => n + getEventListeners(target, type).length, 0);
const spec = (f, overrides) => ({ cid: f.anchor, sources: [f.url], proof: `${f.url}.proofs`, ...overrides });

function host(files = new Map(fixtures.map((f) => [f.url, f.bytes]))) {
  return memFetch({ files, proofs: new Map(fixtures.map((f) => [`${f.url}.proofs`, f.proofs])) });
}

// The fake MSE, `fetchFn` as the global fetch the player's transfer counter
// calls, and a VerifiedFile that records each read it is asked for.
function install(t, fetchFn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const env = fakeMse(describe);
  t.after(() => {
    env.restore();
    globalThis.fetch = realFetch;
  });
  const reads = [];
  class SpyFile extends VerifiedFile {
    read(offset, length, options) {
      const read = { cid: this.cid, offset, signal: options?.signal, done: false };
      reads.push(read);
      return super.read(offset, length, options).finally(() => { read.done = true; });
    }
  }
  return { ...env, reads, VerifiedFile: SpyFile };
}

// Until no read (hashing included) or append is in flight.
async function settle(env) {
  for (let idle = 0, polls = 0; idle < 3; polls += 1) {
    if (polls === 5000) throw new Error('the player never went idle');
    await new Promise((resolve) => setTimeout(resolve, 1));
    idle = env.reads.every((r) => r.done) && !env.updating() ? idle + 1 : 0;
  }
}

async function play(t, { tracks = fixtures.map((f) => spec(f)), fetchFn = host() } = {}) {
  const env = install(t, fetchFn);
  const element = env.video();
  const updates = [];
  const stream = await startStream({ video: element, tracks, VerifiedFile: env.VerifiedFile, onUpdate: (s) => updates.push(s) });
  t.after(() => stream.stop());
  await settle(env);
  return { env, element, stream, updates };
}

function advance(element, seconds, event = 'timeupdate') {
  element.currentTime = seconds;
  element.dispatchEvent(new Event(event));
}

test('plays a video and an audio track to the end, every segment once and in order', async (t) => {
  const { env, element, stream } = await play(t);
  assert.equal(stream.snapshot().duration, 40);
  assert.deepEqual(appended(env, video), upTo(5), 'video stops 30 s ahead');
  assert.deepEqual(appended(env, audio), upTo(6), 'all 28 s of audio');
  assert.ok(!env.log.includes('end'), 'a drained audio track alone does not end the stream');

  advance(element, 20);
  await settle(env);
  assert.deepEqual(appended(env, video), upTo(7));
  assert.deepEqual(env.log.filter((e) => e === 'end'), ['end']);
  assert.equal(env.log.at(-1), 'end');
  assert.equal(stream.snapshot().error, null);
});

test('a head failure rejects with it and cuts the other track\'s head read short', async (t) => {
  const serve = host();
  const neverAnswers = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const env = install(t, (input, init) => (String(input) === audio.url ? neverAnswers(init.signal) : serve(input, init)));
  const element = env.video();
  const otherFile = packFixed(new Uint8Array(1)).anchor;
  const tracks = [spec(video, { cid: otherFile }), spec(audio)];
  await assert.rejects(
    startStream({ video: element, tracks, VerifiedFile: env.VerifiedFile }),
    (err) => err.errors.some((e) => e instanceof VerificationError),
  );
  assert.ok(env.reads.find((r) => r.cid === audio.anchor).signal.aborted);
  await settle(env); // the stuck audio read settles
  assert.equal(env.attached.size, 0, 'no MediaSource was attached');
  assert.equal(element.src, '');
  assert.equal(listeners(element, 'timeupdate', 'seeking'), 0);
});

test('aborting the open signal hands the element back clean', async (t) => {
  const env = install(t, host());
  const element = env.video({ attach: false }); // sourceopen never fires
  const ctl = new AbortController();
  const opening = startStream({ video: element, tracks: fixtures.map((f) => spec(f)), VerifiedFile: env.VerifiedFile, signal: ctl.signal });
  await settle(env);
  assert.equal(element.src, 'blob:fake/0');
  ctl.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.deepEqual(env.revoked, ['blob:fake/0']);
  assert.equal(element.src, '');
  assert.equal(element.loads, 1);
});

test('seeking moves every track to the segment covering the new time', async (t) => {
  const { env, element, stream } = await play(t);
  advance(element, 5); // video starts reading segment 6 …
  const superseded = env.reads.at(-1);
  advance(element, 36, 'seeking'); // … which the seek cuts short
  await settle(env);
  assert.equal(superseded.offset, video.segments[6].offset);
  assert.ok(superseded.signal.aborted);
  assert.deepEqual(appended(env, video), [...upTo(5), '7']);
  assert.deepEqual(appended(env, audio), [...upTo(6), '6'], 'past the audio end, its last segment covers');
  assert.equal(env.log.at(-1), 'end');
  assert.equal(stream.snapshot().error, null, 'a read cut short by a seek is no failure');
});

test('stop mid-play aborts the reads, removes the listeners and hands the element back', async (t) => {
  const { env, element, stream, updates } = await play(t);
  assert.equal(listeners(element, 'timeupdate', 'seeking'), 2);
  advance(element, 10); // video starts reading segment 6
  const inFlight = env.reads.at(-1);
  const before = { log: env.log.length, updates: updates.length };
  stream.stop();
  await settle(env);
  assert.ok(inFlight.signal.aborted);
  assert.equal(env.log.length, before.log, 'no append after stop');
  assert.equal(updates.length, before.updates, 'no report after stop');
  assert.deepEqual(env.revoked, ['blob:fake/0']);
  assert.equal(element.src, '');
  assert.equal(element.loads, 1);
  assert.equal(listeners(element, 'timeupdate', 'seeking'), 0);
  for (const sb of env.buffers) assert.equal(listeners(sb, 'updateend', 'error'), 0);
});

test('a tampered leaf mid-track fails closed: the error surfaces and no track appends again', async (t) => {
  const evil = new Uint8Array(audio.bytes);
  evil[evil.length - 1] ^= 0xff; // the second, last leaf: segments 5 and 6
  const { env, element, updates } = await play(t, { fetchFn: host(new Map([[video.url, video.bytes], [audio.url, evil]])) });
  const { error, stats } = updates.at(-1);
  assert.ok(error.errors.some((e) => e instanceof VerificationError));
  assert.ok(stats.rejected >= 1);
  assert.deepEqual(appended(env, audio), upTo(4));

  const before = [...env.log];
  advance(element, 10); // video would read on, audio retry segment 5
  await settle(env);
  assert.deepEqual(env.log, before);
  assert.ok(!env.log.includes('end'));
});

test('a tampered first source is banned and the next one plays the track through', async (t) => {
  const files = new Map([[EVIL, tampered(video.bytes)], [video.url, video.bytes], [audio.url, audio.bytes]]);
  const tracks = [spec(video, { sources: [EVIL, video.url] }), spec(audio)];
  const { env, element, stream } = await play(t, { tracks, fetchFn: host(files) });
  const evilRequests = () => stream.snapshot().transfers.find((row) => row.base === EVIL).requests;
  const caught = evilRequests();
  assert.ok(caught >= 1);

  advance(element, 20);
  await settle(env);
  assert.deepEqual(appended(env, video), upTo(7), 'only verified bytes reach the decoder');
  assert.equal(env.log.at(-1), 'end');
  assert.equal(evilRequests(), caught, 'never asked again');
  const { stats, error } = stream.snapshot();
  assert.ok(stats.rejected >= 1);
  assert.equal(error, null);
});
