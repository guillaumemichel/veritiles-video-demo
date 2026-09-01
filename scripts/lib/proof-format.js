// Build-side constants for the veritiles proof format (the sharded
// `.proofs/` tree beside every published file). This is the publisher half
// of the wire contract; the browser-side decoder ships in the veritiles
// library, which reads exactly this layout (its src/proof-format.ts).
//
//   shard file := ( u32le(relativeOffset) digest32 )+           fixed 36 B records
//   meta file  := ( kind:u8 u64le(rangeLength ≥ 1) digest32 )+  fixed 41 B records

export const DIGEST_LENGTH = 32;
export const SHARD_RECORD_SIZE = 4 + DIGEST_LENGTH;
export const SHARD_FILE_CAP = 64 * 1024; // hard limit on shard file size
export const MAX_SHARD_RECORDS = Math.floor(SHARD_FILE_CAP / SHARD_RECORD_SIZE);
export const META_RECORD_SIZE = 1 + 8 + DIGEST_LENGTH;
export const KIND_SHARD = 0;
export const KIND_DIR = 1;

// Filename convention: lowercase hex of the absolute start offset, unpadded.
export function shardName(startOffset) {
  return startOffset.toString(16);
}
