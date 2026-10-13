// The watchtower machinery against an in-memory "YouTube": honest bytes
// match, tampered bytes are a mismatch, a missing delivery is unavailable,
// probes land on distinct mid-file MiB and verify the whole leaf covering
// each, and no signed delivery URL — nor the IP it is bound to — reaches
// the terminal.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mp4Leaves, packMp4 } from '../scripts/lib/pack-mp4.js';
import { MiB, probeLeaf, probeOffsets, probeTrack, rootMessage } from '../scripts/lib/watchtower.js';
import { memFetch, seededRandom, syntheticTrack, tampered } from './lib/track-fixture.js';

// Signed like a real delivery: bound to the resolving IP (a documentation address).
const SOURCE = 'https://rr1---sn-test.googlevideo.example/videoplayback?itag=137&expire=1&ip=203.0.113.7&sig=x';
const PROOF = 'https://site.example/yt/v/itag137.mp4.proofs';

const track = syntheticTrack({ segments: 5, seed: 3 }); // an init leaf, then 5 fragments of just under a MiB
const packed = await packMp4(track.bytes);
const proofs = new Map([[PROOF, packed.proofs]]);
const settings = (bytes) => ({
  cid: packed.anchor,
  source: SOURCE,
  proof: PROOF,
  fetchFn: memFetch({ files: bytes ? new Map([[SOURCE, bytes]]) : new Map(), proofs }),
});

test('probe offsets are distinct, MiB-aligned and mid-file', () => {
  const offsets = probeOffsets(10 * MiB + 5, 3, seededRandom(1));
  assert.equal(offsets.length, 3);
  assert.deepEqual(offsets, [...new Set(offsets)].sort((a, b) => a - b));
  for (const offset of offsets) {
    assert.equal(offset % MiB, 0);
    assert.ok(offset >= MiB && offset <= 9 * MiB, `offset ${offset} outside the mid-file MiB`);
  }
  assert.deepEqual(probeOffsets(MiB - 1, 3), [0], 'a file within one MiB has only its head to probe');
  assert.equal(probeOffsets(4 * MiB, 3).length, 2, 'k clamps to the mid-file MiB available');
});

test('honest bytes match on every probe, with each proof file fetched once', async () => {
  let proofFetches = 0;
  const inner = settings(track.bytes).fetchFn;
  const fetchFn = (input, init) => { if (String(input).startsWith(PROOF)) proofFetches += 1; return inner(input, init); };
  const { size, probes } = await probeTrack({ ...settings(track.bytes), fetchFn, k: 3, random: seededRandom(5) });
  assert.equal(size, track.size);
  assert.equal(probes.length, 3);
  for (const probe of probes) assert.equal(probe.result, 'match');
  assert.equal(proofFetches, packed.proofs.size, 'root and the shard, once each');
});

test('tampered bytes are a mismatch on every probe, each judged on its own', async () => {
  const { probes } = await probeTrack({ ...settings(tampered(track.bytes)), k: 3, random: seededRandom(5) });
  assert.deepEqual(probes.map((p) => p.result), ['mismatch', 'mismatch', 'mismatch']);
  assert.match(probes[0].detail, /digest mismatch/);
});

test('a probe verifies the whole leaf covering its offset, and only that leaf', async () => {
  const fragment = (offset) => mp4Leaves(track.bytes).find((leaf) => leaf.offset <= offset && offset < leaf.offset + leaf.length);
  const probed = fragment(2 * MiB);
  const flipped = (at) => { const bytes = new Uint8Array(track.bytes); bytes[at] ^= 0xff; return bytes; };
  const far = await probeLeaf({ ...settings(flipped(probed.offset + probed.length - 1)), offset: 2 * MiB });
  assert.equal(far.result, 'mismatch', 'a flipped byte far from the offset, in the same fragment');
  const next = await probeLeaf({ ...settings(flipped(probed.offset + probed.length)), offset: 2 * MiB });
  assert.equal(next.result, 'match', 'a flipped byte in the next fragment is not this probe\'s');
});

test('a delivery that answers 404 is unavailable, not a mismatch', async () => {
  const probe = await probeLeaf({ ...settings(null), offset: MiB });
  assert.equal(probe.result, 'unavailable');
  assert.equal(probe.detail, '<signed URL>: HTTP 404', 'the signed URL never leaves the probe');
});

test('error messages lose any signed URL, and with it the IP it is bound to', () => {
  const signed = new Error(`${SOURCE}: HTTP 403`);
  assert.equal(rootMessage(signed), '<signed URL>: HTTP 403');
  assert.equal(rootMessage(new AggregateError([signed], 'all sources failed')), '<signed URL>: HTTP 403');
  assert.equal(rootMessage(new Error(`fetching ${SOURCE}`)), 'fetching <signed URL>');
  assert.equal(rootMessage(new Error('https://site.example/p/root: HTTP 404')), 'https://site.example/p/root: HTTP 404', 'unsigned URLs stay');
});

test('an unreachable proof host makes the open fail before any probe', async () => {
  await assert.rejects(
    probeTrack({ ...settings(track.bytes), proof: 'https://nowhere.example/p' }),
    (err) => /https:\/\/nowhere\.example\/p\/root: HTTP 404/.test(rootMessage(err)),
  );
});
