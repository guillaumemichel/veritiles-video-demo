#!/usr/bin/env node
// A stand-in yt-dlp for an offline dry run of the whole YouTube path:
// "downloads" the split fixture tracks (data/split/, made by the browser
// check) and resolves deliveries on a locally served dist/ ($STUB_BASE,
// default http://127.0.0.1:8080). Usage in the README, Local development.
import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'splitfixtur';
const split = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'split');
const FILES = { 137: join(split, 'video.mp4'), 140: join(split, 'audio.mp4') };
const base = (process.env.STUB_BASE ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

const args = process.argv.slice(2);
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const itag = after('-f');

if (args.includes('--version')) {
  console.log('2026.stub');
} else if (args.includes('-j')) {
  const info = {
    id: ID, title: 'Split fixture', channel: 'Fixtures', channel_id: 'UCfixture', upload_date: '20260905', duration: 634,
    license: 'Creative Commons Attribution license (reuse allowed)',
    formats: [
      { format_id: '137', ext: 'mp4', protocol: 'https', vcodec: 'avc1.640029', acodec: 'none', height: 1080, fps: 30 },
      { format_id: '140', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2' },
      { format_id: '232', ext: 'mp4', protocol: 'm3u8_native', vcodec: 'avc1.4D401F', acodec: 'none', height: 720 },
      { format_id: 'sb0', ext: 'mhtml', vcodec: 'none', acodec: 'none' },
    ],
    ...(itag ? { requested_formats: [{ format_id: itag, url: `${base}/yt/${ID}/itag${itag}.mp4?expire=1&stub=1`, http_headers: { 'User-Agent': 'stub-client/1' } }] } : {}),
  };
  console.log(JSON.stringify(info));
} else if (FILES[itag] === undefined) {
  console.error(`stub: no fixture for itag ${itag}`);
  process.exit(1);
} else {
  copyFileSync(FILES[itag], after('-o'));
  console.error(`[stub] itag ${itag} → ${after('-o')}`);
}
