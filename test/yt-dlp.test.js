// The yt-dlp boundary: the delivery fetch that carries a resolved URL's own
// headers, the recipe that reproduces a track, and the cookie flags every
// yt-dlp run refuses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deliveryFetch, recipe, refuseCookies, watchUrl } from '../scripts/lib/yt-dlp.js';

const delivery = { url: 'https://r1.googlevideo.example/videoplayback?itag=140&expire=1', headers: { 'User-Agent': 'tv-client', 'X-Client': 'a' } };

test('deliveryFetch adds the delivery headers to its URL only, Range untouched', async () => {
  const seen = [];
  const fetchFn = async (input, init) => { seen.push([String(input), init]); return new Response(''); };
  const fetch = deliveryFetch(delivery, fetchFn);
  await fetch(delivery.url, { headers: { Range: 'bytes=0-9', 'X-Client': 'b' } });
  await fetch('https://site.example/proofs/root', { headers: { Range: 'bytes=0-9' } });
  assert.deepEqual(seen[0][1].headers, { 'User-Agent': 'tv-client', 'X-Client': 'b', Range: 'bytes=0-9' });
  assert.deepEqual(seen[1], ['https://site.example/proofs/root', { headers: { Range: 'bytes=0-9' } }]);
});

test('the recipe names the flags that fix the bytes', () => {
  assert.deepEqual(recipe('abcdefghijk', 137), [
    `yt-dlp --ignore-config --js-runtimes node -f 137 --fixup never -o itag137.mp4 '${watchUrl('abcdefghijk')}'`,
    'sha256sum itag137.mp4',
  ]);
});

test('cookie flags are refused in every spelling', () => {
  assert.throws(() => refuseCookies(['--cookies-from-browser', 'firefox']), /refuses cookies \(YT_DLP_ARGS has --cookies-from-browser\)/);
  assert.throws(() => refuseCookies(['--cookies=jar.txt', '--proxy', 'socks5://h:1']), /--cookies=jar\.txt/);
  assert.throws(() => refuseCookies(['--add-header', 'Cookie:SID=x']), /Cookie:SID=x/);
  assert.doesNotThrow(() => refuseCookies(['--proxy', 'socks5://h:1', '-4']));
});

test('ingest and the watchtower stop before anything else when YT_DLP_ARGS has cookies', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env, YT_DLP: 'test/lib/yt-dlp-stub.mjs', YT_DLP_ARGS: '--cookies-from-browser firefox' };
  for (const args of [['scripts/yt-ingest.mjs', 'splitfixtur'], ['scripts/watchtower.mjs']]) {
    const { status, stderr } = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(status, 1, `${args[0]} should exit 1`);
    assert.match(stderr, /refuses cookies/, args[0]);
  }
});
