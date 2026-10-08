// The ingest flow against a stubbed yt-dlp: the determinism gate, the
// licence gate, the itag choice, the pack beside the file, the index row it
// produces, and the release command it prints.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { chooseItags, ingestVideo, isCreativeCommons, releaseCommand, releaseMirrors, releaseTag, shellQuote } from '../scripts/lib/ingest.js';
import { packFixed } from '../scripts/lib/pack-fixed.js';
import { syntheticTrack } from './lib/track-fixture.js';

const ID = 'abcdefghijk';
const CC = 'Creative Commons Attribution license (reuse allowed)';
const video = syntheticTrack({ kind: 'video', segments: 3, seed: 7 });
const audio = syntheticTrack({ kind: 'audio', segments: 2, segmentSize: 300000, seed: 9 });
const fixtures = { 136: video.bytes, 137: video.bytes, 140: audio.bytes };
const FORMATS = [
  { itag: 136, vcodec: 'avc1.4d401f', acodec: 'none', height: 720 },
  { itag: 137, vcodec: 'avc1.640028', acodec: 'none', height: 1080 },
  { itag: 248, vcodec: 'vp9', acodec: 'none', height: 1080 },
  { itag: 140, vcodec: 'none', acodec: 'mp4a.40.2', height: 0 },
  { itag: 251, vcodec: 'none', acodec: 'opus', height: 0 },
];

const roots = [];
after(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'ingest-'));
  roots.push(dir);
  return dir;
}

// A yt-dlp whose downloads come from `bytesFor(itag, call)`.
function stubYt({ bytesFor = (itag) => fixtures[itag], license = CC, formats = FORMATS } = {}) {
  const calls = {};
  return {
    version: async () => '2026.test',
    metadata: async () => ({
      title: 'Synthetic', channel: 'Fixtures', channelId: 'UC0', license, uploadDate: '20260101', durationSeconds: 15, formats,
    }),
    download: async (id, itag, out) => {
      calls[itag] = (calls[itag] ?? 0) + 1;
      await writeFile(out, bytesFor(itag, calls[itag]));
    },
  };
}

const settings = (dir, extra = {}) => ({
  id: ID, itags: [137, 140], dir, index: { videos: {} }, yt: stubYt(), now: () => new Date('2026-09-05T00:00:00Z'), ...extra,
});

