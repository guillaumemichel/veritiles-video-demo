#!/usr/bin/env node
// Assemble the static site: pack data/bbb.mp4 and every YouTube track
// yt-index.json names into veritiles proof directories, publish each video
// beside a deliberately tampered mirror copy, inject the presets (freshly
// computed anchors + paths, the YouTube origins, the watchtower's last
// word) into the page, and read the result back through the released
// client — honest path and tampered-first failover — before calling the
// build good.
import { Buffer } from 'node:buffer';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VerifiedFile } from 'veritiles';

import { directoryFetch } from './lib/local-fetch.js';
import { DEFAULT_CHUNK } from './lib/pack-fixed.js';
import { packTrack, tampered, writeProofs } from './lib/tracks.js';
import { INDEX_FILE, readIndex, trackFile } from './lib/yt-index.js';

const VIDEO = 'bbb.mp4';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(repoRoot, 'data');
const distDir = join(repoRoot, 'dist');
const distOrigin = 'http://dist.invalid';

async function main() {
  const bbb = await packTrack(join(dataDir, VIDEO));
  checkProbe(bbb, JSON.parse(await readFile(join(dataDir, 'bbb.json'), 'utf8')));
  const index = await readIndex(join(repoRoot, INDEX_FILE));

  await rm(distDir, { recursive: true, force: true });
  const bbbTrack = await publish(bbb, VIDEO, `evil/${VIDEO}`);
  const presets = [{ id: 'bbb', label: 'Big Buck Bunny', tracks: [bbbTrack] }];
  const checks = [{ packed: bbb, ...bbbTrack }];
  for (const [id, entry] of Object.entries(index.videos)) {
    const { preset, tracks } = await publishVideo(id, entry, await packIndexedTracks(id, entry));
    presets.push(preset);
    checks.push(...tracks);
  }
  await cp(join(repoRoot, 'web'), join(distDir, 'web'), { recursive: true });
  await mkdir(join(distDir, 'vendor'), { recursive: true });
  await copyFile(join(repoRoot, 'node_modules', 'veritiles', 'dist', 'index.js'), join(distDir, 'vendor', 'veritiles.js'));
  await writeFile(join(distDir, 'index.html'), injectConfig(await readFile(join(repoRoot, 'index.html'), 'utf8'), { presets }));

  for (const check of checks) await verify(check);

  console.log(`ANCHOR ${bbb.anchor}`);
  console.log(`MAP ${bbb.map}`);
  for (const { packed, src } of checks.slice(1)) console.log(`YT ${src} ${packed.anchor}`);
  console.log(`dist/: ${presets.length} presets, ${checks.length} tracks, ${checks.reduce((n, c) => n + c.packed.leafCount, 0)} leaves, codecs ${bbb.codecs}`);
}

// The published file, its proof directory beside it, and the malicious
// mirror when asked for. Returns the track as the page config names it.
async function publish(packed, src, evil = null) {
  const target = join(distDir, src);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, packed.bytes);
  await writeProofs(`${target}.proofs`, packed.proofs);
  if (evil !== null) {
    await mkdir(dirname(join(distDir, evil)), { recursive: true });
    await writeFile(join(distDir, evil), tampered(packed.bytes));
  }
  return { cid: packed.anchor, src, evil };
}

// A video's tracks from data/yt/<id>/, packed: whichever mirror or yt-dlp
// run put the bytes there, they must pack to the anchors the index records.
async function packIndexedTracks(id, entry) {
  const packed = {};
  for (const [itag, named] of Object.entries(entry.tracks)) {
    const rel = `data/yt/${id}/${trackFile(itag)}`;
    packed[itag] = await packTrack(join(repoRoot, rel)).catch((err) => {
      throw new Error(`${rel}: ${err.message} — run prepare-video (fetches the index's mirrors) or yt-ingest`);
    });
    if (packed[itag].anchor !== named.anchor) {
      throw new Error(`${rel} packs to ${packed[itag].anchor} but ${INDEX_FILE} names ${named.anchor}`);
    }
  }
  return packed;
}

