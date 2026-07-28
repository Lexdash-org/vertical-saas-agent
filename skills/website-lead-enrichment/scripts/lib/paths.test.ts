import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appendLedger } from './paths.js';

/**
 * `appendLedger` has to do two opposing things at once, and the second is the one a
 * blanket `redact(JSON.stringify(rec))` would have got wrong.
 */

const tmpLedger = (): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wle-ledger-')), 'ledger.jsonl');

test('redacts a credential a provider echoed into an error field', () => {
  const file = tmpLedger();
  appendLedger(file, {
    domain: 'example.com',
    error: '401 Incorrect API key provided: sk-notar**lkey. See platform.openai.com',
  });
  const written = fs.readFileSync(file, 'utf8');
  assert.ok(!written.includes('sk-'), `credential reached the ledger: ${written}`);
  assert.ok(written.includes('<redacted>'));
});

test('leaves the source URL intact — it is the evidence, not provider text', () => {
  const file = tmpLedger();
  // This path segment is 26 characters, so a whole-line redact would elide it and
  // destroy the proof that ships beside the address.
  const sourceUrl = 'https://clinic.com.au/our-team/dr-jane-smith-cardiologist';
  appendLedger(file, { domain: 'clinic.com.au', company: 'GSK-Cardiology', sourceUrl });
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  assert.equal(record.sourceUrl, sourceUrl);
  // A company name matching a key prefix must survive too.
  assert.equal(record.company, 'GSK-Cardiology');
});

test('appends one newline-terminated record per call', () => {
  const file = tmpLedger();
  appendLedger(file, { n: 1 });
  appendLedger(file, { n: 2 });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.map((l) => (JSON.parse(l) as { n: number }).n), [1, 2]);
});
