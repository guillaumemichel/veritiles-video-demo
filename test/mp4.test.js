// The sidx and codecs readers against hand-built ISO BMFF bytes: the exact
// layout ffmpeg emits (ftyp, moov, global sidx, a second per-track sidx,
// fragments), plus the failure shapes the player must refuse or retry.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCodecs, parseIndex, segmentAt } from '../web/mp4.js';

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

// --- codecs ------------------------------------------------------------------

function zeros(n) { return new Array(n).fill(0); }
function fromHex(hex) { return [...Buffer.from(hex, 'hex')]; }

// avcC and esds exactly as ffmpeg wrote them for the demo's Big Buck Bunny
// file (H.264 High@4.1 + AAC-LC); ffprobe reports `avc1.640029, mp4a.40.2`.
const BBB_AVCC = '000000336176634301640029ffe1001b67640029acca501e0089f970110000030001000003003c8f18319601000568e93b2c8b';
const BBB_ESDS = '0000003665736473000000000380808025000200048080801740150000000001f4000001f4000580808005119056e500068080800102';

// tag + length (ffmpeg's 4-byte 0x80-padded form, or the minimal single byte) + payload
function descriptor(tag, payload, { wide = true } = {}) {
  const length = wide ? [0x80, 0x80, 0x80, payload.length] : [payload.length];
  return [tag, ...length, ...payload];
}

function esds({ objectType = 0x40, audioSpecificConfig = [0x11, 0x90, 0x56, 0xe5, 0x00], wide = true, esFields = [...u16(2), 0] } = {}) {
  const form = { wide };
  const info = descriptor(0x05, audioSpecificConfig, form);
  const decoderConfig = descriptor(0x04, [objectType, 0x15, 0, 0, 0, ...u32(128000), ...u32(128000), ...info], form);
  const slConfig = descriptor(0x06, [0x02], form);
  const es = descriptor(0x03, [...esFields, ...decoderConfig, ...slConfig], form);
  return box('esds', [0, 0, 0, 0], es);
}

function visualEntry(type, ...children) {
  return box(type, zeros(78), ...children);
}

function audioEntry({ version = 0, children = [] } = {}) {
  const fields = version === 1 ? 44 : 28;
  return box('mp4a', zeros(8), u16(version), zeros(fields - 10), children);
}

function trak(entry) {
  return box('trak', box('mdia', box('minf', box('stbl', box('stsd', [0, 0, 0, 0], u32(1), entry)))));
}

function movie(...traks) {
  return Uint8Array.from([...ftyp, ...box('moov', box('mvhd', zeros(100)), ...traks)]);
}

const bbbVideo = trak(visualEntry('avc1', fromHex(BBB_AVCC)));
const bbbAudio = trak(audioEntry({ children: fromHex(BBB_ESDS) }));

test('derives the BBB codecs string from the real avcC and esds boxes', () => {
  assert.equal(parseCodecs(movie(bbbVideo, bbbAudio)), 'avc1.640029, mp4a.40.2');
});

test('lists codecs in trak order', () => {
  assert.equal(parseCodecs(movie(bbbAudio, bbbVideo)), 'mp4a.40.2, avc1.640029');
});

test('returns null until the moov is fully buffered', () => {
  const bytes = movie(bbbVideo, bbbAudio);
  assert.equal(parseCodecs(bytes.subarray(0, 4)), null);
  assert.equal(parseCodecs(bytes.subarray(0, ftyp.length + 8)), null);
  assert.equal(parseCodecs(bytes.subarray(0, bytes.length - 1)), null);
});

test('rejects a head with no moov before the media data', () => {
  assert.throws(() => parseCodecs(Uint8Array.from([...ftyp, ...box('moof', zeros(8))])), /no moov/);
});

test('the esds builder reproduces the real BBB box', () => {
  assert.deepEqual(esds(), fromHex(BBB_ESDS));
});

test('reads esds descriptors with single-byte lengths', () => {
  assert.equal(parseCodecs(movie(trak(audioEntry({ children: esds({ wide: false }) })))), 'mp4a.40.2');
});

test('skips the optional ES_Descriptor fields the flags announce', () => {
  // flags 0xe0: dependsOn_ES_ID(2), URLlength(1) + URLstring, OCR_ES_Id(2)
  const url = [...'url'].map((c) => c.charCodeAt(0));
  const withOptionals = esds({ esFields: [...u16(2), 0xe0, ...u16(7), url.length, ...url, ...u16(8)] });
  assert.equal(parseCodecs(movie(trak(audioEntry({ children: withOptionals })))), 'mp4a.40.2');
});

test('reads an escaped audioObjectType', () => {
  // aot 31 → 32 + the next 6 bits (10) = 42 (USAC)
  const usac = esds({ audioSpecificConfig: [0xf9, 0x40] });
  assert.equal(parseCodecs(movie(trak(audioEntry({ children: usac })))), 'mp4a.40.42');
});

test('reads a version-1 sound sample entry', () => {
  assert.equal(parseCodecs(movie(trak(audioEntry({ version: 1, children: esds() })))), 'mp4a.40.2');
  assert.throws(() => parseCodecs(movie(trak(audioEntry({ version: 2, children: esds() })))), /version 2/);
});

test('names avc3 entries after their fourcc', () => {
  assert.equal(parseCodecs(movie(trak(visualEntry('avc3', fromHex(BBB_AVCC))))), 'avc3.640029');
});

test('rejects sample entries this player cannot decode', () => {
  assert.throws(() => parseCodecs(movie(trak(visualEntry('hvc1')))), /'hvc1'.*avc1\/avc3.*mp4a/);
  const mp3 = esds({ objectType: 0x6b, audioSpecificConfig: [] });
  assert.throws(() => parseCodecs(movie(trak(audioEntry({ children: mp3 })))), /0x6b/);
});

test('rejects tracks missing their codec configuration', () => {
  assert.throws(() => parseCodecs(movie(trak(visualEntry('avc1')))), /avcC/);
  assert.throws(() => parseCodecs(movie(trak(audioEntry()))), /esds/);
});

test('rejects a trak without sample entries', () => {
  const noStsd = box('trak', box('mdia', box('minf', box('stbl'))));
  assert.throws(() => parseCodecs(movie(noStsd)), /stsd/);
  const emptyStsd = box('trak', box('mdia', box('minf', box('stbl', box('stsd', [0, 0, 0, 0], u32(0))))));
  assert.throws(() => parseCodecs(movie(emptyStsd)), /sample entries/);
});
