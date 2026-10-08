// Minimal ISO BMFF reader for the player: walk top-level boxes in the file
// head, decode the global `sidx` segment index that
// `ffmpeg -movflags +global_sidx` writes between `moov` and the first
// fragment, and derive the MSE codecs string from the `moov` sample entries.
// Runs unchanged in the browser and in node (build checks, tests).

// The player's bound on where the global sidx may end.
export const HEAD_MAX = 8 * 1024 * 1024;

// bytes: the file head, from offset 0. Returns null when the head is too
// short to reach a complete sidx (caller reads more and retries); throws on
// streams this player cannot use.
export function parseIndex(bytes) {
  let pos = 0;
  let moovEnd = -1;
  while (true) {
    const box = readBoxHeader(bytes, pos);
    if (box === null) return null;
    if (box.type === 'moof' || box.type === 'mdat') {
      throw new Error('no global sidx before the first fragment — re-mux with -movflags +global_sidx');
    }
    if (box.type === 'sidx') {
      if (moovEnd < 0) throw new Error('sidx before moov');
      if (box.end > bytes.length) return null;
      return buildIndex(bytes, box, moovEnd);
    }
    if (box.type === 'moov') moovEnd = box.end;
    if (box.end > bytes.length) return null;
    pos = box.end;
  }
}

// {type, start, end} for the box at pos; null when 8–16 header bytes are
// not buffered yet, or when pos is exactly the end of the buffer.
function readBoxHeader(bytes, pos) {
  if (pos + 8 > bytes.length) return null;
  const dv = view(bytes);
  let size = dv.getUint32(pos);
  let headerSize = 8;
  if (size === 1) {
    if (pos + 16 > bytes.length) return null;
    size = toNumber(dv.getBigUint64(pos + 8), 'box size');
    headerSize = 16;
  }
  if (size === 0) throw new Error('open-ended box (size 0) is unsupported');
  if (size < headerSize) throw new Error(`bad box size ${size}`);
  const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
  return { type, start: pos, end: pos + size };
}

// The first sidx indexes the whole presentation: with muxed fragments each
// reference spans one moof+mdat pair (ffmpeg writes a second, per-track sidx
// right after; its bytes sit inside first_offset and are simply skipped).
function buildIndex(bytes, sidxBox, moovEnd) {
  const dv = view(bytes);
  const version = bytes[sidxBox.start + 8];
  if (version > 1) throw new Error(`unsupported sidx version ${version}`);
  let p = sidxBox.start + 12;
  p += 4; // reference_ID
  const timescale = dv.getUint32(p); p += 4;
  if (timescale === 0) throw new Error('sidx timescale is zero');
  let earliest, firstOffset;
  if (version === 0) {
    earliest = dv.getUint32(p); p += 4;
    firstOffset = dv.getUint32(p); p += 4;
  } else {
    earliest = toNumber(dv.getBigUint64(p), 'earliest_presentation_time'); p += 8;
    firstOffset = toNumber(dv.getBigUint64(p), 'first_offset'); p += 8;
  }
  p += 2; // reserved
  const count = dv.getUint16(p); p += 2;
  if (count === 0) throw new Error('sidx has no references');
  if (p + count * 12 > sidxBox.end) throw new Error('sidx references overflow the box');

  const segments = [];
  let offset = sidxBox.end + firstOffset;
  let time = earliest;
  for (let i = 0; i < count; i++) {
    const word = dv.getUint32(p); p += 4;
    const duration = dv.getUint32(p); p += 4;
    p += 4; // SAP flags
    if (word >>> 31) throw new Error('hierarchical sidx (reference_type 1) is unsupported');
    const size = word & 0x7fffffff;
    if (size === 0) throw new Error('sidx reference with zero size');
    segments.push({ offset, size, time: time / timescale, duration: duration / timescale });
    offset += size;
    time += duration;
  }
  return { initEnd: moovEnd, timescale, segments, duration: time / timescale };
}

