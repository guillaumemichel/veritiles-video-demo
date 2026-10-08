// A synthetic single-track file shaped like a YouTube DASH itag: ftyp, a
// moov carrying one avc1 or mp4a sample entry, a global sidx, then the
// fragments' bytes (pseudo-random — nothing here decodes them, they only
// have to be exactly what the index says). Deterministic for a given seed.
import { bbbAudioTrak, bbbVideoTrak, ftyp, moov, sidx } from './bmff.js';

export { tampered } from '../../scripts/lib/tracks.js';

export const MiB = 1 << 20;

// A reproducible generator (xorshift32): () → the next 32-bit state.
export function xorshift32(seed = 1) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return x >>> 0;
  };
}

// Pseudo-random bytes, reproducible for a seed.
export function pseudoRandom(size, seed = 1) {
  const next = xorshift32(seed);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = next() & 0xff;
  return out;
}

// A reproducible stand-in for Math.random.
export function seededRandom(seed = 1) {
  const next = xorshift32(seed);
  return () => next() / 2 ** 32;
}

// { bytes, size, codecs, segments } for a track of `segments` fragments of
// `segmentSize` bytes, `segmentSeconds` each.
export function syntheticTrack({ kind = 'video', segments = 4, segmentSize = MiB - 1234, segmentSeconds = 5, seed = 1 } = {}) {
  const timescale = 1000;
  const refs = Array.from({ length: segments }, () => ({ size: segmentSize, duration: segmentSeconds * timescale }));
  const head = [...ftyp, ...moov(kind === 'audio' ? bbbAudioTrak : bbbVideoTrak), ...sidx({ timescale, earliest: 0, firstOffset: 0, refs })];
  const media = pseudoRandom(segments * segmentSize, seed);
  const bytes = new Uint8Array(head.length + media.length);
  bytes.set(head, 0);
  bytes.set(media, head.length);
  return { bytes, size: bytes.length, codecs: kind === 'audio' ? 'mp4a.40.2' : 'avc1.640029', segments };
}

// A fetch over in-memory files: plain GETs for proof files, single-Range 206
// for content — the same dumb-host shape the real servers answer with.
// files: Map(url → bytes); proofs: Map(base url → Map(name → bytes)).
export function memFetch({ files = new Map(), proofs = new Map() } = {}) {
  return async (input, init) => {
    const url = String(input);
    for (const [base, dir] of proofs) {
      if (!url.startsWith(`${base}/`)) continue;
      const body = dir.get(url.slice(base.length + 1));
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(new Uint8Array(body), { status: 200 });
    }
    const content = files.get(url);
    if (content === undefined) return new Response('not found', { status: 404 });
    const range = init?.headers?.Range ?? init?.headers?.range;
    const match = range === undefined ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) return new Response(new Uint8Array(content), { status: 200 });
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]) + 1, content.length);
    return new Response(new Uint8Array(content.subarray(start, end)), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end - 1}/${content.length}` },
    });
  };
}
