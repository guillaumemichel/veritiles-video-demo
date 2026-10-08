// Tracks on disk: what the head describes, the pack beside the file, and the
// mirror route that only accepts the bytes the index names.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { packFixed } from '../scripts/lib/pack-fixed.js';
import { describeTrack, ensureTrackFile, packTrack, sha256Hex, writeProofs } from '../scripts/lib/tracks.js';
import { syntheticTrack } from './lib/track-fixture.js';

const roots = [];
after(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'tracks-'));
  roots.push(dir);
  return dir;
}

const video = syntheticTrack({ kind: 'video', segments: 2, seed: 2 });
const audio = syntheticTrack({ kind: 'audio', segments: 3, segmentSize: 4000, seed: 4 });

test('describes a track the way the player will see it', () => {
  assert.deepEqual(describeTrack(video.bytes), { size: video.size, codecs: 'avc1.640029', kind: 'video', durationSeconds: 10, segments: 2 });
  assert.equal(describeTrack(audio.bytes).kind, 'audio');
  assert.throws(() => describeTrack(video.bytes.subarray(0, video.size - 100)), /run past end of file/);
  assert.throws(() => describeTrack(new Uint8Array(100)), /open-ended box/);
  assert.throws(() => describeTrack(video.bytes.subarray(0, 40)), /no complete sidx/);
});

test('packs the file beside itself with the same anchor the packer computes', async () => {
  const dir = await scratch();
  const path = join(dir, 'itag137.mp4');
  await writeFile(path, video.bytes);
  const packed = await packTrack(path);
  assert.equal(packed.anchor, packFixed(video.bytes).anchor);
  assert.equal(packed.map, packFixed(video.bytes).mapCid);
  assert.equal(packed.sha256, sha256Hex(video.bytes));
  assert.equal(packed.kind, 'video');
  await writeProofs(`${path}.proofs`, packed.proofs);
  assert.deepEqual(new Uint8Array(await readFile(join(`${path}.proofs`, 'root'))), packed.proofs.get('root'));
});

test('ensureTrackFile keeps a matching file and fetches a missing one from the first honest mirror', async () => {
  const dir = await scratch();
  const path = join(dir, 'itag140.mp4');
  const named = { sha256: sha256Hex(audio.bytes), size: audio.size, mirrors: ['https://m1/itag140.mp4', 'https://m2/itag140.mp4', 'https://m3/itag140.mp4'] };
  const served = {
    'https://m1/itag140.mp4': null, // 404
    'https://m2/itag140.mp4': new Uint8Array(audio.bytes).fill(1, 0, 10), // wrong bytes
    'https://m3/itag140.mp4': audio.bytes,
  };
  const fetchFn = async (url) => (served[url] ? new Response(new Uint8Array(served[url])) : new Response('nope', { status: 404 }));
  assert.equal(await ensureTrackFile(path, named, fetchFn), 'https://m3/itag140.mp4');
  assert.deepEqual(new Uint8Array(await readFile(path)), audio.bytes);
  assert.equal(await ensureTrackFile(path, named, fetchFn), 'present');

  await writeFile(path, new Uint8Array(5));
  assert.equal(await ensureTrackFile(path, named, fetchFn), 'https://m3/itag140.mp4', 'a file with other bytes is replaced');
  await assert.rejects(ensureTrackFile(join(dir, 'none.mp4'), { ...named, mirrors: [] }, fetchFn), /no mirrors listed.*yt-ingest/s);
  await assert.rejects(ensureTrackFile(join(dir, 'none.mp4'), { ...named, mirrors: named.mirrors.slice(0, 2) }, fetchFn), /HTTP 404.*is not the index's/s);
});

test('a mirror that streams past the index size is cut off', async () => {
  const dir = await scratch();
  const oversized = new Uint8Array(audio.size + 1);
  const fetchFn = async () => new Response(oversized);
  await assert.rejects(
    ensureTrackFile(join(dir, 'big.mp4'), { sha256: 'x', size: audio.size, mirrors: ['https://m/big.mp4'] }, fetchFn),
    /sent more than the index's \d+ bytes/,
  );
  await assert.rejects(readFile(join(dir, 'big.mp4.part')), /ENOENT/);
});
