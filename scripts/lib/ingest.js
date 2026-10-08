// Deterministic ingest of a YouTube video's pristine tracks: download each
// itag twice and demand identical bytes, describe and pack the track, and
// record its identity — anchor, digest, recipe — in the index. The yt-dlp
// calls are injected so the whole flow runs in tests.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { fileDigest, packTrack, writeProofs } from './tracks.js';
import { recipe, watchUrl } from './yt-dlp.js';
import { INDEX_FILE, nextGeneration, trackFile, upsertVideo } from './yt-index.js';

// The one licence YouTube's "reuse allowed" option grants.
export const YOUTUBE_CC_LICENSE = 'CC-BY-3.0';
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

// { id, itags?, license?, dir, index, yt: { version, metadata, download },
//   mirrors: (itag, generation) → string[], now } → { index, entry }.
// Without `itags` the best H.264 + AAC pair is chosen; without `license`
// YouTube's own licence field must grant reuse, with it the operator asserts
// the licence (the rights holder states it elsewhere, or it is their own).
export async function ingestVideo({ id, itags, license, dir, index, yt, mirrors = () => [], now = () => new Date() }) {
  const tool = await yt.version();
  const meta = await yt.metadata(id);
  const chosen = itags ?? chooseItags(meta.formats);
  const offered = meta.formats.map((f) => f.itag);
  const missing = chosen.filter((itag) => !offered.includes(itag));
  if (missing.length > 0) {
    throw new Error(`${id} does not offer itag ${missing.join(', ')} — offered: ${offered.join(', ')}`);
  }
  if (license !== undefined && !SPDX_ID.test(license)) {
    throw new Error(`--license wants an SPDX id such as CC-BY-3.0, got "${license}"`);
  }
  const asserted = license !== undefined;
  const granted = asserted ? license : youtubeGrant(id, meta.license);

  const packed = {};
  for (const itag of chosen) packed[itag] = await ingestTrack({ id, itag, dir, yt });
  const entry = {
    title: meta.title,
    channel: meta.channel,
    channelId: meta.channelId,
    url: watchUrl(id),
    license: granted,
    licenseSource: asserted ? 'operator' : 'youtube',
    youtubeLicense: meta.license,
    uploadDate: meta.uploadDate,
    durationSeconds: meta.durationSeconds,
    tracks: packed,
    recipe: chosen.flatMap((itag) => recipe(id, itag)),
    tools: { 'yt-dlp': tool },
    ingestedAt: now().toISOString().slice(0, 10), // the day only: a time of day says when the operator was online
  };
  // The mirror URLs name the generation the new anchors will get.
  const generation = nextGeneration(index, id, entry);
  const tracks = Object.fromEntries(chosen.map((itag) => [itag, { ...packed[itag], mirrors: mirrors(itag, generation) }]));
  const updated = upsertVideo(index, id, { ...entry, tracks });
  return { index: updated, entry: updated.videos[id] };
}

// Two independent downloads must agree byte for byte — the gold check that
// the CID claim is tool-independent. Both files are kept when they differ.
async function ingestTrack({ id, itag, dir, yt }) {
  const path = join(dir, trackFile(itag));
  const again = `${path}.again`;
  await yt.download(id, itag, path);
  await yt.download(id, itag, again);
  const [first, second] = await Promise.all([fileDigest(path), fileDigest(again)]);
  if (first === null || first !== second) {
    throw new Error(`${id} itag ${itag}: two downloads differ (sha256 ${first} vs ${second}; both kept in ${dir}) — the bytes are not reproducible, stop and re-plan`);
  }
  await rm(again);
  const packed = await packTrack(path);
  await writeProofs(`${path}.proofs`, packed.proofs);
  const { kind, codecs, size, sha256, durationSeconds, anchor } = packed;
  return { kind, codecs, size, sha256, durationSeconds, anchor };
}

// The universal MSE pair: the tallest H.264 video-only track and AAC-LC
// audio (itag 140 when offered).
export function chooseItags(formats) {
  const video = formats.filter((f) => f.vcodec.startsWith('avc1') && f.acodec === 'none').sort((a, b) => b.height - a.height)[0];
  const audio = formats.find((f) => f.itag === 140) ?? formats.find((f) => f.vcodec === 'none' && f.acodec.startsWith('mp4a.40.2'));
  if (video === undefined || audio === undefined) throw new Error('no H.264 video + AAC audio pair offered — pass --itags');
  return [video.itag, audio.itag];
}

// YouTube's own licence field, as yt-dlp reads it: the gate on
// redistribution when the operator asserts nothing. Uploader-controlled
// text (the description) never reaches it.
function youtubeGrant(id, field) {
  if (isCreativeCommons(field)) return YOUTUBE_CC_LICENSE;
  throw new Error(`${id}: YouTube's licence field says ${field ? `"${field}"` : 'nothing'}, not Creative Commons — pass --license <spdx> only if the rights holder grants it elsewhere (or it is your own upload)`);
}

export function isCreativeCommons(license) {
  return /creative commons/i.test(license ?? '');
}

// Where a GitHub release of the tracks would put them: one release per
// video generation, the track files as its assets.
export function releaseTag(id, generation) {
  return generation > 1 ? `yt-${id}-g${generation}` : `yt-${id}`;
}

// The `gh release create` an operator pastes: the title and channel are
// uploader-controlled, so every free-form word is single-quoted.
export function releaseCommand(tag, files, entry) {
  const notes = `${entry.title} by ${entry.channel}, ${entry.license}: the tracks YouTube serves for ${entry.url}, byte for byte; anchors in ${INDEX_FILE}`;
  return `gh release create ${tag} ${files.map(shellQuote).join(' ')} --notes ${shellQuote(notes)}`;
}

export function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function releaseMirrors(repo, id) {
  return (itag, generation) => [`https://github.com/${repo}/releases/download/${releaseTag(id, generation)}/${trackFile(itag)}`];
}
