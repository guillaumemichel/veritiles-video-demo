#!/usr/bin/env node
// Ingest a YouTube video's pristine tracks and record their identity in
// yt-index.json: two downloads per itag must agree byte for byte, each track
// is packed beside its file in data/yt/<id>/, and the index gains the
// anchors plus the recipe anyone can re-run to reproduce them.
//
//   node scripts/yt-ingest.mjs [--] <videoId> [--itags 136,140] [--license CC-BY-3.0] [--mirror <url base>]
//
// Without --itags the tallest H.264 track and AAC audio are taken. Without
// --license, YouTube's own licence field must say Creative Commons; with
// it you assert the licence yourself — only when the rights holder grants
// it elsewhere (a CC film whose description says so) or it is your upload.
// Requires yt-dlp (`uv tool install yt-dlp` or pip) — YouTube bot-checks
// datacenter egress, so run this from a residential connection. Cookie
// flags in YT_DLP_ARGS are refused (lib/yt-dlp.js).
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ingestVideo, releaseCommand, releaseMirrors, releaseTag } from './lib/ingest.js';
import * as yt from './lib/yt-dlp.js';
import { INDEX_FILE, readIndex, trackFile, writeIndex } from './lib/yt-index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: yt-ingest [--] <videoId> [--itags 136,140] [--license CC-BY-3.0] [--mirror <url base>]';

async function main() {
  const { id, itags, license, mirror } = cli();
  yt.refuseCookies();
  const indexPath = join(repoRoot, INDEX_FILE);
  const dir = join(repoRoot, 'data', 'yt', id);
  await mkdir(dir, { recursive: true });

  const { index, entry } = await ingestVideo({
    id,
    itags,
    license,
    dir,
    index: await readIndex(indexPath),
    yt,
    mirrors: mirror ? (itag) => [`${mirror.replace(/\/+$/, '')}/${trackFile(itag)}`] : defaultMirrors(id),
  });
  await writeIndex(indexPath, index);
  report(id, entry, dir);
}

function cli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      itags: { type: 'string' },
      license: { type: 'string' },
      mirror: { type: 'string' },
    },
  });
  const [id] = positionals;
  if (!id || !/^[\w-]{11}$/.test(id)) throw new Error(`${USAGE}\n(an id starting with "-" goes after "--")`);
  const itags = values.itags?.split(',').map((s) => Number(s.trim()));
  if (itags && (itags.length === 0 || itags.some((n) => !Number.isInteger(n) || n <= 0))) {
    throw new Error(`--itags must list itag numbers, got ${values.itags}`);
  }
  return { id, itags, license: values.license, mirror: values.mirror };
}

// Without --mirror, the tracks are expected as assets of a GitHub release
// of this repository (one per video generation), named after the origin.
function defaultMirrors(id) {
  const repo = githubRepo();
  if (repo === null) return () => [];
  return releaseMirrors(repo, id);
}

function githubRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

function report(id, entry, dir) {
  const licence = entry.licenseSource === 'operator' ? `${entry.license} (asserted by you; YouTube's field: ${entry.youtubeLicense ?? 'empty'})` : `${entry.license} (YouTube's field)`;
  console.log(`\ningested ${id} "${entry.title}" (${entry.channel}), generation ${entry.generation}, ${licence}`);
  for (const [itag, t] of Object.entries(entry.tracks)) {
    console.log(`  itag ${itag}  ${t.kind.padEnd(5)} ${t.codecs.padEnd(12)} ${String(t.size).padStart(11)} B  ${t.anchor}`);
  }
  const tag = releaseTag(id, entry.generation);
  const files = Object.keys(entry.tracks).map((itag) => relative(repoRoot, join(dir, trackFile(itag))));
  console.log(`\nfiles: ${dir}/itag*.mp4 with .proofs/ beside each`);
  console.log('next:');
  console.log(`  git add ${INDEX_FILE} && git commit -m "yt: ingest ${id}"`);
  const mirrors = Object.values(entry.tracks).flatMap((t) => t.mirrors);
  if (mirrors.some((m) => m.includes(`/releases/download/${tag}/`))) {
    console.log(`  ${releaseCommand(tag, files, entry)}`);
  } else if (mirrors.length === 0) {
    console.log('  host the track files somewhere and record the URLs as mirrors in the index (CI builds fetch them from there)');
  }
}

await main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
