// Spot-checks of an untrusted range server against the index: read random
// mid-file leaves through VerifiedFile and let verification, proof descent
// and failure accounting come free. One VerifiedFile per probe — a mismatch
// bans the source for the file's lifetime, and every probe must stand alone.
import { VerificationError, VerifiedFile } from 'veritiles';

import { DEFAULT_CHUNK as LEAF } from './pack-fixed.js';

export { DEFAULT_CHUNK as LEAF } from './pack-fixed.js';

// Leaf-aligned offsets of k distinct mid-file leaves for a `size`-byte file.
// The head leaf is skipped (moov/sidx can churn without a re-encode) and so
// is the partial tail; mid-file mdat leaves are the high-signal region.
export function probeOffsets(size, k, random = Math.random) {
  const leaves = Math.ceil(size / LEAF);
  const candidates = leaves > 2 ? Array.from({ length: leaves - 2 }, (_, i) => i + 1) : [0];
  const picked = [];
  const pool = [...candidates];
  while (picked.length < Math.min(k, candidates.length)) {
    picked.push(...pool.splice(Math.floor(random() * pool.length), 1));
  }
  return picked.sort((a, b) => a - b).map((i) => i * LEAF);
}

// One leaf read through a fresh client: 'match' when it verified,
// 'mismatch' when the source served bytes that failed against the anchor
// (even if a retry then failed for another reason), 'unavailable' for
// anything else (transport, HTTP status, expired delivery).
export async function probeLeaf({ cid, source, proof, fetchFn, offset }) {
  const vf = new VerifiedFile({ cid, source, proof, fetchFn });
  const started = Date.now();
  try {
    const bytes = await vf.read(offset, LEAF);
    return { offset, result: 'match', bytes: bytes.length, ms: Date.now() - started };
  } catch (err) {
    const result = vf.stats.rejected > 0 || isVerificationFailure(err) ? 'mismatch' : 'unavailable';
    return { offset, result, detail: rootMessage(err), ms: Date.now() - started };
  }
}

// { size, probes }: the size from the verified descriptor, then k probes.
// Proof files are fetched once and replayed to every probe's fresh client,
// so a verification failure can only come from the content source.
export async function probeTrack({ cid, source, proof, fetchFn, k = 3, random }) {
  const replay = replayingFetch(fetchFn, proof);
  const opener = new VerifiedFile({ cid, source, proof, fetchFn: replay });
  await opener.ready(); // proofs only — the descriptor, verified against the anchor
  const probes = [];
  for (const offset of probeOffsets(opener.size, k, random)) {
    probes.push(await probeLeaf({ cid, source, proof, fetchFn: replay, offset }));
  }
  return { size: opener.size, probes };
}

function replayingFetch(fetchFn, proof) {
  const cache = new Map();
  return async (input, init) => {
    const url = String(input);
    if (!url.startsWith(`${proof}/`)) return fetchFn(input, init);
    if (!cache.has(url)) {
      const response = await fetchFn(input, init);
      if (!response.ok) return response;
      cache.set(url, new Uint8Array(await response.arrayBuffer()));
    }
    return new Response(cache.get(url).slice(), { status: 200 });
  };
}

export function isVerificationFailure(err) {
  if (err instanceof VerificationError) return true;
  return err instanceof AggregateError && err.errors.some(isVerificationFailure);
}

// The root cause's message, with any signed URL (a delivery is signed for
// the resolving IP) cut out — this text reaches the operator's terminal.
export function rootMessage(err) {
  if (err instanceof AggregateError && err.errors.length > 0) return rootMessage(err.errors[0]);
  return (err?.message ?? String(err)).replace(/\bhttps?:\/\/[^\s?#]+\?\S*?(?=:?(?:\s|$))/g, '<signed URL>');
}
