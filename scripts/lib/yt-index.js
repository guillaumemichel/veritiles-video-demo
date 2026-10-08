// The trusted naming layer: yt-index.json maps a YouTube video to the
// anchor CIDs of its pristine tracks. It is committed to git — the commit is
// what a reader trusts, and anyone can re-derive every anchor from the
// recipe it records. Locations (mirrors) sit beside identity but are never
// trusted: every byte from them is verified against the anchor.
import { readFile, writeFile } from 'node:fs/promises';

export const INDEX_FILE = 'yt-index.json';
const VIDEO_ID = /^[\w-]{11}$/;

export function trackFile(itag) {
  return `itag${itag}.mp4`;
}

export async function readIndex(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { videos: {} };
    throw err;
  }
  const index = JSON.parse(text);
  if (typeof index?.videos !== 'object' || index.videos === null) throw new Error(`${path}: expected { "videos": { … } }`);
  for (const [id, entry] of Object.entries(index.videos)) assertVideo(id, entry);
  return index;
}

export async function writeIndex(path, index) {
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`);
}

// The generation `entry` gets: the earlier row's while the anchors are the
// same, the next one when they changed — a re-encode on YouTube's side names
// new bytes, it never invalidates the old.
export function nextGeneration(index, id, entry) {
  const previous = index.videos[id];
  if (previous === undefined) return 1;
  return sameAnchors(previous, entry) ? previous.generation : previous.generation + 1;
}

// A new index with `entry` in place of any earlier row for the video. A
// same-bytes re-ingest keeps the generation and any mirrors added by hand;
// new anchors keep the earlier row as history.
export function upsertVideo(index, id, entry) {
  const previous = index.videos[id];
  const generation = nextGeneration(index, id, entry);
  if (previous === undefined) return withVideo(index, id, { ...entry, generation });
  if (generation === previous.generation) {
    const tracks = mergeMirrors(entry.tracks, previous.tracks);
    return withVideo(index, id, { ...entry, tracks, generation, ...(previous.history ? { history: previous.history } : {}) });
  }
  const { history = [], ...row } = previous;
  return withVideo(index, id, { ...entry, generation, history: [row, ...history] });
}

// The shape every consumer (build, prepare, watchtower, the page) relies on.
export function assertVideo(id, entry) {
  const where = `yt-index.json video ${id}`;
  if (!VIDEO_ID.test(id)) throw new Error(`${where}: not a YouTube video id`);
  for (const field of ['title', 'url', 'license', 'ingestedAt']) {
    if (typeof entry?.[field] !== 'string' || entry[field] === '') throw new Error(`${where}: ${field} is required`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.ingestedAt)) throw new Error(`${where}: ingestedAt must be a date (YYYY-MM-DD), not ${entry.ingestedAt}`);
  if (!['youtube', 'operator'].includes(entry.licenseSource)) throw new Error(`${where}: licenseSource must be youtube or operator`);
  if (!Number.isInteger(entry.generation) || entry.generation < 1) throw new Error(`${where}: generation must be a positive integer`);
  if (typeof entry.tracks !== 'object' || Object.keys(entry.tracks).length === 0) throw new Error(`${where}: at least one track is required`);
  for (const [itag, track] of Object.entries(entry.tracks)) {
    if (!/^\d+$/.test(itag)) throw new Error(`${where}: itag ${itag} is not a number`);
    for (const field of ['anchor', 'sha256']) {
      if (typeof track[field] !== 'string' || track[field] === '') throw new Error(`${where} itag ${itag}: ${field} is required`);
    }
    if (!Number.isSafeInteger(track.size) || track.size < 1) throw new Error(`${where} itag ${itag}: size must be a positive integer`);
    if (!Array.isArray(track.mirrors) || track.mirrors.some((m) => typeof m !== 'string')) throw new Error(`${where} itag ${itag}: mirrors must be a list of URLs`);
  }
}

function sameAnchors(a, b) {
  const anchors = (entry) => Object.entries(entry.tracks).map(([itag, track]) => `${itag}=${track.anchor}`).sort().join(' ');
  return anchors(a) === anchors(b);
}

function mergeMirrors(tracks, previous) {
  return Object.fromEntries(Object.entries(tracks).map(([itag, track]) => [
    itag,
    { ...track, mirrors: [...new Set([...track.mirrors, ...(previous[itag]?.mirrors ?? [])])] },
  ]));
}

function withVideo(index, id, entry) {
  return { ...index, videos: { ...index.videos, [id]: entry } };
}
