// Whatever the repository publishes must not carry the operator's network
// identity: no IP address outside the loopback and documentation ranges,
// in any tracked or about-to-be-tracked file — index, docs, code.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// Loopback, unspecified, and the RFC 5737 / RFC 3849 documentation ranges tests use.
const HARMLESS = /^(127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|::1?$|2001:db8:)/i;

function publishedFiles() {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
  return listed.toString().split('\0').filter(Boolean);
}

// Dotted quads, colon-separated hex, and URL-encoded `ip=` values.
function addressesIn(text, harmless = HARMLESS) {
  const tokens = text.match(/\d{1,3}(?:\.\d{1,3}){3}|[\da-f]*:[\da-f:.]*:[\da-f.]*/gi) ?? [];
  const params = [...text.matchAll(/[?&]ip=([^&\s'"`]+)/g)].map(([, value]) => decodeURIComponent(value));
  return [...tokens, ...params].filter((token) => isIP(token) && !harmless.test(token));
}

test('the address scan sees v4, v6 and encoded delivery parameters, and skips the harmless ranges', () => {
  const loopbackOnly = /^(127\.|::1$)/;
  assert.deepEqual(addressesIn('from 203.0.113.7 at 12:00:00', loopbackOnly), ['203.0.113.7']);
  assert.deepEqual(addressesIn('videoplayback?expire=1&ip=2001%3Adb8%3A%3A7&sig=x', loopbackOnly), ['2001:db8::7']);
  assert.deepEqual(addressesIn('http://127.0.0.1:8080 ip=203.0.113.7&ip=2001%3Adb8%3A%3A7 v2026.08.19 12:00:00'), []);
});

test('no published file carries an IP address', async () => {
  const found = [];
  for (const file of publishedFiles()) {
    const text = await readFile(join(root, file), 'utf8').catch(() => '');
    for (const address of addressesIn(text)) found.push(`${file}: ${address}`);
  }
  assert.deepEqual(found, []);
});
