// parseSource guards the form: a source must be an absolute, clean http(s)
// URL, because the proof base is derived by appending `.proofs` to it — any
// ?/# in the href (even a bare trailing delimiter) would corrupt that base.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as lib from 'veritiles';

import { describe, parseSource } from '../web/app.js';

test('accepts a clean absolute http(s) URL', () => {
  const { source, error } = parseSource({ cid: 'bafyanchor', src: 'https://host/v.mp4' });
  assert.equal(error, undefined);
  assert.deepEqual(source, { cid: 'bafyanchor', src: 'https://host/v.mp4' });
});

test('keeps a percent-encoded ? in the path', () => {
  const { source, error } = parseSource({ cid: 'bafyanchor', src: 'https://host/v%3F.mp4' });
  assert.equal(error, undefined);
  assert.equal(source.src, 'https://host/v%3F.mp4');
});

for (const src of ['https://host/v.mp4?', 'https://host/v.mp4#', 'https://host/v.mp4?a=1', 'https://host/v.mp4#t=30']) {
  test(`rejects a query string or fragment: ${src}`, () => {
    const { source, error } = parseSource({ cid: 'bafyanchor', src });
    assert.equal(source, undefined);
    assert.match(error, /query string or fragment/);
  });
}

test('rejects an empty cid and a relative or non-http src', () => {
  assert.match(parseSource({ cid: '', src: 'https://host/v.mp4' }).error, /anchor CID/);
  assert.match(parseSource({ cid: 'bafyanchor', src: 'v.mp4' }).error, /absolute/);
  assert.match(parseSource({ cid: 'bafyanchor', src: 'ftp://host/v.mp4' }).error, /absolute/);
});

// --- describe ----------------------------------------------------------------
// The client's source loop wraps what each source threw in an AggregateError;
// describe unwraps it and turns the failure into one #alert line of host advice.

const SRC = 'https://h/v.mp4';

test('a wrapped verification failure reads as a wrong anchor', () => {
  const err = new AggregateError([new lib.VerificationError('root: digest mismatch')]);
  assert.match(describe(err, SRC, lib), /^⛔ the bytes at this URL don't verify against the anchor CID/);
});

test('a wrapped 404 says where the proofs must sit', () => {
  const err = new AggregateError([new Error('https://h/v.mp4.proofs/root: HTTP 404')]);
  assert.ok(describe(err, SRC, lib).includes('not found — proofs must sit beside the video at https://h/v.mp4.proofs/'));
});

test('range and CORS failures turn into host advice', () => {
  assert.equal(describe(new lib.RangeUnsupportedError('no 206'), SRC, lib),
    '✗ this host ignores Range requests — it must answer with 206');
  assert.equal(describe(new lib.RangeBlockedError('range refused'), SRC, lib),
    '✗ the host refused the cross-origin Range request — it must allow the Range header (Access-Control-Allow-Headers: Range)');
  assert.equal(describe(new TypeError('Failed to fetch'), SRC, lib),
    '✗ the host refused the cross-origin request — it must send Access-Control-Allow-Origin: *');
});

test('any other error keeps its message', () => {
  assert.equal(describe(new Error('boom'), SRC, lib), '✗ boom');
});