test('records anchors, digests, codecs and the recipe for reproducible tracks', async () => {
  const dir = await scratch();
  const { index, entry } = await ingestVideo(settings(dir, { mirrors: releaseMirrors('owner/repo', ID) }));
  assert.equal(index.videos[ID], entry);
  assert.equal(entry.generation, 1);
  assert.equal(entry.title, 'Synthetic');
  assert.equal(entry.url, `https://www.youtube.com/watch?v=${ID}`);
  assert.equal(entry.license, 'CC-BY-3.0');
  assert.equal(entry.licenseSource, 'youtube');
  assert.equal(entry.youtubeLicense, CC);
  assert.deepEqual(entry.tools, { 'yt-dlp': '2026.test' });
  assert.equal(entry.ingestedAt, '2026-09-05', 'the day only — no time of day');
  assert.equal(entry.recipe.length, 4);
  assert.equal(entry.recipe[0], `yt-dlp --ignore-config --js-runtimes node -f 137 --fixup never -o itag137.mp4 'https://www.youtube.com/watch?v=${ID}'`);
  assert.equal(entry.recipe[1], 'sha256sum itag137.mp4');

  const t137 = entry.tracks['137'];
  assert.equal(t137.anchor, packFixed(video.bytes).anchor);
  assert.equal(t137.map, undefined, 'the whole-file digest is recorded once, as sha256');
  assert.equal(t137.kind, 'video');
  assert.equal(t137.codecs, 'avc1.640029');
  assert.equal(t137.size, video.size);
  assert.match(t137.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(t137.mirrors, [`https://github.com/owner/repo/releases/download/yt-${ID}/itag137.mp4`]);
  assert.equal(entry.tracks['140'].kind, 'audio');
  assert.equal(entry.tracks['140'].codecs, 'mp4a.40.2');

  // The pack sits beside the file; the second download is gone.
  const root = await readFile(join(dir, 'itag137.mp4.proofs', 'root'));
  assert.deepEqual(new Uint8Array(root), packFixed(video.bytes).proofs.get('root'));
  await assert.rejects(access(join(dir, 'itag137.mp4.again')));
});

test('without itags the tallest H.264 track and AAC audio are taken', async () => {
  assert.deepEqual(chooseItags(FORMATS), [137, 140]);
  assert.deepEqual(chooseItags(FORMATS.filter((f) => f.itag !== 137)), [136, 140]);
  assert.deepEqual(chooseItags([...FORMATS.filter((f) => f.itag !== 140), { itag: 141, vcodec: 'none', acodec: 'mp4a.40.2', height: 0 }]), [137, 141]);
  assert.throws(() => chooseItags(FORMATS.filter((f) => f.vcodec === 'vp9' || f.acodec === 'opus')), /no H\.264 video \+ AAC audio pair/);
  const dir = await scratch();
  const { entry } = await ingestVideo(settings(dir, { itags: undefined, yt: stubYt({ formats: FORMATS.filter((f) => f.itag !== 137) }) }));
  assert.deepEqual(Object.keys(entry.tracks), ['136', '140']);
});

test('two downloads that differ stop the ingest and keep both files', async () => {
  const dir = await scratch();
  const flaky = stubYt({ bytesFor: (itag, call) => (call === 2 && itag === 137 ? new Uint8Array(video.bytes).fill(0, 5000, 5001) : fixtures[itag]) });
  await assert.rejects(ingestVideo(settings(dir, { yt: flaky })), /two downloads differ.*not reproducible/s);
  await access(join(dir, 'itag137.mp4'));
  await access(join(dir, 'itag137.mp4.again'));
});

test('without an asserted licence, YouTube\'s own field must say Creative Commons', async () => {
  const dir = await scratch();
  await assert.rejects(ingestVideo(settings(dir, { yt: stubYt({ license: 'Standard YouTube License' }) })), /says "Standard YouTube License", not Creative Commons/);
  await assert.rejects(ingestVideo(settings(dir, { yt: stubYt({ license: null }) })), /says nothing, not Creative Commons/);
  const { entry } = await ingestVideo(settings(dir, { yt: stubYt({ license: null }), license: 'CC-BY-3.0' }));
  assert.equal(entry.license, 'CC-BY-3.0');
  assert.equal(entry.licenseSource, 'operator');
  assert.equal(entry.youtubeLicense, null);
  for (const blank of ['', '  ', 'CC BY']) {
    await assert.rejects(ingestVideo(settings(dir, { yt: stubYt({ license: null }), license: blank })), /--license wants an SPDX id/);
  }
  assert.equal(isCreativeCommons('Creative Commons Attribution license (reuse allowed)'), true);
  assert.equal(isCreativeCommons('Standard YouTube License'), false);
});

test('refuses itags the video does not offer', async () => {
  const dir = await scratch();
  await assert.rejects(ingestVideo(settings(dir, { itags: [137, 299] })), /does not offer itag 299 — offered: 136, 137, 248, 140, 251/);
});

test('re-ingest keeps the generation and hand-added mirrors for the same bytes, bumps it for new ones', async () => {
  const dir = await scratch();
  const first = await ingestVideo(settings(dir));
  const byHand = { ...first.index, videos: { [ID]: { ...first.entry, tracks: { ...first.entry.tracks, 137: { ...first.entry.tracks['137'], mirrors: ['https://mine/itag137.mp4'] } } } } };
  const same = await ingestVideo(settings(dir, { index: byHand, mirrors: releaseMirrors('o/r', ID) }));
  assert.equal(same.entry.generation, 1);
  assert.equal(same.entry.history, undefined);
  assert.deepEqual(same.entry.tracks['137'].mirrors, [`https://github.com/o/r/releases/download/yt-${ID}/itag137.mp4`, 'https://mine/itag137.mp4']);

  const reencoded = stubYt({ bytesFor: (itag) => (itag === 140 ? syntheticTrack({ kind: 'audio', segments: 2, segmentSize: 300000, seed: 11 }).bytes : fixtures[itag]) });
  const next = await ingestVideo(settings(dir, { index: first.index, yt: reencoded, mirrors: releaseMirrors('o/r', ID) }));
  assert.equal(next.entry.generation, 2);
  assert.equal(next.entry.history.length, 1);
  assert.equal(next.entry.history[0].generation, 1);
  assert.equal(next.entry.history[0].tracks['140'].anchor, first.entry.tracks['140'].anchor);
  assert.deepEqual(next.entry.tracks['137'].mirrors, [`https://github.com/o/r/releases/download/yt-${ID}-g2/itag137.mp4`]);
});

test('release tags name the video and, past the first, the generation', () => {
  assert.equal(releaseTag(ID, 1), `yt-${ID}`);
  assert.equal(releaseTag(ID, 3), `yt-${ID}-g3`);
});

test('the printed release command quotes what the uploader controls', () => {
  const hostile = `Film $(touch pwned) \`id\` "q" it's`;
  assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(hostile)}`]).toString(), hostile);
  const entry = { title: hostile, channel: 'Chan', license: 'CC-BY-3.0', url: `https://www.youtube.com/watch?v=${ID}` };
  const command = releaseCommand(`yt-${ID}`, ['data/yt/x/itag137.mp4', 'my dir/itag140.mp4'], entry);
  assert.equal(command, `gh release create yt-${ID} 'data/yt/x/itag137.mp4' 'my dir/itag140.mp4' --notes ${shellQuote(`${hostile} by Chan, CC-BY-3.0: the tracks YouTube serves for https://www.youtube.com/watch?v=${ID}, byte for byte; anchors in yt-index.json`)}`);
});
