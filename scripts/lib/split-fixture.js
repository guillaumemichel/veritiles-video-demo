// The dual-track fixture for the browser check: Big Buck Bunny's video and
// audio as separate fragmented tracks — the shape of a YouTube itag pair —
// split once with ffmpeg into data/split/ and packed on every run, so the
// multi-track player is exercised without any YouTube access.
import { spawnSync } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { packTrack, writeProofs } from './tracks.js';

const TRACKS = {
  'video.mp4': ['-map', '0:v:0', '-movflags', '+frag_keyframe+empty_moov+default_base_moof+global_sidx', '-min_frag_duration', '2000000'],
  'audio.mp4': ['-map', '0:a:0', '-movflags', '+empty_moov+default_base_moof+global_sidx', '-frag_duration', '5000000'],
};

// → { dir, tracks: [{ file, cid, kind }] }, video first.
export async function ensureSplitFixture(dataDir) {
  const dir = join(dataDir, 'split');
  await mkdir(dir, { recursive: true });
  const tracks = [];
  for (const [file, args] of Object.entries(TRACKS)) {
    const path = join(dir, file);
    if (!(await exists(path))) split(join(dataDir, 'bbb.mp4'), args, path);
    const packed = await packTrack(path);
    await writeProofs(`${path}.proofs`, packed.proofs);
    tracks.push({ file, cid: packed.anchor, kind: packed.kind });
  }
  return { dir, tracks };
}

function split(source, args, out) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-c', 'copy', ...args, out], { stdio: 'inherit' });
  if (result.error) throw new Error(`ffmpeg failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ffmpeg exited with ${result.status}`);
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}
