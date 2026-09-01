// Minimal ISO BMFF reader for the player: walk top-level boxes in the file
// head and decode the global `sidx` segment index that
// `ffmpeg -movflags +global_sidx` writes between `moov` and the first
// fragment. Runs unchanged in the browser and in node (build checks, tests).

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
