import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brief, messageOf, redact, statusOf } from './redact.js';

/**
 * The first unit tests in this repo.
 *
 * CLAUDE.md names the absent test suite as the project's biggest gap and points at
 * `scripts/lib/` as where to start, because it is pure and has no I/O. `redact.ts` is the
 * right first file: it enforces a rule stated in CLAUDE.md, every case below is one that
 * actually bit, and it needs no credentials or network to exercise.
 *
 * These lived briefly in `check-invariants.ts`. They do not belong there — that file
 * asserts things about the *shape of the repo* which a test cannot see (no second copy of
 * the pattern table, no hard-coded env name). This is behaviour of one function, and
 * filing it as an invariant is how a project ends up with no test suite at all.
 *
 * Run: npm test
 */

test('removes a key a provider quotes back masked', () => {
  // OpenAI's 401 body gives up the first eight and last four characters of the real key.
  const out = redact('401 Incorrect API key provided: sk-notar**lkey. See platform.openai.com');
  assert.ok(!out.includes('sk-'), `masked key survived: ${out}`);
  assert.ok(out.includes('<redacted>'));
});

test('leaves an error type intact, because it is the diagnosis', () => {
  // A looser prefix list once matched "key-not-found" and destroyed the useful part.
  const out = redact('{"type":"/auth/key-not-found","status":401}');
  assert.ok(out.includes('key-not-found'), `redaction ate the diagnosis: ${out}`);
});

test('removes a credential embedded in a gateway URL path', () => {
  // Such a token need not be any variable this project declares, so exact-match
  // removal cannot reach it.
  const out = redact('called https://gw.example.com/v1/tok_9f8e7d6c5b4a/ with model "m"');
  assert.ok(!out.includes('tok_9f8e7d6c5b4a'), `URL token survived: ${out}`);
});

test('keeps the short URL path segments an Azure user needs to see', () => {
  // Eliding these would remove the reason the endpoint is printed at all — telling
  // someone their base URL is missing /openai/v1/.
  const out = redact('rejected by https://res.cognitiveservices.azure.com/openai/v1/');
  assert.ok(out.endsWith('/openai/v1/'), `redaction ate the Azure path: ${out}`);
});

test('leaves a long filesystem path in prose alone', () => {
  const path = '/Users/someone/averylongdirectoryname/file.txt';
  assert.equal(redact(`wrote ${path}`), `wrote ${path}`);
});

test('brief collapses whitespace and truncates; messageOf does neither', () => {
  const err = new Error('a\n  b   c');
  assert.equal(brief(err), 'a b c');
  assert.equal(messageOf(err), 'a\n  b   c');
  assert.equal(brief(new Error('x'.repeat(500))).length, 200);
  // The retry predicates match on messageOf, so truncation there would change a verdict.
  assert.equal(messageOf(new Error('x'.repeat(500))).length, 500);
});

test('statusOf prefers the error object over the message text', () => {
  assert.equal(statusOf(Object.assign(new Error('nothing numeric here'), { status: 401 })), 401);
  assert.equal(statusOf(new Error('Zyte static 503: upstream')), 503);
  assert.equal(statusOf(new Error('no status at all')), undefined);
  // A 200-like number in prose is not a status.
  assert.equal(statusOf(new Error('read 1234 rows')), undefined);
});

test('handles non-Error throws without crashing', () => {
  assert.equal(messageOf('plain string'), 'plain string');
  assert.equal(brief(undefined), 'undefined');
});
