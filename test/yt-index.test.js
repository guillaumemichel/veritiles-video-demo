// yt-index.json: the upsert's generation rule and the shape every consumer
// relies on.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertVideo, nextGeneration, readIndex, upsertVideo, writeIndex } from '../scripts/lib/yt-index.js';

const ID = 'abcdefghijk';
const track = (anchor, mirrors = []) => ({ anchor, sha256: 'ab'.repeat(32), size: 10, mirrors });
const entry = (a, b) => ({
  title: 'T', url: `https://www.youtube.com/watch?v=${ID}`, license: 'CC-BY-3.0', licenseSource: 'youtube', ingestedAt: '2026-09-05',
  tracks: { 137: track(a), 140: track(b) },
});

test('a new video starts at generation 1', () => {
  assert.equal(nextGeneration({ videos: {} }, ID, entry('A', 'B')), 1);
  const index = upsertVideo({ videos: {} }, ID, entry('A', 'B'));
  assert.equal(index.videos[ID].generation, 1);
});

test('the same anchors keep the generation and merge mirrors; new anchors bump it and keep history', () => {
  const first = upsertVideo({ videos: {} }, ID, { ...entry('A', 'B'), tracks: { 137: track('A', ['https://mine/x']), 140: track('B') } });
  const same = upsertVideo(first, ID, { ...entry('A', 'B'), ingestedAt: 'later', tracks: { 137: track('A', ['https://release/x']), 140: track('B') } });
  assert.equal(same.videos[ID].generation, 1);
  assert.equal(same.videos[ID].ingestedAt, 'later');
  assert.equal(same.videos[ID].history, undefined);
  assert.deepEqual(same.videos[ID].tracks['137'].mirrors, ['https://release/x', 'https://mine/x']);

  assert.equal(nextGeneration(same, ID, entry('A', 'C')), 2);
  const next = upsertVideo(same, ID, entry('A', 'C'));
  assert.equal(next.videos[ID].generation, 2);
  assert.equal(next.videos[ID].history.length, 1);
  assert.equal(next.videos[ID].history[0].generation, 1);
  const third = upsertVideo(next, ID, entry('D', 'C'));
  assert.equal(third.videos[ID].generation, 3);
  assert.deepEqual(third.videos[ID].history.map((h) => h.generation), [2, 1]);
  assert.equal(first.videos[ID].generation, 1, 'earlier indexes are untouched');
});

test('the shape check names what is missing', () => {
  const stored = { ...entry('A', 'B'), generation: 1 };
  assert.doesNotThrow(() => assertVideo(ID, stored));
  assert.throws(() => assertVideo('bad id', stored), /not a YouTube video id/);
  assert.throws(() => assertVideo(ID, { ...stored, license: undefined }), /license is required/);
  assert.throws(() => assertVideo(ID, { ...stored, license: '' }), /license is required/);
  assert.throws(() => assertVideo(ID, { ...stored, licenseSource: undefined }), /licenseSource must be youtube or operator/);
  assert.throws(() => assertVideo(ID, { ...stored, ingestedAt: undefined }), /ingestedAt is required/);
  assert.throws(() => assertVideo(ID, { ...stored, ingestedAt: '2026-09-05T12:00:00.000Z' }), /ingestedAt must be a date/);
  assert.throws(() => assertVideo(ID, { ...stored, generation: 0 }), /generation/);
  assert.throws(() => assertVideo(ID, { ...stored, tracks: {} }), /at least one track/);
  assert.throws(() => assertVideo(ID, { ...stored, tracks: { abc: track('A') } }), /not a number/);
  assert.throws(() => assertVideo(ID, { ...stored, tracks: { 137: { ...track('A'), sha256: '' } } }), /sha256 is required/);
  assert.throws(() => assertVideo(ID, { ...stored, tracks: { 137: { ...track('A'), size: 0 } } }), /size/);
  assert.throws(() => assertVideo(ID, { ...stored, tracks: { 137: { ...track('A'), mirrors: 'nope' } } }), /mirrors/);
});

test('reads an empty index when the file is missing and round-trips one written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'index-'));
  try {
    const path = join(dir, 'yt-index.json');
    assert.deepEqual(await readIndex(path), { videos: {} });
    const index = upsertVideo({ videos: {} }, ID, entry('A', 'B'));
    await writeIndex(path, index);
    assert.deepEqual(await readIndex(path), index);
    await writeFile(path, `{"videos": {"${ID}": {"url": "u"}}}`);
    await assert.rejects(readIndex(path), /title is required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
