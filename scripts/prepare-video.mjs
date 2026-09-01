#!/usr/bin/env node
// Produce data/bbb.mp4 (fragmented MP4 with a global sidx) and data/bbb.json
// (its MSE codec string and shape) from the Blender Foundation's Big Buck
// Bunny release. Idempotent: skips everything once the outputs exist, so CI
// caches data/ and rebuilds touch nothing. Requires ffmpeg/ffprobe and unzip.
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ZIP_URL = 'https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip';
const SOURCE_NAME = 'bbb_sunflower_1080p_30fps_normal.mp4';

// Copy the H.264 track untouched; re-encode the stereo MP3 to AAC (the one
// audio codec MSE supports everywhere) and drop the AC-3 5.1 track. Fragment
// on keyframes at least 2 s apart, with the whole-file sidx up front so the
// player learns every segment's byte range from the first verified leaf.
const FFMPEG_ARGS = [
  '-map', '0:v:0', '-map', '0:a:0',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof+global_sidx',
  '-min_frag_duration', '2000000',
];

const dataDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'data');
const zipPath = join(dataDir, 'bbb.zip');
const sourcePath = join(dataDir, SOURCE_NAME);
const videoPath = join(dataDir, 'bbb.mp4');
const metaPath = join(dataDir, 'bbb.json');

async function main() {
  await mkdir(dataDir, { recursive: true });
  if (await exists(videoPath) && await exists(metaPath)) {
    console.log(`data/bbb.mp4 and data/bbb.json exist — nothing to do`);
    return;
  }
  if (!(await exists(sourcePath))) {
    if (!(await exists(zipPath))) await download(ZIP_URL, zipPath);
    run('unzip', ['-o', zipPath, SOURCE_NAME, '-d', dataDir]);
  }
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath, ...FFMPEG_ARGS, videoPath]);
  await writeFile(metaPath, `${JSON.stringify(await describe(videoPath), null, 2)}\n`);
  // Keep only the outputs: the zip and source exist to be remuxed once, and
  // dropping them keeps the CI cache at the remuxed file alone.
  await rm(zipPath, { force: true });
  await rm(sourcePath, { force: true });
  console.log(`data/bbb.mp4 ready (${(await stat(videoPath)).size} bytes)`);
}

async function download(url, path) {
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new Error(`download failed: ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}

// The MSE codec string and shape the page needs, derived from the remuxed
// file so a codec drift in the pipeline fails the build instead of the demo.
async function describe(path) {
  const probe = JSON.parse(run('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path,
  ], { capture: true }));
  const [video, audio, extra] = probe.streams;
  if (extra !== undefined || video?.codec_name !== 'h264' || audio?.codec_name !== 'aac') {
    throw new Error(`expected exactly h264 + aac, found: ${probe.streams.map((s) => s.codec_name).join(', ')}`);
  }
  const profiles = { High: '64', Main: '4d', Baseline: '42', 'Constrained Baseline': '42' };
  const profile = profiles[video.profile];
  if (profile === undefined) throw new Error(`unmapped H.264 profile ${video.profile}`);
  const level = Number(video.level);
  if (!Number.isInteger(level) || level < 10 || level > 62) throw new Error(`bad H.264 level ${video.level}`);
  return {
    codecs: `avc1.${profile}00${level.toString(16).padStart(2, '0')}, mp4a.40.2`,
    sizeBytes: (await stat(path)).size,
    durationSeconds: Number(probe.format.duration),
  };
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return capture ? result.stdout.toString() : '';
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

await main();
