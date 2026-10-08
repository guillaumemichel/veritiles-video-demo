// A track on disk as the demo publishes it: what the player will learn from
// its head, its veritiles pack, and the mirror route that fetches a track
// the index names when yt-dlp is not an option (CI runners are bot-checked).
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HEAD_MAX, mimeType, parseHead } from '../../web/mp4.js';
import { DEFAULT_CHUNK as LEAF, packFixed } from './pack-fixed.js';

// The file read, described and packed:
// { bytes, size, sha256, codecs, kind, durationSeconds, segments, anchor, map, proofs, leafCount }.
export async function packTrack(path) {
  const bytes = new Uint8Array(await readFile(path));
  const packed = packFixed(bytes);
  return { bytes, ...describeTrack(bytes), sha256: sha256Hex(bytes), anchor: packed.anchor, map: packed.mapCid, proofs: packed.proofs, leafCount: packed.leafCount };
}

// What the player reads off the head, within the player's head bound, so a
// track that fails here would fail in the browser too.
export function describeTrack(bytes) {
  const parsed = parseHead(bytes.subarray(0, HEAD_MAX));
  if (parsed === null) throw new Error('no complete sidx in the first 8 MiB — not a fragmented MP4 with a global sidx');
  return trackShape(parsed, bytes.length);
}

function trackShape({ index, codecs }, size) {
  const last = index.segments.at(-1);
  if (last.offset + last.size > size) throw new Error('sidx references run past end of file');
  return {
    size,
    codecs,
    kind: mimeType(codecs).startsWith('audio/') ? 'audio' : 'video',
    durationSeconds: index.duration,
    segments: index.segments.length,
  };
}

// A copy with one flipped byte in the middle of every 1 MiB leaf — the
// malicious mirror: whatever a reader takes from it first fails verification.
export function tampered(bytes) {
  const evil = new Uint8Array(bytes);
  for (let offset = 0; offset < evil.length; offset += LEAF) {
    evil[offset + Math.floor(Math.min(LEAF, evil.length - offset) / 2)] ^= 0xff;
  }
  return evil;
}

export async function writeProofs(dir, proofs) {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of proofs) await writeFile(join(dir, name), content);
}

// The track at `path` with the digest the index records, fetched from its
// mirrors when missing or different: bytes from anywhere, identity from the
// index. Returns 'present' or the mirror that served it.
export async function ensureTrackFile(path, { sha256, size, mirrors }, fetchFn = fetch) {
  if (await fileDigest(path) === sha256) return 'present';
  const failures = [];
  for (const mirror of mirrors) {
    try {
      const got = await downloadTo(mirror, `${path}.part`, size, fetchFn);
      if (got === sha256) {
        await rename(`${path}.part`, path);
        return mirror;
      }
      failures.push(`${mirror}: sha256 ${got} is not the index's ${sha256}`);
    } catch (err) {
      failures.push(`${mirror}: ${err.message}`);
    }
    await rm(`${path}.part`, { force: true });
  }
  const tried = failures.length ? failures.join('\n  ') : 'no mirrors listed';
  throw new Error(`cannot obtain ${path}:\n  ${tried}\n  (run yt-ingest to fetch it from YouTube, or add a mirror to yt-index.json)`);
}

// Streams the body to `path` while hashing it, never taking more than the
// `size` the index names (a mirror that streams forever fills no disk).
async function downloadTo(url, path, size, fetchFn) {
  const response = await fetchFn(url);
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
  await mkdir(join(path, '..'), { recursive: true });
  const hash = createHash('sha256');
  let received = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        received += chunk.length;
        if (received > size) throw new Error(`sent more than the index's ${size} bytes`);
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(path),
  );
  return hash.digest('hex');
}

// Hex sha256 of the file, or null when it does not exist.
export async function fileDigest(path) {
  try {
    return sha256Hex(await readFile(path));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