// bytes: the file head, from offset 0, with the complete moov buffered (the
// player calls this once parseIndex has succeeded). Returns the MSE codecs
// string for `video/mp4; codecs="…"`, one entry per trak in file order;
// null when the head ends before the moov is complete; throws on tracks
// this player cannot decode.
export function parseCodecs(bytes) {
  const moov = findMoov(bytes);
  if (moov === null) return null;
  const codecs = [];
  for (const box of children(bytes, moov.start + 8, moov.end)) {
    if (box.type === 'trak') codecs.push(trackCodec(bytes, box));
  }
  if (codecs.length === 0) throw new Error('moov has no trak');
  return codecs.join(', ');
}

// The top-level moov; null while the head ends before it is complete.
function findMoov(bytes) {
  let pos = 0;
  while (true) {
    const box = readBoxHeader(bytes, pos);
    if (box === null) return null;
    if (box.type === 'moov') return box.end > bytes.length ? null : box;
    if (box.type === 'sidx' || box.type === 'moof' || box.type === 'mdat') {
      throw new Error('no moov box before the media data');
    }
    pos = box.end;
  }
}

// Yields the boxes laid out back to back in [start, end).
function* children(bytes, start, end) {
  let pos = start;
  while (pos < end) {
    const box = readBoxHeader(bytes, pos);
    if (box === null || box.end > end) throw new Error(`box at ${pos} overflows its parent`);
    yield box;
    pos = box.end;
  }
}

