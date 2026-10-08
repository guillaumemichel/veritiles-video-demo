#!/usr/bin/env node
// The watchtower: YouTube as an untrusted range server, spot-checked against
// the index. For every track it resolves a fresh delivery URL through
// yt-dlp, reads k random mid-file leaves through the verified client, and
// prints what it saw — nothing is recorded. Run it from a residential
// connection: datacenter egress is bot-checked, and shows up as `unavailable`.
//
//   node scripts/watchtower.mjs [--k 3] [--video <id>] [--proofs <url base>]
//   node scripts/watchtower.mjs --source-base http://127.0.0.1:8080   # a served dist/ as mock YouTube
//   node scripts/watchtower.mjs --stream <id>:<itag> [--out file]     # verified streaming from YouTube
//
// --proofs names the published site (…/veritiles-video-demo); without it the
// proofs come from data/yt/ on disk, where yt-ingest wrote them. Cookie
// flags in YT_DLP_ARGS are refused (lib/yt-dlp.js). Exit 0: every probe
// matched or was unavailable. 2: a mismatch (YouTube serves other bytes
// now — re-ingest for a new generation), or a streamed leaf failed. 1:
// could not run.
import { createWriteStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { VerifiedFile } from 'veritiles';

import { directoryFetch } from './lib/local-fetch.js';
import { LEAF, probeTrack, rootMessage } from './lib/watchtower.js';
import * as yt from './lib/yt-dlp.js';
import { INDEX_FILE, readIndex, trackFile } from './lib/yt-index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(repoRoot, 'data');
const LOCAL_PROOFS = 'http://proofs.local'; // routed to data/ on disk

async function main() {
  const options = cli();
  yt.refuseCookies();
  const index = await readIndex(join(repoRoot, INDEX_FILE));
  if (options.stream) return stream(index, options);
  const results = [];
  for (const [id, entry] of Object.entries(index.videos)) {
    if (options.video && options.video !== id) continue;
    for (const itag of Object.keys(entry.tracks)) {
      await checkProofs(id, itag, options);
      results.push(...await checkTrack(id, Number(itag), entry.tracks[itag], options));
    }
  }
  if (results.length === 0) throw new Error(options.video ? `${options.video} is not in ${INDEX_FILE}` : `${INDEX_FILE} names no videos — run yt-ingest first`);
  const count = (result) => results.filter((r) => r === result).length;
  console.log(`${count('match')} leaves matched, ${count('mismatch')} mismatched, ${count('unavailable')} unavailable`);
  process.exit(count('mismatch') > 0 ? 2 : 0);
}

// One result per probe, or a single `unavailable` when no delivery could be
// resolved or opened.
async function checkTrack(id, itag, track, options) {
  let probes;
  try {
    const delivery = await resolveDelivery(id, itag, options);
    ({ probes } = await probeTrack({
      cid: track.anchor,
      source: delivery.url,
      proof: proofBase(id, itag, options),
      fetchFn: routedFetch(delivery),
      k: options.k,
    }));
  } catch (err) {
    console.log(`${id} itag ${itag}: unavailable — ${rootMessage(err)}`);
    return ['unavailable'];
  }
  for (const probe of probes) {
    console.log(`${id} itag ${itag} @${probe.offset / LEAF} MiB: ${probe.result}${probe.detail ? ` — ${probe.detail}` : ''} (${probe.ms} ms)`);
  }
  return probes.map((probe) => probe.result);
}

// Sequential leaves instead of random ones: the whole track
// streamed and byte-verified from YouTube itself, anchor as the only trust
// input. `node scripts/watchtower.mjs --stream <id>:<itag> | mpv -`.
async function stream(index, options) {
  const [id, itagText] = options.stream.split(':');
  const track = index.videos[id]?.tracks[itagText];
  if (!track) throw new Error(`--stream wants <id>:<itag> from ${INDEX_FILE}, got ${options.stream}`);
  await checkProofs(id, itagText, options);
  const delivery = await resolveDelivery(id, Number(itagText), options);
  const vf = new VerifiedFile({ cid: track.anchor, source: delivery.url, proof: proofBase(id, Number(itagText), options), fetchFn: routedFetch(delivery) });
  await vf.ready();
  const out = options.out ? createWriteStream(options.out) : process.stdout;
  const leaves = Math.ceil(vf.size / LEAF);
  for (let leaf = 0; leaf < leaves; leaf++) {
    let bytes;
    try {
      bytes = await vf.read(leaf * LEAF, LEAF);
    } catch (err) {
      console.error(`\nstopped at leaf ${leaf}: ${rootMessage(err)} (${leaf} leaves verified, ${vf.stats.rejected} rejected)`);
      process.exit(2);
    }
    await new Promise((res, rej) => out.write(bytes, (err) => (err ? rej(err) : res())));
    progress(leaf + 1, leaves);
  }
  if (process.stderr.isTTY) process.stderr.write('\n');
  if (options.out) out.end();
}

function progress(done, total) {
  const line = `verified ${done}/${total} leaves`;
  if (process.stderr.isTTY) process.stderr.write(`\r${line}`);
  else if (done % 32 === 0 || done === total) process.stderr.write(`${line}\n`);
}

// A delivery: the googlevideo URL yt-dlp resolves, or under --source-base
// the same track on a served dist/ (the mock YouTube CI runs against).
async function resolveDelivery(id, itag, { sourceBase }) {
  if (sourceBase) return { url: `${sourceBase}/yt/${id}/${trackFile(itag)}`, headers: {} };
  return yt.resolve(id, itag);
}

function proofBase(id, itag, { proofs }) {
  return `${proofs ?? LOCAL_PROOFS}/yt/${id}/${trackFile(itag)}.proofs`;
}

// Without --proofs the proofs must be on disk, where yt-ingest wrote them.
async function checkProofs(id, itag, { proofs }) {
  if (proofs) return;
  const dir = join(dataDir, 'yt', id, `${trackFile(itag)}.proofs`);
  await access(dir).catch(() => {
    throw new Error(`${dir} is missing — run yt-ingest, or pass --proofs <site url> to read the published proofs`);
  });
}

// Delivery requests carry the delivery's headers; local proof URLs read the
// files yt-ingest wrote to data/yt/.
function routedFetch(delivery) {
  const local = directoryFetch(dataDir);
  const remote = yt.deliveryFetch(delivery);
  return (input, init) => (String(input).startsWith(`${LOCAL_PROOFS}/`) ? local(input, init) : remote(input, init));
}

function cli() {
  const { values } = parseArgs({
    options: {
      k: { type: 'string', default: '3' },
      video: { type: 'string' },
      proofs: { type: 'string' },
      'source-base': { type: 'string' },
      stream: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const k = Number(values.k);
  if (!Number.isInteger(k) || k < 1) throw new Error(`--k must be a positive integer, got ${values.k}`);
  const strip = (url) => url?.replace(/\/+$/, '');
  return { k, video: values.video, proofs: strip(values.proofs), sourceBase: strip(values['source-base']), stream: values.stream, out: values.out };
}

await main().catch((err) => {
  console.error(rootMessage(err));
  process.exit(1);
});
