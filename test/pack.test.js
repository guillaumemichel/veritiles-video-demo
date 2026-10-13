// The packer's contract is the released client: everything packMp4 emits
// must open and verify through the published veritiles VerifiedFile, and
// tampered bytes must fail closed with ordered failover. Its anchors are
// the veritiles v0.5 repository packer's for the same file.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedFile } from 'veritiles';

import { mp4Leaves, packMp4 } from '../scripts/lib/pack-mp4.js';
import { ascii, box, ftyp, moov, u32 } from './lib/bmff.js';
import { MiB, memFetch, syntheticTrack, tampered } from './lib/track-fixture.js';

const GOOD = 'mem://good/file';
const EVIL = 'mem://evil/file';
const PROOFS = 'mem://proofs';

function open(packed, files) {
  return new VerifiedFile({
    cid: packed.anchor,
    source: [...files.keys()],
    proof: PROOFS,
    fetchFn: memFetch({ files, proofs: new Map([[PROOFS, packed.proofs]]) }),
  });
}

const FRAGMENT = MiB - 1234;
const track = syntheticTrack({ segments: 4, seed: 7 });
const content = track.bytes;
const head = content.length - 4 * FRAGMENT;
const packed = await packMp4(content);

test('cuts one leaf for the init section and one per fragment', () => {
  const fragments = Array.from({ length: 4 }, (_, i) => ({ offset: head + i * FRAGMENT, length: FRAGMENT }));
  assert.deepEqual(mp4Leaves(content), [{ offset: 0, length: head }, ...fragments]);
  assert.equal(packed.leafCount, 5);
  assert.deepEqual([...packed.proofs.keys()].sort(), ['0', 'root']);
});

test('packs to the anchor and map the veritiles v0.5 packer prints for the same file', () => {
  // `npm run pack -- track.mp4` in the veritiles repository at v0.5.0.
  assert.equal(packed.anchor, 'bafyreigluxrtt2osypf5fmixi6cblkwvzhmzybdk6jkomnlwfcnyw4r7t4');
  assert.equal(packed.mapCid, 'bafkr4idtl45v3nigb2mmfhacefqksc2h4hj5bjqio4tvqwuosho5nawuqa');
});

test('segment boxes open their fragment, mdats stay with it, trailing boxes get a leaf', () => {
  const init = [...ftyp, ...moov()];
  const first = [...box('styp', ascii('msdh')), ...box('emsg', u32(0)), ...box('moof', u32(1)), ...box('mdat', u32(2))];
  const second = [...box('prft', u32(3)), ...box('moof', u32(4)), ...box('mdat', u32(5)), ...box('mdat', u32(6))];
  const tail = box('mfra', u32(7));
  const bytes = Uint8Array.from([...init, ...first, ...second, ...tail]);
  assert.deepEqual(mp4Leaves(bytes).map((leaf) => leaf.length), [init.length, first.length, second.length, tail.length]);
});

test('refuses what is not a well-formed fragmented MP4', async () => {
  const fragment = [...box('moof', u32(1)), ...box('mdat', u32(2))];
  assert.throws(() => mp4Leaves(Uint8Array.from([...moov(), ...ftyp, ...fragment])), /not a fragmented MP4/);
  assert.throws(() => mp4Leaves(Uint8Array.from([...ftyp, ...moov(), ...box('mdat', u32(2))])), /not a fragmented MP4/);
  assert.throws(() => mp4Leaves(content.subarray(0, content.length - 5)), /MP4 box at \d+ extends past the end of the file/);
  assert.throws(() => mp4Leaves(new Uint8Array(0)), /not a fragmented MP4/);
  await assert.rejects(packMp4(content.subarray(0, head)), /not a fragmented MP4/);
});

test('round-trips through the released veritiles client', async () => {
  const vf = open(packed, new Map([[GOOD, content]]));
  await vf.ready();
  assert.equal(vf.size, content.length);
  const reads = [
    [0, head], // the init leaf, exactly
    [head, FRAGMENT], // one fragment, exactly
    [head + FRAGMENT - 5, 10], // leaf-spanning
    [2 * MiB - 100, MiB + 200], // multi-leaf run
    [content.length - 50, 500], // clamped at EOF
    [0, content.length],
  ];
  for (const [offset, length] of reads) {
    const got = await vf.read(offset, length);
    const want = content.subarray(offset, Math.min(offset + length, content.length));
    assert.equal(got.length, want.length, `read(${offset}, ${length}) length`);
    assert.deepEqual(got, want, `read(${offset}, ${length}) bytes`);
  }
  assert.equal(vf.stats.rejected, 0);
  assert.ok(vf.stats.verified >= 5);
});

test('the malicious mirror differs from the file in every leaf', () => {
  const evil = tampered(content);
  for (const { offset, length } of mp4Leaves(content)) {
    const leaf = (bytes) => Buffer.from(bytes.subarray(offset, offset + length));
    assert.ok(!leaf(evil).equals(leaf(content)), `leaf at ${offset} left intact`);
  }
});

test('a tampered mirror is caught, banned, and failed over', async () => {
  const vf = open(packed, new Map([[EVIL, tampered(content)], [GOOD, content]]));
  const got = await vf.read(head + 5, MiB);
  assert.deepEqual(got, content.subarray(head + 5, head + 5 + MiB));
  // The open may catch the mirror once or twice (speculative fetch plus the
  // ordered-failover read); after that the ban must hold.
  const caught = vf.stats.rejected;
  assert.ok(caught >= 1 && caught <= 2, `caught ${caught} times at open`);
  await vf.read(0, 100);
  assert.equal(vf.stats.rejected, caught, 'banned mirror must not be consulted again');
});

test('tampering with no fallback fails closed', async () => {
  const vf = open(packed, new Map([[EVIL, tampered(content)]]));
  await assert.rejects(vf.read(0, 100));
  assert.ok(vf.stats.rejected >= 1);
});