// The video published under yt/<id>/ (the smallest track gets the malicious
// mirror) and its preset: tracks and YouTube origin.
async function publishVideo(id, entry, packed) {
  const itags = Object.keys(packed);
  const smallest = itags.reduce((a, b) => (packed[b].size < packed[a].size ? b : a));
  const tracks = [];
  for (const itag of itags) {
    const src = `yt/${id}/${trackFile(itag)}`;
    const evil = itag === smallest ? `yt/${id}/evil/${trackFile(itag)}` : null;
    tracks.push({ packed: packed[itag], ...(await publish(packed[itag], src, evil)), label: `${packed[itag].kind} itag ${itag}` });
  }
  const preset = {
    id: `yt-${id}`,
    label: `${entry.title} — YouTube itags ${itags.join('+')}`,
    tracks: tracks.map(({ cid, src, evil, label }) => ({ cid, src, evil, label })),
    youtube: {
      url: entry.url,
      channel: entry.channel ?? null,
      license: entry.license,
      generation: entry.generation,
      ingestedAt: entry.ingestedAt,
      recipe: entry.recipe ?? [],
    },
  };
  return { preset, tracks };
}

// The config is inlined into a <script>: JSON is not script-safe as is, and
// titles arrive from YouTube.
function injectConfig(page, config) {
  const placeholder = "const CONFIG = 'VERITILES_CONFIG';";
  if (page.split(placeholder).length !== 2) {
    throw new Error('index.html must contain exactly one CONFIG placeholder');
  }
  const json = JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return page.replace(placeholder, () => `const CONFIG = ${json};`);
}

// ffprobe's values (data/bbb.json) are the reference for what the head yields.
function checkProbe({ size, codecs, durationSeconds }, meta) {
  if (meta.sizeBytes !== size) {
    throw new Error(`data/bbb.json describes ${meta.sizeBytes} bytes, file has ${size} — re-run prepare-video`);
  }
  if (Math.abs(durationSeconds - meta.durationSeconds) > 2) {
    throw new Error(`sidx duration ${durationSeconds}s disagrees with container ${meta.durationSeconds}s`);
  }
  if (codecs !== meta.codecs) throw new Error(`moov codecs ${codecs} disagree with ffprobe's ${meta.codecs}`);
}
// Read dist/ back through the released client, the way the page does.
async function verify({ packed: { anchor, bytes }, src, evil }) {
  const fetchFn = directoryFetch(distDir);
  const good = `${distOrigin}/${src}`;
  const proof = `${good}.proofs`;

  const honest = new VerifiedFile({ cid: anchor, source: good, proof, fetchFn });
  for (const [offset, length] of [[0, 64 * 1024], [Math.floor(bytes.length / 2) - 3, 70000], [bytes.length - 5000, 5000]]) {
    expectEqual(await honest.read(offset, length), bytes.subarray(offset, offset + length), `${src}: honest read at ${offset}`);
  }
  if (honest.stats.rejected !== 0) throw new Error(`${src}: honest source produced rejections`);
  if (evil === null) return;

  const failover = new VerifiedFile({ cid: anchor, source: [`${distOrigin}/${evil}`, good], proof, fetchFn });
  expectEqual(await failover.read(0, DEFAULT_CHUNK), bytes.subarray(0, DEFAULT_CHUNK), `${src}: failover head read`);
  // The open may catch the tampered mirror twice (speculative fetch + the
  // ordered-failover read) — what must hold is: caught, then never again.
  const caught = failover.stats.rejected;
  if (caught < 1 || caught > 2) {
    throw new Error(`${src}: expected the tampered mirror to be caught at open, saw ${caught} rejections`);
  }
  const later = Math.min(7 * DEFAULT_CHUNK, bytes.length - 4096);
  expectEqual(await failover.read(later, 4096), bytes.subarray(later, later + 4096), `${src}: post-ban read`);
  if (failover.stats.rejected !== caught) throw new Error(`${src}: tampered mirror was consulted again after the ban`);
}

function expectEqual(got, want, label) {
  if (got.length !== want.length || !Buffer.from(got).equals(Buffer.from(want))) {
    throw new Error(`${label}: verified bytes differ from the source`);
  }
}

await main();
