// The veritiles `fixed` pack profile for a single file: cut into fixed-size
// leaves, shard the leaf digests, and commit the tree in a strict DRISL
// descriptor whose sha2-256 is the anchor CID. Byte-compatible with the
// veritiles repository packer (`npm run pack -- file --profile fixed`); the
// build verifies every output through the published client, which is the
// authoritative check on this encoder.
import { createHash } from 'node:crypto';

import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { KIND_SHARD, MAX_SHARD_RECORDS, META_RECORD_SIZE, shardName } from './proof-format.js';
import { encodeMeta, encodeShard } from './proof-encode.js';

const RAW_CODE = 0x55;
const DAG_CBOR_CODE = 0x71;
const SHA2_256_CODE = 0x12;
const DESCRIPTOR_CAP = 256 * 1024; // {proof}/root body bound (veritiles SPEC §3.3)
const META_FILE_CAP = 256 * 1024;
const META_MAX_ENTRIES = Math.floor(META_FILE_CAP / META_RECORD_SIZE);

export const DEFAULT_CHUNK = 1 << 20; // 1 MiB

// bytes → { anchor, mapCid, descriptor, proofs: Map('root' | shard name), leafCount }
export function packFixed(bytes, { chunkSize = DEFAULT_CHUNK } = {}) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error(`bad chunk size ${chunkSize}`);
  if (bytes.length === 0) throw new Error('cannot pack an empty file');

  const leaves = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    leaves.push({ offset, length: chunk.length, digest: sha256(chunk) });
  }

  const shards = [];
  for (let i = 0; i < leaves.length; i += MAX_SHARD_RECORDS) {
    const group = leaves.slice(i, i + MAX_SHARD_RECORDS);
    const start = group[0].offset;
    shards.push({
      start,
      length: group.reduce((n, leaf) => n + leaf.length, 0),
      content: encodeShard(group, start),
    });
  }
  // One flat meta holds ~6.4k shards (~11.6M leaves); nesting is not needed
  // at any plausible video size, so this packer refuses rather than shapes.
  if (shards.length > META_MAX_ENTRIES) {
    throw new Error(`${shards.length} shards exceed one meta file — this packer only emits flat trees`);
  }
  const topMeta = encodeMeta(shards.map((shard) => ({
    kind: KIND_SHARD,
    length: shard.length,
    digest: sha256(shard.content),
  })));

  const mapCid = CID.createV1(RAW_CODE, Digest.create(SHA2_256_CODE, sha256(bytes)));
  const descriptor = encodeDescriptor({ mapCidBytes: mapCid.bytes, topMeta, mapSize: bytes.length });
  if (descriptor.length > DESCRIPTOR_CAP) throw new Error(`descriptor exceeds the ${DESCRIPTOR_CAP}-byte cap`);
  const anchor = CID.createV1(DAG_CBOR_CODE, Digest.create(SHA2_256_CODE, sha256(descriptor)));

  const proofs = new Map([['root', descriptor]]);
  for (const shard of shards) proofs.set(shardName(shard.start), shard.content);
  return { anchor: anchor.toString(), mapCid: mapCid.toString(), descriptor, proofs, leafCount: leaves.length };
}

// The canonical descriptor template (veritiles src/descriptor.ts, no unixfs):
//   a4 "v" <uint 1> "map" tag42(mapCid) "meta" <bytes topMeta> "mapSize" <uint>
function encodeDescriptor({ mapCidBytes, topMeta, mapSize }) {
  if (mapCidBytes.length !== 36) throw new Error('map CID must be 36 binary bytes');
  return concat([
    Uint8Array.of(0xa4, 0x61, 0x76, ...encodeUint(1), 0x63, 0x6d, 0x61, 0x70, 0xd8, 0x2a, 0x58, 0x25, 0x00),
    mapCidBytes,
    Uint8Array.of(0x64, 0x6d, 0x65, 0x74, 0x61), encodeBytesHead(topMeta.length), topMeta,
    Uint8Array.of(0x67, 0x6d, 0x61, 0x70, 0x53, 0x69, 0x7a, 0x65), encodeUint(mapSize),
  ]);
}

function encodeUint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`bad uint ${value}`);
  if (value < 24) return Uint8Array.of(value);
  if (value < 0x100) return Uint8Array.of(0x18, value);
  if (value < 0x10000) return Uint8Array.of(0x19, value >> 8, value & 0xff);
  if (value < 0x100000000) {
    return Uint8Array.of(0x1a, value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }
  const out = new Uint8Array(9);
  out[0] = 0x1b;
  for (let i = 0; i < 8; i++) out[8 - i] = Math.floor(value / 2 ** (8 * i)) & 0xff;
  return out;
}

function encodeBytesHead(length) {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff) throw new Error(`bad byte-string length ${length}`);
  if (length < 24) return Uint8Array.of(0x40 + length);
  if (length < 0x100) return Uint8Array.of(0x58, length);
  return Uint8Array.of(0x59, length >> 8, length & 0xff);
}

function sha256(bytes) {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.length; }
  return out;
}
