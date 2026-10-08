// The packer's contract is the released client: everything packFixed emits
// must open and verify through the published veritiles VerifiedFile, and
// tampered bytes must fail closed with ordered failover.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VerifiedFile } from 'veritiles';

import { packFixed } from '../scripts/lib/pack-fixed.js';
import { MiB, memFetch, pseudoRandom, tampered } from './lib/track-fixture.js';

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

const content = pseudoRandom(3 * MiB + 12345);
const packed = packFixed(content);

test('emits the expected flat proof layout', () => {
  assert.equal(packed.leafCount, 4);
  assert.deepEqual([...packed.proofs.keys()].sort(), ['0', 'root'].sort());
  assert.match(packed.anchor, /^bafyrei/);
  assert.match(packed.mapCid, /^bafkrei/);
});

test('round-trips through the released veritiles client', async () => {
  const vf = open(packed, new Map([[GOOD, content]]));
  await vf.ready();
  assert.equal(vf.size, content.length);
  const reads = [
    [0, 100],
    [MiB - 5, 10], // leaf-spanning
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
  assert.ok(vf.stats.verified >= 4);
});

test('a tampered mirror is caught, banned, and failed over', async () => {
  const vf = open(packed, new Map([[EVIL, tampered(content)], [GOOD, content]]));
  const got = await vf.read(MiB + 5, MiB);
  assert.deepEqual(got, content.subarray(MiB + 5, 2 * MiB + 5));
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
