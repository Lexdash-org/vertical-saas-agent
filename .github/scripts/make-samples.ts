#!/usr/bin/env node
/**
 * Regenerate the shipped sample files from a real run.
 *
 * Both source files are gitignored — they hold the full run, including tens of thousands
 * of *predicted* addresses nobody has ever verified. This script is committed so what
 * ships is auditable.
 *
 *   1. examples/input/companies.example.csv  - 25 real clinic websites (public business info)
 *   2. examples/output/enriched-sample.csv    - 50 VERIFIED emails, basis `known`
 *
 * What "verified" means here, and what it deliberately excludes:
 *
 *   INCLUDED  basis `known` — the address was read directly off the company's own
 *             website, where the company published it themselves. Real and checkable.
 *
 *   EXCLUDED  `default:*` and `learned:*` — predictions. Guesses assembled from a name
 *             and a domain; nobody has confirmed they belong to anyone, and shipping
 *             them would attribute invented addresses to real people.
 *   EXCLUDED  `web-found:*` — real, but sourced off-domain (a paper, a hospital staff
 *             register). Personal/institutional rather than published by the employer,
 *             so they stay out.
 *
 * MAINTAINER TOOL. Both source files are gitignored, so this cannot run from a clone —
 * it lives here with the other repo tooling rather than in examples/, which holds only
 * the sample data itself.
 *
 * Usage: npx tsx .github/scripts/make-samples.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, csvCell } from '../../skills/website-lead-enrichment/shared/lib/site.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Both are gitignored and exist only on a maintainer's machine. Overridable so the
// filenames of a private lead list never have to be hard-coded into a public repo.
const SRC_LIST = process.env.SAMPLE_SRC_LIST ?? path.join(ROOT, 'data/source-list.csv');
const SRC_ENRICHED = process.env.SAMPLE_SRC_ENRICHED ?? path.join(ROOT, 'ENRICHED-team-emails.csv');
const N_COMPANIES = 25;
const N_EMAILS = 50;

/** Read a CSV into row objects keyed by header name, the way DictReader did. */
function readRows(file: string): Record<string, string>[] {
  const { header, rows } = parseCsv(fs.readFileSync(file, 'utf8'));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function writeRows(file: string, cols: string[], rows: Record<string, string>[]): void {
  const lines = [
    cols.join(','),
    ...rows.map((r) => cols.map((c) => csvCell(r[c] ?? '')).join(',')),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

// ---------- 1. sample input ----------
// The source lead list is gitignored and may not be present in a clone; the committed
// fixture it produced is. Skip rather than fail.
let rows: Record<string, string>[] = [];
if (!fs.existsSync(SRC_LIST)) {
  console.log(`examples/input/companies.example.csv: skipped (${path.basename(SRC_LIST)} not present)`);
} else {
  rows = readRows(SRC_LIST);
}

// Skip listings named after an individual practitioner ("Dr Jane Smith - Cardiologist").
// A clinic-named sample makes the same point without a person's name in the field.
const PERSONAL = /^(dr|prof|professor|mr|mrs|ms|a\/prof|assoc)\b[. ]/i;

const seen = new Set<string>();
const picked: Record<string, string>[] = [];
for (const r of rows) {
  const w = (r.Website ?? '').trim();
  if (!w.startsWith('http') || PERSONAL.test((r.Name ?? '').trim())) continue;
  const host = w.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
  if (seen.has(host)) continue;
  seen.add(host);
  picked.push({
    Name: (r.Name ?? '').trim(),
    Website: `https://${host}`,
    Specialty: (r.Specialty ?? '').trim(),
    Suburb: (r.Suburb ?? '').trim(),
    State: (r.State ?? '').trim(),
  });
  if (picked.length === N_COMPANIES) break;
}

if (picked.length) {
  fs.mkdirSync(path.join(ROOT, 'examples/input'), { recursive: true });
  writeRows(
    path.join(ROOT, 'examples/input/companies.example.csv'),
    ['Name', 'Website', 'Specialty', 'Suburb', 'State'],
    picked,
  );
  console.log(`examples/input/companies.example.csv: ${picked.length} companies`);
}

// ---------- 2. verified emails ----------
const enr = readRows(SRC_ENRICHED);

/** The address sits on the company's own domain — i.e. the company published it. */
const stripWww = (s: string): string => (s.startsWith('www.') ? s.slice(4) : s);
function sameDomain(addr: string, domain: string): boolean {
  const at = stripWww(addr.split('@').pop()!.toLowerCase());
  const bare = stripWww((domain ?? '').toLowerCase());
  return Boolean(bare) && (at === bare || at.endsWith(`.${bare}`) || bare.endsWith(`.${at}`));
}

const verified = enr.filter(
  (r) =>
    r.best_email_basis === 'known' &&
    (r.email ?? '').trim() &&
    sameDomain(r.email.trim(), r.domain ?? ''),
);

// Spread across companies rather than 50 people from one large clinic.
const byCompany = new Map<string, Record<string, string>[]>();
for (const r of verified) {
  const list = byCompany.get(r.domain) ?? [];
  list.push(r);
  byCompany.set(r.domain, list);
}

const sample: Record<string, string>[] = [];
const domains = [...byCompany.keys()].sort();
for (let depth = 0; sample.length < N_EMAILS && depth < 100; depth++) {
  for (const dom of domains) {
    const list = byCompany.get(dom)!;
    if (depth < list.length) {
      sample.push(list[depth]);
      if (sample.length === N_EMAILS) break;
    }
  }
}

const COLS = ['company', 'domain', 'website', 'name', 'title', 'email',
  'email_domain', 'mx_provider', 'best_email', 'best_email_basis'];

fs.mkdirSync(path.join(ROOT, 'examples/output'), { recursive: true });
writeRows(path.join(ROOT, 'examples/output/enriched-sample.csv'), COLS, sample);

const companies = new Set(sample.map((r) => r.domain)).size;
console.log(`examples/output/enriched-sample.csv: ${sample.length} verified emails across ${companies} companies`);
console.log(`  pool of basis=known, same-domain: ${verified.length}`);
console.log(`  non-verified rows leaked in: ${sample.filter((r) => r.best_email_basis !== 'known').length} (must be 0)`);
console.log(`  predicted/web-found leaked in: ${sample.filter((r) => r.best_email !== r.email).length} (must be 0)`);
