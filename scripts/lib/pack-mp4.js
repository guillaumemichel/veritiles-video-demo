// The veritiles `mp4` pack profile for a fragmented MP4: one leaf for the
// init section (ftyp, moov, the global sidx), one per fragment, and one for
// any boxes after the last fragment; the leaf digests sharded and committed
// in a strict DRISL descriptor whose sha2-256 is the anchor CID. A player
// that reads a fragment at the range its sidx lists reads exactly one leaf.
// Byte-compatible with the veritiles v0.5 repository packer (`npm run pack
// -- file.mp4`, which picks this profile for a fragmented MP4); the build
// verifies every output through the published client, which is the
// authoritative check on this encoder.
import { createHash } from 'node:crypto';

import { createBLAKE3 } from 'hash-wasm';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { KIND_SHARD, MAX_SHARD_RECORDS, META_RECORD_SIZE, shardName } from './proof-format.js';
import { encodeMeta, encodeShard } from './proof-encode.js';

const RAW_CODE = 0x55;
const DAG_CBOR_CODE = 0x71;
const SHA2_256_CODE = 0x12;
const BLAKE3_CODE = 0x1e; // the map only: it names the file, no client recomputes it
const DESCRIPTOR_CAP = 256 * 1024; // {proof}/root body bound (veritiles SPEC §3.3)
// The top meta is a descriptor byte string, whose DRISL head carries at
// most a 2-byte length.
const TOP_META_MAX_ENTRIES = Math.floor(0xffff / META_RECORD_SIZE);
// Boxes that open a media segment ahead of its moof; they travel with it.
const SEGMENT_BOXES = new Set(['styp', 'emsg', 'prft']);

// bytes → { anchor, mapCid, descriptor, proofs: Map(shard name | 'root'), leafCount }
export async function packMp4(bytes) {
  const leaves = mp4Leaves(bytes).map(({ offset, length }) => (
    { offset, length, digest: sha256(bytes.subarray(offset, offset + length)) }
  ));

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
  // The top meta lists ~1.6k shards (~2.9M fragments) directly; nesting is
  // not needed at any plausible video size, so this packer refuses rather
  // than shapes.
  if (shards.length > TOP_META_MAX_ENTRIES) {
    throw new Error(`${shards.length} shards exceed the top meta — this packer only emits flat trees`);
  }
  const topMeta = encodeMeta(shards.map((shard) => ({
    kind: KIND_SHARD,
    length: shard.length,
    digest: sha256(shard.content),
  })));

  const mapCid = CID.createV1(RAW_CODE, Digest.create(BLAKE3_CODE, (await createBLAKE3()).update(bytes).digest('binary')));
  const descriptor = encodeDescriptor({ mapCidBytes: mapCid.bytes, topMeta, mapSize: bytes.length });
  if (descriptor.length > DESCRIPTOR_CAP) throw new Error(`descriptor exceeds the ${DESCRIPTOR_CAP}-byte cap`);
  const anchor = CID.createV1(DAG_CBOR_CODE, Digest.create(SHA2_256_CODE, sha256(descriptor)));

  // `root` comes last, so a directory written in this order that has it has
  // every file it names.
  const proofs = new Map(shards.map((shard) => [shardName(shard.start), shard.content]));
  proofs.set('root', descriptor);
  return { anchor: anchor.toString(), mapCid: mapCid.toString(), descriptor, proofs, leafCount: leaves.length };
}

// The profile's leaves, [{ offset, length }] in file order: everything
// before the first fragment; each fragment — its moof and mdats, with any
// segment boxes before the moof; the boxes after the last mdat (an mfra).
export function mp4Leaves(bytes) {
  const starts = [0];
  let fragmented = false;
  let segmentStart = null; // where the run of segment boxes before this box began
  let previous = '';
  for (const box of topLevelBoxes(bytes)) {
    if (box.offset === 0 && box.type !== 'ftyp') break;
    if (!fragmented && box.type === 'moof') {
      fragmented = true;
      starts.push(segmentStart ?? box.offset);
    } else if (fragmented && previous === 'mdat' && box.type !== 'mdat') {
      starts.push(box.offset);
    }
    segmentStart = SEGMENT_BOXES.has(box.type) ? (segmentStart ?? box.offset) : null;
    previous = box.type;
  }
  if (!fragmented) throw new Error('not a fragmented MP4: expected an ftyp box first, then a moof');
  return starts.map((offset, i) => ({ offset, length: (starts[i + 1] ?? bytes.length) - offset }));
}

function* topLevelBoxes(bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const box = boxAt(bytes, offset);
    yield box;
    offset += box.size;
  }
}

// The box at `offset` (ISO/IEC 14496-12 §4.2): a 32-bit size; or 1 and a
// 64-bit size after the type; or 0 for a box that runs to the end of the
// file.
function boxAt(bytes, offset) {
  const remaining = bytes.length - offset;
  const fail = (problem) => new Error(`MP4 box at ${offset} ${problem}`);
  if (remaining < 8) throw fail('has a truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, remaining);
  const size32 = view.getUint32(0);
  const large = size32 === 1;
  if (large && remaining < 16) throw fail('has a truncated header');
  const size = large ? Number(view.getBigUint64(8)) : size32 === 0 ? remaining : size32;
  if (size < (large ? 16 : 8)) throw fail('has an invalid size');
  if (size > remaining) throw fail('extends past the end of the file');
  return { offset, size, type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) };
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
