// The sidx and codecs readers against hand-built ISO BMFF bytes: the exact
// layout ffmpeg emits (ftyp, moov, global sidx, a second per-track sidx,
// fragments), plus the failure shapes the player must refuse or retry.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mimeType, parseCodecs, parseHead, parseIndex, segmentAt } from '../web/mp4.js';
import {
  BBB_AVCC, BBB_ESDS, audioEntry, bbbAudioTrak, bbbVideoTrak, box, esds, fromHex, ftyp, movie, sidx, trak, u16, u32, visualEntry, zeros,
} from './lib/bmff.js';

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

// --- head + content type -----------------------------------------------------

test('parseHead yields index and codecs together, null while the sidx is short', () => {
  const track = sidx({ timescale: 1000, earliest: 0, firstOffset: 0, refs: [{ size: 10, duration: 1000 }] });
  const bytes = Uint8Array.from([...movie(bbbVideoTrak), ...track, ...zeros(10)]);
  const head = parseHead(bytes);
  assert.equal(head.codecs, 'avc1.640029');
  assert.equal(head.index.segments.length, 1);
  assert.equal(parseHead(bytes.subarray(0, bytes.length - 12)), null);
});

test('mimeType picks audio/mp4 only for audio-only codecs', () => {
  assert.equal(mimeType('mp4a.40.2'), 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(mimeType('avc1.640029'), 'video/mp4; codecs="avc1.640029"');
  assert.equal(mimeType('avc1.640029, mp4a.40.2'), 'video/mp4; codecs="avc1.640029, mp4a.40.2"');
});

// --- codecs ------------------------------------------------------------------

test('derives the BBB codecs string from the real avcC and esds boxes', () => {
  assert.equal(parseCodecs(movie(bbbVideoTrak, bbbAudioTrak)), 'avc1.640029, mp4a.40.2');
});

test('lists codecs in trak order', () => {
  assert.equal(parseCodecs(movie(bbbAudioTrak, bbbVideoTrak)), 'mp4a.40.2, avc1.640029');
});

test('returns null until the moov is fully buffered', () => {
  const bytes = movie(bbbVideoTrak, bbbAudioTrak);
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
