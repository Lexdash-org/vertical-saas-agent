#!/usr/bin/env node
/**
 * Email permutation — predict candidate addresses from a name + domain.
 *
 * Given first_name, last_name and one or two domains, emit ~18 ranked candidate email
 * addresses per person. Generation only: no MX lookup, no SMTP probe, no verification,
 * no network access of any kind.
 *
 * Domain selection is a STRICT FALLBACK, never a cross-product:
 *     domain = email_domain or company_domain
 * If email_domain is populated it wins outright and company_domain is not permuted at
 * all. If neither is present the row is skipped.
 *
 * Usage:
 *     npx tsx permute.ts --in leads.csv --out-wide wide.csv --out-long long.csv
 *
 * Column names are configurable because lead-export tools disagree on headers.
 *
 * The pattern table and the name normalizer are imported from scripts/lib/patterns.ts,
 * not restated here — pattern GENERATION and pattern LEARNING must not be able to
 * drift apart. (This file was Python until the port; keeping a private copy of the
 * table is what the shared module exists to prevent.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERNS, nameTokens } from '../lib/patterns.js';
import { parseCsv, csvCell } from '../lib/site.js';
import { argVal, die } from '../lib/cli.js';

export interface Candidate {
  pattern: string;
  email: string;
}

/**
 * Reduce one input name field to a single lowercase [a-z] token.
 *
 * Normalization is an INPUT concern only — it decides what `first` and `last` are. It
 * says nothing about separators in the generated address: accents are stripped,
 * honorifics dropped, and hyphens/apostrophes COLLAPSE rather than split
 * (`Mary-Jane` -> `maryjane`). Multi-token surnames take the last token
 * (`van der Berg` -> `berg`); multi-token given names take the first.
 *
 * Returns '' when nothing usable survives.
 */
export function normalizeNamePart(raw: string | undefined, takeLastToken = false): string {
  const tokens = nameTokens(raw ?? '');
  if (!tokens.length) return '';
  return takeLastToken ? tokens[tokens.length - 1] : tokens[0];
}

/**
 * Build the ranked candidate list for one person.
 *
 * Dedupes while preserving first-seen order, so "John Jones" (matching initials)
 * collapses fi.li/li.fi and yields fewer than `max`. Ranks stay contiguous from 1.
 */
export function candidates(first: string, last: string, domain: string, max: number): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const [pattern, build] of PATTERNS) {
    const local = build(first, last);
    if (seen.has(local)) continue;
    seen.add(local);
    out.push({ pattern, email: `${local}@${domain}` });
    if (out.length >= max) break;
  }
  return out;
}

export interface PermuteOptions {
  input: string;
  outWide: string;
  outLong: string;
  firstCol?: string;
  lastCol?: string;
  companyDomainCol?: string;
  emailDomainCol?: string;
  max?: number;
}

export interface PermuteSummary {
  rowsIn: number;
  skippedDomain: number;
  skippedName: number;
  candidatesOut: number;
}

const LONG_COLS = ['first_name', 'last_name', 'domain', 'domain_source', 'rank', 'pattern', 'email'];

/** Run the generator over a CSV, writing the long (source of truth) and wide (pivot) files. */
export function permuteCsv(opts: PermuteOptions): PermuteSummary {
  const firstCol = opts.firstCol ?? 'first_name';
  const lastCol = opts.lastCol ?? 'last_name';
  const companyDomainCol = opts.companyDomainCol ?? 'company_domain';
  const emailDomainCol = opts.emailDomainCol ?? 'email_domain';
  const max = opts.max ?? 18;

  const { header, rows } = parseCsv(fs.readFileSync(opts.input, 'utf8'));
  for (const col of [firstCol, lastCol, companyDomainCol]) {
    if (!header.includes(col)) {
      die(`input CSV has no column '${col}'. Found: ${header.join(', ')}`);
    }
  }
  const ix = (col: string): number => header.indexOf(col);
  const cell = (row: string[], col: string): string => {
    const i = ix(col);
    return i < 0 ? '' : row[i] ?? '';
  };

  let skippedName = 0;
  let skippedDomain = 0;
  const longRows: string[][] = [];
  // Parallel to `rows`; holds the candidate list for each input row so the wide file is
  // a pivot of the long table rather than a second generation pass.
  const perRow: string[][] = [];

  for (const row of rows) {
    const first = normalizeNamePart(cell(row, firstCol));
    const last = normalizeNamePart(cell(row, lastCol), true);

    const emailDomain = cell(row, emailDomainCol).trim().toLowerCase();
    const companyDomain = cell(row, companyDomainCol).trim().toLowerCase();

    // Strict fallback. email_domain wins outright when present.
    let domain: string;
    let source: string;
    if (emailDomain) {
      domain = emailDomain;
      source = 'email_domain';
    } else if (companyDomain) {
      domain = companyDomain;
      source = 'company_domain';
    } else {
      skippedDomain += 1;
      perRow.push([]);
      continue;
    }

    if (!first || !last) {
      skippedName += 1;
      perRow.push([]);
      continue;
    }

    const found = candidates(first, last, domain, max);
    perRow.push(found.map((c) => c.email));

    found.forEach((c, i) => {
      longRows.push([
        cell(row, firstCol),
        cell(row, lastCol),
        domain,
        source,
        String(i + 1),
        c.pattern,
        c.email,
      ]);
    });
  }

  const writeCsv = (file: string, cols: string[], body: string[][]): void => {
    const lines = [cols.join(','), ...body.map((r) => r.map(csvCell).join(','))];
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  };

  writeCsv(opts.outLong, LONG_COLS, longRows);

  // Fixed-width email_1..email_N so the header is stable across runs — a varying column
  // count breaks field mapping on import.
  const emailCols = Array.from({ length: max }, (_, i) => `email_${i + 1}`);
  const wideBody = rows.map((row, i) => {
    const emails = perRow[i] ?? [];
    const base = header.map((_, c) => row[c] ?? '');
    return [...base, ...emailCols.map((_, c) => emails[c] ?? '')];
  });
  writeCsv(opts.outWide, [...header, ...emailCols], wideBody);

  return {
    rowsIn: rows.length,
    skippedDomain,
    skippedName,
    candidatesOut: longRows.length,
  };
}

function main(): void {
  const input = argVal('--in');
  const outWide = argVal('--out-wide');
  const outLong = argVal('--out-long');
  if (!input || !outWide || !outLong) {
    die('--in, --out-wide and --out-long are all required');
  }
  const maxRaw = argVal('--max');
  const max = maxRaw === undefined ? 18 : Number(maxRaw);
  if (!Number.isInteger(max) || max < 1) die(`--max must be a positive integer, got '${maxRaw}'`);

  const summary = permuteCsv({
    input,
    outWide,
    outLong,
    firstCol: argVal('--first-col'),
    lastCol: argVal('--last-col'),
    companyDomainCol: argVal('--company-domain-col'),
    emailDomainCol: argVal('--email-domain-col'),
    max,
  });

  console.error(`rows in:            ${summary.rowsIn}`);
  console.error(`skipped (no domain):${String(summary.skippedDomain).padStart(4)}`);
  console.error(`skipped (no name):  ${String(summary.skippedName).padStart(4)}`);
  console.error(`candidates out:     ${summary.candidatesOut}`);
  console.error(`wrote ${outWide} and ${outLong}`);
}

// Run only when invoked directly, so apply-permutation.ts can import the generator
// instead of paying for a subprocess.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
