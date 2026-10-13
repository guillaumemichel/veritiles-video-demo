// Spot-checks of an untrusted range server against the index: read random
// mid-file leaves through VerifiedFile and let verification, proof descent
// and failure accounting come free. One VerifiedFile per probe — a mismatch
// bans the source for the file's lifetime, and every probe must stand alone.
import { VerificationError, VerifiedFile } from 'veritiles';

export const MiB = 1 << 20;

// The starts of k distinct mid-file MiB of a `size`-byte file; a probe
// verifies the leaf covering one. The first MiB is skipped (the head:
// moov/sidx can churn without a re-encode) and so is the partial tail;
// mid-file fragments are the high-signal region.
export function probeOffsets(size, k, random = Math.random) {
  const slots = Math.ceil(size / MiB);
  const candidates = slots > 2 ? Array.from({ length: slots - 2 }, (_, i) => i + 1) : [0];
  const picked = [];
  const pool = [...candidates];
  while (picked.length < Math.min(k, candidates.length)) {
    picked.push(...pool.splice(Math.floor(random() * pool.length), 1));
  }
  return picked.sort((a, b) => a - b).map((i) => i * MiB);
}

// The leaf covering `offset`, read through a fresh client — a one-byte
// read fetches and verifies that whole leaf, whatever its extent: 'match'
// when it verified, 'mismatch' when the source served bytes that failed
// against the anchor (even if a retry then failed for another reason),
// 'unavailable' for anything else (transport, HTTP status, expired
// delivery).
export async function probeLeaf({ cid, source, proof, fetchFn, offset }) {
  const vf = new VerifiedFile({ cid, source, proof, fetchFn });
  const started = Date.now();
  try {
    await vf.read(offset, 1);
    return { offset, result: 'match', ms: Date.now() - started };
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
