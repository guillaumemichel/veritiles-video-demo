// The one place this repository talks to yt-dlp — the abstraction boundary
// to YouTube's delivery: signatures, PO tokens, SABR and client choice all
// live behind it. The binary is `yt-dlp` on PATH or $YT_DLP.
import { spawn } from 'node:child_process';

import { trackFile } from './yt-index.js';

const BIN = process.env.YT_DLP ?? 'yt-dlp';
// No operator config (a global --embed-metadata would make the bytes
// toolchain-dependent yet pass the two-download gate); node as the
// JavaScript runtime (a deno install needs no flag).
const FIXED = ['--ignore-config', '--js-runtimes', 'node'];
// Extra flags for every call — a proxy when the egress is bot-checked
// (`YT_DLP_ARGS='--proxy socks5://…'`). Never part of the recipe, which
// names only what fixes the bytes.
const EXTRA = (process.env.YT_DLP_ARGS ?? '').split(/\s+/).filter(Boolean);
const BASE = [...FIXED, ...EXTRA];
// `--fixup never` is load-bearing: without it yt-dlp may run an ffmpeg
// container fix and the bytes become toolchain-dependent.
const PRISTINE = ['--fixup', 'never'];

// Extra flags that would sign requests in with a Google account (--cookies,
// --cookies-from-browser, a hand-made Cookie header) are refused: they tie
// every download and check to the operator's account.
export function refuseCookies(args = EXTRA) {
  const found = args.filter((arg) => /cookie/i.test(arg));
  if (found.length === 0) return;
  throw new Error(`this repository refuses cookies (YT_DLP_ARGS has ${found.join(' ')}): a signed-in run ties what it fetches to your Google account — run from a residential connection, or pass a --proxy`);
}

export function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

export async function version() {
  return (await run(['--version'])).trim();
}

// Title, channel, the licence YouTube's own licence field states (null when
// the uploader left it at the default), duration, and the plain-HTTPS DASH
// formats on offer (HLS renditions of the same tracks are skipped).
export async function metadata(id) {
  const meta = await info(id, []);
  return {
    title: meta.title,
    channel: meta.channel ?? meta.uploader ?? null,
    channelId: meta.channel_id ?? null,
    license: meta.license ?? null,
    uploadDate: meta.upload_date ?? null,
    durationSeconds: meta.duration ?? null,
    formats: (meta.formats ?? [])
      .filter((f) => /^\d+$/.test(f.format_id) && f.protocol === 'https')
      .map((f) => ({ itag: Number(f.format_id), vcodec: f.vcodec ?? 'none', acodec: f.acodec ?? 'none', height: f.height ?? 0 })),
  };
}

// A fresh signed delivery for one itag: the googlevideo URL plus the request
// headers it was issued for (the resolving client's User-Agent among them).
export async function resolve(id, itag) {
  const meta = await info(id, ['-f', String(itag)]);
  const format = meta.requested_formats?.[0] ?? meta.formats?.find((f) => f.format_id === String(itag));
  if (typeof format?.url !== 'string') throw new Error(`${id}: itag ${itag} is not offered`);
  return { url: format.url, headers: format.http_headers ?? {} };
}

// The pristine bytes of one itag at `out`: no container fixup, no merging —
// any yt-dlp version reproduces the same file. Progress goes to stderr.
export async function download(id, itag, out) {
  await run([...BASE, '--no-warnings', ...trackArgs(itag), '--no-part', '--force-overwrites', '-o', out, watchUrl(id)], { inherit: true });
}

// The commands that reproduce a track and its digest by hand.
export function recipe(id, itag) {
  return [
    `yt-dlp ${[...FIXED, ...trackArgs(itag), '-o', trackFile(itag)].join(' ')} '${watchUrl(id)}'`,
    `sha256sum ${trackFile(itag)}`,
  ];
}

// A fetch for a resolved delivery: the delivery's own headers on every
// request to its URL, Range passed straight through (googlevideo answers a
// standard Range header with 206). Requests elsewhere are untouched.
export function deliveryFetch({ url, headers }, fetchFn = fetch) {
  return (input, init = {}) => {
    if (String(input) !== url) return fetchFn(input, init);
    return fetchFn(input, { ...init, headers: { ...headers, ...init.headers } });
  };
}

function trackArgs(itag) {
  return ['-f', String(itag), ...PRISTINE];
}

async function info(id, args) {
  return JSON.parse(await run([...BASE, '--no-warnings', '-j', ...args, watchUrl(id)]));
}

// stdout of a yt-dlp run; stderr is relayed live when `inherit`, else kept
// for the error. A non-zero exit or a missing binary throws.
function run(args, { inherit = false } = {}) {
  refuseCookies();
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { stdio: ['ignore', 'pipe', inherit ? 'inherit' : 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { err += chunk; });
    child.on('error', (cause) => reject(new Error(`${BIN} failed to start (${cause.message}) — install yt-dlp or set YT_DLP`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(out);
      reject(new Error(`yt-dlp exited with ${code}${err ? `: ${err.trim().split('\n').at(-1)}` : ''}`));
    });
  });
}
