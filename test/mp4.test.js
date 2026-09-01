// The sidx reader against hand-built ISO BMFF bytes: the exact layout ffmpeg
// emits (ftyp, moov, global sidx, a second per-track sidx, fragments), plus
// the failure shapes the player must refuse or retry.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseIndex, segmentAt } from '../web/mp4.js';

function u16(value) { return [value >> 8, value & 0xff]; }
function u32(value) { return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]; }
function u64(value) { return [...u32(Math.floor(value / 2 ** 32)), ...u32(value % 2 ** 32)]; }

function box(type, ...parts) {
  const payload = parts.flat();
  return [...u32(8 + payload.length), ...[...type].map((c) => c.charCodeAt(0)), ...payload];
}

function sidx({ version = 1, timescale, earliest, firstOffset, refs }) {
  const wide = version === 1 ? u64 : u32;
  return box('sidx',
    [version, 0, 0, 0], // version + flags
    u32(1), // reference_ID
    u32(timescale),
    wide(earliest), wide(firstOffset),
    u16(0), u16(refs.length),
    refs.flatMap(({ size, duration, hierarchical = false }) => [
      ...u32(((hierarchical ? 1 : 0) << 31 >>> 0) | size), ...u32(duration), ...u32(0),
    ]),
  );
}

const ftyp = box('ftyp', [...'isom'].map((c) => c.charCodeAt(0)));
const moov = box('moov', new Array(20).fill(0));
const initEnd = ftyp.length + moov.length;

function stream({ version = 1 } = {}) {
  const trackSidx = sidx({ version, timescale: 30000, earliest: 0, firstOffset: 0, refs: [{ size: 3000, duration: 45000 }] });
  const globalSidx = sidx({
    version,
    timescale: 30000,
    earliest: 2000,
    firstOffset: trackSidx.length,
    refs: [{ size: 1000, duration: 30000 }, { size: 2000, duration: 15000 }],
  });
  const anchor = initEnd + globalSidx.length + trackSidx.length;
  const media = new Array(3000).fill(0xaa);
  return { bytes: Uint8Array.from([...ftyp, ...moov, ...globalSidx, ...trackSidx, ...media]), anchor };
}

for (const version of [0, 1]) {
  test(`parses a version-${version} global sidx`, () => {
    const { bytes, anchor } = stream({ version });
    const index = parseIndex(bytes);
    assert.equal(index.initEnd, initEnd);
    assert.equal(index.timescale, 30000);
    assert.deepEqual(index.segments, [
      { offset: anchor, size: 1000, time: 2000 / 30000, duration: 1 },
      { offset: anchor + 1000, size: 2000, time: 2000 / 30000 + 1, duration: 0.5 },
    ]);
    assert.equal(index.duration, 2000 / 30000 + 1.5);
  });
}

test('returns null until the sidx is fully buffered', () => {
  const { bytes } = stream();
  assert.equal(parseIndex(bytes.subarray(0, 4)), null);
  assert.equal(parseIndex(bytes.subarray(0, initEnd - 3)), null);
  assert.equal(parseIndex(bytes.subarray(0, initEnd + 10)), null);
});

test('rejects a stream with no global sidx before the fragments', () => {
  const moof = box('moof', new Array(8).fill(0));
  assert.throws(() => parseIndex(Uint8Array.from([...ftyp, ...moov, ...moof])), /global sidx/);
});

test('rejects a hierarchical sidx', () => {
  const hierarchical = sidx({
    timescale: 30000, earliest: 0, firstOffset: 0,
    refs: [{ size: 1000, duration: 30000, hierarchical: true }],
  });
  assert.throws(() => parseIndex(Uint8Array.from([...ftyp, ...moov, ...hierarchical])), /hierarchical/);
});

test('segmentAt picks the covering segment', () => {
  const segments = [{ time: 0 }, { time: 4 }, { time: 9 }];
  assert.equal(segmentAt(segments, -1), 0);
  assert.equal(segmentAt(segments, 0), 0);
  assert.equal(segmentAt(segments, 5.5), 1);
  assert.equal(segmentAt(segments, 100), 2);
});