function findChild(bytes, start, end, type) {
  for (const box of children(bytes, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

// trak → mdia → minf → stbl → stsd (a FullBox: version/flags, entry_count,
// then the sample entries), decoding the first entry.
function trackCodec(bytes, trak) {
  let box = trak;
  for (const type of ['mdia', 'minf', 'stbl', 'stsd']) {
    box = findChild(bytes, box.start + 8, box.end, type);
    if (box === null) throw new Error(`trak has no ${type} box`);
  }
  const [entry] = children(bytes, box.start + 16, box.end);
  if (entry === undefined) throw new Error('stsd has no sample entries');
  return sampleEntryCodec(bytes, entry);
}

function sampleEntryCodec(bytes, entry) {
  if (entry.type === 'avc1' || entry.type === 'avc3') return avcCodec(bytes, entry);
  if (entry.type === 'mp4a') return aacCodec(bytes, entry);
  throw new Error(`unsupported sample entry '${entry.type}' — this player handles H.264 (avc1/avc3) + AAC (mp4a); re-mux with the ffmpeg recipe in the README`);
}

// Fixed fields between a sample entry's box header and its child boxes.
const VISUAL_ENTRY_FIELDS = 78;

function audioEntryFields(version) {
  if (version === 0) return 28;
  if (version === 1) return 44;
  throw new Error(`unsupported mp4a sample entry version ${version} (QuickTime v2 layout)`);
}

// <fourcc>.PPCCLL: profile, constraint flags and level, straight from avcC.
function avcCodec(bytes, entry) {
  const avcC = findChild(bytes, entry.start + 8 + VISUAL_ENTRY_FIELDS, entry.end, 'avcC');
  if (avcC === null) throw new Error(`${entry.type} sample entry has no avcC`);
  if (avcC.end - avcC.start < 12) throw new Error('avcC too short');
  const fields = bytes.subarray(avcC.start + 9, avcC.start + 12); // after configurationVersion
  return `${entry.type}.${Array.from(fields, hex).join('')}`;
}

// mp4a.40.<audioObjectType>; the object type sits in the AudioSpecificConfig
// nested three descriptors deep in esds.
function aacCodec(bytes, entry) {
  const version = view(bytes).getUint16(entry.start + 16); // after reserved + data_reference_index
  const esds = findChild(bytes, entry.start + 8 + audioEntryFields(version), entry.end, 'esds');
  if (esds === null) throw new Error('mp4a sample entry has no esds');
  return `mp4a.40.${audioObjectType(bytes, esds)}`;
}

const ES_DESCRIPTOR = 0x03;
const DECODER_CONFIG_DESCRIPTOR = 0x04;
const DECODER_SPECIFIC_INFO = 0x05;
const AAC_OBJECT_TYPE_INDICATION = 0x40;

function audioObjectType(bytes, esds) {
  const es = readDescriptor(bytes, esds.start + 12, esds.end, ES_DESCRIPTOR); // after version/flags
  const config = readDescriptor(bytes, skipEsFields(bytes, es), es.end, DECODER_CONFIG_DESCRIPTOR);
  if (config.start === config.end) throw new Error('empty DecoderConfigDescriptor');
  const objectType = bytes[config.start];
  if (objectType !== AAC_OBJECT_TYPE_INDICATION) {
    throw new Error(`unsupported audio codec (objectTypeIndication 0x${hex(objectType)}) — this player handles AAC (0x40); re-mux with the ffmpeg recipe in the README`);
  }
  // objectTypeIndication(1) streamType(1) bufferSizeDB(3) maxBitrate(4) avgBitrate(4)
  const info = readDescriptor(bytes, config.start + 13, config.end, DECODER_SPECIFIC_INFO);
  if (info.end - info.start < 2) throw new Error('AudioSpecificConfig too short');
  const aot = bytes[info.start] >> 3;
  if (aot !== 31) return aot;
  return 32 + ((view(bytes).getUint16(info.start) >> 5) & 0x3f); // escaped: 6 more bits
}

// ES_Descriptor: ES_ID(2), flags(1), then the optional fields the flags announce.
function skipEsFields(bytes, es) {
  if (es.end - es.start < 3) throw new Error('ES_Descriptor too short');
  const flags = bytes[es.start + 2];
  let p = es.start + 3;
  if (flags & 0x80) p += 2; // dependsOn_ES_ID
  if (flags & 0x40) p += 1 + bytes[p]; // URLlength + URLstring
  if (flags & 0x20) p += 2; // OCR_ES_Id
  return p;
}

// {start, end} of the payload of the MPEG-4 descriptor at pos, which must
// carry `tag`: one tag byte, then the length in 7-bit groups with the high
// bit set while more follow (ffmpeg always writes four).
function readDescriptor(bytes, pos, end, tag) {
  if (pos + 2 > end) throw new Error(`esds descriptor 0x${hex(tag)} is missing`);
  if (bytes[pos] !== tag) throw new Error(`expected esds descriptor 0x${hex(tag)}, found 0x${hex(bytes[pos])}`);
  let p = pos + 1;
  let length = 0;
  for (let i = 0; i < 4; i++) {
    const byte = bytes[p++];
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  if (p + length > end) throw new Error(`esds descriptor 0x${hex(tag)} overflows its parent`);
  return { start: p, end: p + length };
}

function hex(byte) {
  return byte.toString(16).padStart(2, '0');
}

// Everything the player learns from a file head: the segment index and the
// codecs. Null while the head is too short for a complete sidx — the moov
// that precedes it is then complete by construction.
export function parseHead(bytes) {
  const index = parseIndex(bytes);
  return index === null ? null : { index, codecs: parseCodecs(bytes) };
}

// The MSE content type for a codecs string: an audio-only track is
// `audio/mp4`, anything carrying video is `video/mp4`.
export function mimeType(codecs) {
  const audioOnly = codecs.split(', ').every((codec) => codec.startsWith('mp4a'));
  return `${audioOnly ? 'audio' : 'video'}/mp4; codecs="${codecs}"`;
}

// The last segment whose start time is at or before t (first segment when t
// precedes the timeline).
export function segmentAt(segments, t) {
  let found = 0;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].time <= t) found = i;
    else break;
  }
  return found;
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toNumber(big, label) {
  const value = Number(big);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} exceeds 2^53`);
  return value;
}
