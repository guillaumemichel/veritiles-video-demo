#!/usr/bin/env node
// Assemble the static site: pack data/bbb.mp4 into its veritiles proof
// directory, publish the video plus a deliberately tampered mirror copy,
// inject the freshly computed anchor CID into the page, and then read the
// result back through the released veritiles client — both the honest path
// and the tampered-first failover — before calling the build good.
import { Buffer } from 'node:buffer';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VerifiedFile } from 'veritiles';

import { directoryFetch } from './lib/local-fetch.js';
import { DEFAULT_CHUNK, packFixed } from './lib/pack-fixed.js';
import { parseIndex } from '../web/mp4.js';

const VIDEO = 'bbb.mp4';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(repoRoot, 'data');
const distDir = join(repoRoot, 'dist');
const distOrigin = 'http://dist.invalid';

async function main() {
  const bytes = new Uint8Array(await readFile(join(dataDir, VIDEO)));
  const meta = JSON.parse(await readFile(join(dataDir, 'bbb.json'), 'utf8'));
  if (meta.sizeBytes !== bytes.length) {
    throw new Error(`data/bbb.json describes ${meta.sizeBytes} bytes, file has ${bytes.length} — re-run prepare-video`);
  }
  checkIndex(bytes, meta);
  const packed = packFixed(bytes);

  await rm(distDir, { recursive: true, force: true });
  await mkdir(join(distDir, `${VIDEO}.proofs`), { recursive: true });
  await copyFile(join(dataDir, VIDEO), join(distDir, VIDEO));
  for (const [path, content] of packed.proofs) {
    await writeFile(join(distDir, `${VIDEO}.proofs`, path), content);
  }
  await mkdir(join(distDir, 'evil'), { recursive: true });
  await writeFile(join(distDir, 'evil', VIDEO), tampered(bytes));
  await cp(join(repoRoot, 'web'), join(distDir, 'web'), { recursive: true });
  await mkdir(join(distDir, 'vendor'), { recursive: true });
  await copyFile(join(repoRoot, 'node_modules', 'veritiles', 'dist', 'index.js'), join(distDir, 'vendor', 'veritiles.js'));
  await writeFile(join(distDir, 'index.html'), injectConfig(
    await readFile(join(repoRoot, 'index.html'), 'utf8'),
    { cid: packed.anchor, codecs: meta.codecs, durationSeconds: meta.durationSeconds },
  ));

  await verify(packed.anchor, bytes);

  console.log(`ANCHOR ${packed.anchor}`);
  console.log(`MAP ${packed.mapCid}`);
  console.log(`dist/: ${bytes.length} B video + tampered mirror, ${packed.leafCount} leaves, `
    + `${packed.proofs.size} proof files, codecs ${meta.codecs}`);
}

// One flipped byte in the middle of every leaf: whatever the player reads
// first from this mirror fails verification.
function tampered(bytes) {
  const evil = Buffer.from(bytes);
  for (let offset = 0; offset < evil.length; offset += DEFAULT_CHUNK) {
    const middle = offset + Math.floor(Math.min(DEFAULT_CHUNK, evil.length - offset) / 2);
    evil[middle] ^= 0xff;
  }
  return evil;
}

function injectConfig(page, config) {
  const placeholder = "const CONFIG = 'VERITILES_CONFIG';";
  if (page.split(placeholder).length !== 2) {
    throw new Error('index.html must contain exactly one CONFIG placeholder');
  }
  return page.replace(placeholder, `const CONFIG = ${JSON.stringify(config)};`);
}

// The published head must yield the segment index the player will run on.
function checkIndex(bytes, meta) {
  const index = parseIndex(bytes.subarray(0, 64 * 1024));
  if (index === null) throw new Error('no complete sidx in the first 64 KiB — check the ffmpeg movflags');
  const last = index.segments.at(-1);
  if (last.offset + last.size > bytes.length) throw new Error('sidx references run past end of file');
  if (Math.abs(index.duration - meta.durationSeconds) > 2) {
    throw new Error(`sidx duration ${index.duration}s disagrees with container ${meta.durationSeconds}s`);
  }
}

// Read dist/ back through the released client, the way the page does.
async function verify(anchor, bytes) {
  const fetchFn = directoryFetch(distDir);
  const good = `${distOrigin}/${VIDEO}`;
  const proof = `${distOrigin}/${VIDEO}.proofs`;

  const honest = new VerifiedFile({ cid: anchor, source: good, proof, fetchFn });
  for (const [offset, length] of [[0, 64 * 1024], [Math.floor(bytes.length / 2) - 3, 70000], [bytes.length - 5000, 5000]]) {
    expectEqual(await honest.read(offset, length), bytes.subarray(offset, offset + length), `honest read at ${offset}`);
  }
  if (honest.stats.rejected !== 0) throw new Error('honest source produced rejections');

  const failover = new VerifiedFile({ cid: anchor, source: [`${distOrigin}/evil/${VIDEO}`, good], proof, fetchFn });
  expectEqual(await failover.read(0, DEFAULT_CHUNK), bytes.subarray(0, DEFAULT_CHUNK), 'failover head read');
  // The open may catch the tampered mirror twice (speculative fetch + the
  // ordered-failover read) — what must hold is: caught, then never again.
  const caught = failover.stats.rejected;
  if (caught < 1 || caught > 2) {
    throw new Error(`expected the tampered mirror to be caught at open, saw ${caught} rejections`);
  }
  expectEqual(await failover.read(7 * DEFAULT_CHUNK, 4096), bytes.subarray(7 * DEFAULT_CHUNK, 7 * DEFAULT_CHUNK + 4096), 'post-ban read');
  if (failover.stats.rejected !== caught) throw new Error('tampered mirror was consulted again after the ban');
}

function expectEqual(got, want, label) {
  if (got.length !== want.length || !Buffer.from(got).equals(Buffer.from(want))) {
    throw new Error(`${label}: verified bytes differ from the source`);
  }
}

await main();
