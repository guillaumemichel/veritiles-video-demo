// Hand-built ISO BMFF pieces for the tests: the exact layout ffmpeg (and
// YouTube's DASH packager) emit — ftyp, moov with per-track sample entries,
// a global sidx, fragments — assembled from byte arrays.

export function u16(value) { return [value >> 8, value & 0xff]; }
export function u32(value) { return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]; }
export function u64(value) { return [...u32(Math.floor(value / 2 ** 32)), ...u32(value % 2 ** 32)]; }
export function zeros(n) { return new Array(n).fill(0); }
export function fromHex(hex) { return [...Buffer.from(hex, 'hex')]; }
export function ascii(text) { return [...text].map((c) => c.charCodeAt(0)); }

export function box(type, ...parts) {
  const payload = parts.flat();
  return [...u32(8 + payload.length), ...ascii(type), ...payload];
}

export function sidx({ version = 1, timescale, earliest, firstOffset, refs }) {
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

export const ftyp = box('ftyp', ascii('isom'));

// avcC and esds exactly as ffmpeg wrote them for the demo's Big Buck Bunny
// file (H.264 High@4.1 + AAC-LC); ffprobe reports `avc1.640029, mp4a.40.2`.
export const BBB_AVCC = '000000336176634301640029ffe1001b67640029acca501e0089f970110000030001000003003c8f18319601000568e93b2c8b';
export const BBB_ESDS = '0000003665736473000000000380808025000200048080801740150000000001f4000001f4000580808005119056e500068080800102';

// tag + length (ffmpeg's 4-byte 0x80-padded form, or the minimal single byte) + payload
export function descriptor(tag, payload, { wide = true } = {}) {
  const length = wide ? [0x80, 0x80, 0x80, payload.length] : [payload.length];
  return [tag, ...length, ...payload];
}

export function esds({ objectType = 0x40, audioSpecificConfig = [0x11, 0x90, 0x56, 0xe5, 0x00], wide = true, esFields = [...u16(2), 0] } = {}) {
  const form = { wide };
  const info = descriptor(0x05, audioSpecificConfig, form);
  const decoderConfig = descriptor(0x04, [objectType, 0x15, 0, 0, 0, ...u32(128000), ...u32(128000), ...info], form);
  const slConfig = descriptor(0x06, [0x02], form);
  const es = descriptor(0x03, [...esFields, ...decoderConfig, ...slConfig], form);
  return box('esds', [0, 0, 0, 0], es);
}

export function visualEntry(type, ...children) {
  return box(type, zeros(78), ...children);
}

export function audioEntry({ version = 0, children = [] } = {}) {
  const fields = version === 1 ? 44 : 28;
  return box('mp4a', zeros(8), u16(version), zeros(fields - 10), children);
}

export function trak(entry) {
  return box('trak', box('mdia', box('minf', box('stbl', box('stsd', [0, 0, 0, 0], u32(1), entry)))));
}

export function moov(...traks) {
  return box('moov', box('mvhd', zeros(100)), ...traks);
}

export function movie(...traks) {
  return Uint8Array.from([...ftyp, ...moov(...traks)]);
}

export const bbbVideoTrak = trak(visualEntry('avc1', fromHex(BBB_AVCC)));
export const bbbAudioTrak = trak(audioEntry({ children: fromHex(BBB_ESDS) }));
