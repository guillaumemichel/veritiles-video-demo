// The watchtower machinery against an in-memory "YouTube": honest bytes
// match, tampered bytes are a mismatch (even when a retry then fails for
// another reason), a missing delivery is unavailable, probes land on
// distinct mid-file leaves, and no signed delivery URL — nor the IP it is
// bound to — reaches the terminal.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packFixed } from '../scripts/lib/pack-fixed.js';
import { LEAF, probeLeaf, probeOffsets, probeTrack, rootMessage } from '../scripts/lib/watchtower.js';
import { memFetch, seededRandom, syntheticTrack, tampered } from './lib/track-fixture.js';

// Signed like a real delivery: bound to the resolving IP (a documentation address).
const SOURCE = 'https://rr1---sn-test.googlevideo.example/videoplayback?itag=137&expire=1&ip=203.0.113.7&sig=x';
const PROOF = 'https://site.example/yt/v/itag137.mp4.proofs';

const track = syntheticTrack({ segments: 5, seed: 3 }); // 5 leaves, the last partial
const packed = packFixed(track.bytes);
const proofs = new Map([[PROOF, packed.proofs]]);
const settings = (bytes) => ({
  cid: packed.anchor,
  source: SOURCE,
  proof: PROOF,
  fetchFn: memFetch({ files: bytes ? new Map([[SOURCE, bytes]]) : new Map(), proofs }),
});

test('probe offsets are distinct, leaf-aligned and mid-file', () => {
  const offsets = probeOffsets(10 * LEAF + 5, 3, seededRandom(1));
  assert.equal(offsets.length, 3);
  assert.deepEqual(offsets, [...new Set(offsets)].sort((a, b) => a - b));
  for (const offset of offsets) {
    assert.equal(offset % LEAF, 0);
    assert.ok(offset >= LEAF && offset <= 9 * LEAF, `offset ${offset} outside the mid-file leaves`);
  }
  assert.deepEqual(probeOffsets(LEAF - 1, 3), [0], 'a one-leaf file has only its head to probe');
  assert.equal(probeOffsets(4 * LEAF, 3).length, 2, 'k clamps to the mid-file leaves available');
});

test('honest bytes match on every probe, with each proof file fetched once', async () => {
  let proofFetches = 0;
  const inner = settings(track.bytes).fetchFn;
  const fetchFn = (input, init) => { if (String(input).startsWith(PROOF)) proofFetches += 1; return inner(input, init); };
  const { size, probes } = await probeTrack({ ...settings(track.bytes), fetchFn, k: 3, random: seededRandom(5) });
  assert.equal(size, track.size);
  assert.equal(probes.length, 3);
  for (const probe of probes) {
    assert.equal(probe.result, 'match');
    assert.equal(probe.bytes, LEAF);
  }
  assert.equal(proofFetches, packed.proofs.size, 'root and the shard, once each');
});

test('tampered bytes are a mismatch on every probe, each judged on its own', async () => {
  const { probes } = await probeTrack({ ...settings(tampered(track.bytes)), k: 3, random: seededRandom(5) });
  assert.deepEqual(probes.map((p) => p.result), ['mismatch', 'mismatch', 'mismatch']);
  assert.match(probes[0].detail, /digest mismatch/);
});

test('bytes rejected before the delivery went away still count as a mismatch', async () => {
  // First ranged answer: wrong bytes (rejected); the verified retry: 404.
  let ranged = 0;
  const honest = settings(tampered(track.bytes)).fetchFn;
  const fetchFn = (input, init) => {
    if (String(input) === SOURCE && ++ranged > 1) return new Response('gone', { status: 404 });
    return honest(input, init);
  };
  const probe = await probeLeaf({ ...settings(null), fetchFn, offset: LEAF });
  assert.equal(probe.result, 'mismatch');
  assert.match(probe.detail, /HTTP 404/);
});

test('a delivery that answers 404 is unavailable, not a mismatch', async () => {
  const probe = await probeLeaf({ ...settings(null), offset: LEAF });
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
