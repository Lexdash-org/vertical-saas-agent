#!/usr/bin/env node
/**
 * The project invariants that a typecheck cannot catch. Run in CI, and runnable
 * locally with the same command:
 *
 *     npx tsx .github/scripts/check-invariants.ts
 *
 * These replaced a set of Python one-liners when the last Python script was ported;
 * keeping them as a real file means they can be run and debugged before pushing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../../skills/website-lead-enrichment/scripts/lib/env.js';
import { candidates } from '../../skills/website-lead-enrichment/scripts/email-permutation/permute.js';
import { PATTERNS, displayName, firstLast } from '../../skills/website-lead-enrichment/scripts/lib/patterns.js';
import { basisToStatus } from '../../skills/website-lead-enrichment/scripts/lib/basis.js';
import { parseCsv } from '../../skills/website-lead-enrichment/scripts/lib/site.js';

const failures: string[] = [];
const check = (name: string, fn: () => string): void => {
  try {
    console.log(`ok   ${name} — ${fn()}`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    console.error(`FAIL ${name} — ${(err as Error).message}`);
  }
};

/** The canonical table must stay non-empty and duplicate-free — everything derives from it. */
check('pattern table is intact', () => {
  const names = [...PATTERNS.keys()];
  if (!names.length) throw new Error('patterns.json is empty');
  if (names.length !== new Set(names).size) throw new Error('patterns.json has duplicates');
  return `${names.length} canonical patterns`;
});

/** Blind generation must stay dot-only and must not silently lose or duplicate ranks. */
check('generator output', () => {
  const out = candidates('john', 'smith', 'example.com', 18);
  if (out.length !== 18) throw new Error(`expected 18 candidates, got ${out.length}`);
  if (out[0].email !== 'john.smith@example.com') throw new Error(`rank 1 changed: ${out[0].email}`);
  const bad = out.filter((c) => /[_-]/.test(c.email.split('@')[0]));
  if (bad.length) throw new Error(`non-dot separator: ${bad.map((c) => c.email).join(', ')}`);
  const dupes = out.length - new Set(out.map((c) => c.email)).size;
  if (dupes) throw new Error(`${dupes} duplicate candidate(s)`);
  return `${out.length} candidates, rank 1 = ${out[0].email}`;
});

/** Matching initials collapse patterns 13/15 and 14/16 — fewer candidates is correct. */
check('matching initials dedupe', () => {
  const out = candidates('john', 'jones', 'example.com', 18);
  if (out.length !== 16) throw new Error(`expected 16 after dedupe, got ${out.length}`);
  const ranks = out.map((_, i) => i + 1);
  if (ranks[ranks.length - 1] !== out.length) throw new Error('ranks are not contiguous');
  return `${out.length} candidates after collapse`;
});

const walk = (dir: string, ext = '.ts', out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
};

/**
 * No hard-coded variable NAME outside `env.ts`. Without this, a renamed variable fails at
 * runtime as "key not set" — indistinguishable from a user who never configured anything,
 * which is the worst error in the onboarding path.
 *
 * What stays legal, because none of it hard-codes a name:
 *   `env: NodeJS.ProcessEnv = process.env`  — dependency injection for testing
 *   `process.env[ENV.outDir]`               — already goes through the declaration
 *   `{ ...process.env }` then `delete env.OPENAI_API_KEY` — building a child-process
 *      environment. Not a read, and load-bearing: leaving that variable in place makes
 *      Codex bill an API key instead of the subscription.
 */
const NAMED_ENV = /process\.env\.([A-Za-z_]\w*)|process\.env\[\s*['"]([^'"]+)['"]\s*\]/g;

check('no hard-coded env var names outside env.ts', () => {
  const offenders: string[] = [];
  for (const file of walk('skills')) {
    if (file.endsWith(`lib${path.sep}env.ts`)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(NAMED_ENV)) {
        offenders.push(`${file}:${i + 1} → ${m[1] ?? m[2]}`);
      }
    });
  }
  if (offenders.length) {
    throw new Error(`name these in env.ts and read via readEnv():\n    ${offenders.join('\n    ')}`);
  }
  return 'all names declared in env.ts';
});

/** The template and the code must name the same variables — drift either way is a bug. */
check('.env.example matches the declared variables', () => {
  const template = fs.readFileSync('.env.example', 'utf8');
  // LEADGEN_ENV points AT the config file, so it cannot live inside it.
  const declared = Object.values(ENV).filter((n) => n !== ENV.envFile);
  const missing = declared.filter((name) => !template.includes(name));
  if (missing.length) throw new Error(`declared but absent from .env.example: ${missing.join(', ')}`);
  const documented = [...template.matchAll(/^#?\s*(LEADGEN_[A-Z0-9_]+)=/gm)].map((m) => m[1]);
  const undeclared = documented.filter((name) => !declared.includes(name as (typeof declared)[number]));
  if (undeclared.length) throw new Error(`in .env.example but not declared: ${undeclared.join(', ')}`);
  return `${declared.length} variables`;
});

/**
 * The trigger cases are a contract about the skill descriptions, not decoration. They are
 * run by hand (an agent has to be asked), so this checks the file itself stays valid and
 * keeps its near-misses — those are what stop a skill that fires on everything, which is
 * worse than one that fires on nothing because it spends real money.
 */
check('trigger cases are well-formed', () => {
  const raw = JSON.parse(fs.readFileSync('evals/trigger-cases.json', 'utf8')) as {
    cases?: { id?: string; request?: string; expect?: string | null; why?: string }[];
  };
  const cases = raw.cases ?? [];
  if (cases.length < 5) throw new Error(`only ${cases.length} cases`);
  const skills = new Set(
    fs.readdirSync('skills', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  );
  const ids = new Set<string>();
  for (const c of cases) {
    for (const field of ['id', 'request', 'why'] as const) {
      if (!c[field]?.trim()) throw new Error(`case ${c.id ?? '(no id)'} is missing ${field}`);
    }
    if (ids.has(c.id!)) throw new Error(`duplicate case id "${c.id}"`);
    ids.add(c.id!);
    // `expect` must be null (should not fire) or a skill that actually exists.
    if (c.expect !== null && !skills.has(c.expect!)) {
      throw new Error(`case "${c.id}" expects unknown skill "${c.expect}"`);
    }
  }
  const nearMisses = cases.filter((c) => c.expect === null).length;
  if (nearMisses < 3) throw new Error(`only ${nearMisses} near-miss cases — need cases that must NOT fire`);
  return `${cases.length} cases, ${nearMisses} near-misses`;
});

/**
 * CLAUDE.md and AGENTS.md are the same instructions under two filenames, because the
 * runtimes disagree on where to look. Two copies without a guard is the drift this repo
 * rejects everywhere else — the pattern table, the CSV parser, the env names.
 *
 * The HTML comment near the top of each names the other file, so it is compared with that
 * line stripped rather than requiring the files be byte-identical.
 */
check('CLAUDE.md and AGENTS.md agree', () => {
  const strip = (f: string): string =>
    fs.readFileSync(f, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')   // the "kept identical to X" note differs by design
      .replace(/\s+/g, ' ')
      .trim();
  const a = strip('CLAUDE.md');
  const b = strip('AGENTS.md');
  if (a !== b) {
    // A pure append leaves no differing character, so fall back to the shorter length.
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    throw new Error(
      `they have drifted at char ${i}\n` +
        `    CLAUDE.md: ...${a.slice(i, i + 70) || '(ends here)'}\n` +
        `    AGENTS.md: ...${b.slice(i, i + 70) || '(ends here)'}`,
    );
  }
  return `${a.length} chars, identical`;
});

/** Every documented basis must translate, including both suffix orders. */
const ALL_BASES = [
  'known',
  'web-found:high', 'web-found:medium', 'web-found:low',
  'learned:first.last', 'learned:filast(ai)',
  'learned:first.last(unverified-domain)', 'learned:filast(ai)(unverified-domain)',
  'default:first.last', 'default:first.last(unverified-domain)',
  'default:first', 'default:first(unverified-domain)',
  'no-domain', 'no-name',
];

check('every basis translates', () => {
  for (const b of ALL_BASES) {
    const { status, source } = basisToStatus(b);
    if (!source) throw new Error(`"${b}" produced an empty source`);
    if (!['Ready to send', 'Needs verification', ''].includes(status)) {
      throw new Error(`"${b}" produced an unexpected status "${status}"`);
    }
  }
  // An unknown basis must never read as sendable.
  if (basisToStatus('some-future-basis').sendable) throw new Error('unknown basis reported sendable');
  return `${ALL_BASES.length} basis values`;
});

/**
 * The routing guard. `sendable` decides which file a person lands in, so a change here
 * silently moves predictions into the file named "ready to send" — the exact failure the
 * whole honesty contract exists to prevent.
 */
check('only real addresses route as sendable', () => {
  for (const b of ALL_BASES) {
    const expected = b === 'known' || b.startsWith('web-found:');
    if (basisToStatus(b).sendable !== expected) {
      throw new Error(`"${b}" sendable=${!expected}, expected ${expected}`);
    }
  }
  return 'known + web-found only';
});

/**
 * `displayName` is presentation-only. If it ever fed address generation, "De Souza" would
 * become part of a local-part — so the frozen `firstLast` values are checked alongside.
 */
check('display name split', () => {
  const cases: [string, string, string][] = [
    ['Dr. Alison De Souza', 'Alison', 'De Souza'],
    ['Anna Maria van der Berg', 'Anna', 'Maria van der Berg'],
    ["Mary-Jane O'Brien", 'Mary-Jane', "O'Brien"],
    ['Zoë Müller', 'Zoë', 'Müller'],
    ['Cher', 'Cher', ''],
    ['', '', ''],
  ];
  for (const [raw, first, last] of cases) {
    const got = displayName(raw);
    if (got.first !== first || got.last !== last) {
      throw new Error(`"${raw}" -> {${got.first}|${got.last}}, expected {${first}|${last}}`);
    }
  }
  // Address generation must be untouched by any of this.
  const fl = firstLast('Dr. Alison De Souza');
  if (fl?.first !== 'alison' || fl?.last !== 'souza') {
    throw new Error(`firstLast drifted: ${JSON.stringify(fl)}`);
  }
  return `${cases.length} names, firstLast unchanged`;
});

/**
 * The shipped example must contain only addresses read off a company's own site. A
 * predicted address here would publish a guess about a real, named person.
 */
check('example CSV contains no predictions', () => {
  const { header, rows } = parseCsv(fs.readFileSync('examples/output/enriched-sample.csv', 'utf8'));
  const at = (r: string[], c: string): string => r[header.indexOf(c)] ?? '';
  const bad = rows.filter((r) => at(r, 'best_email_basis') !== 'known');
  if (bad.length) throw new Error(`${bad.length} row(s) are not basis=known`);
  const off = rows.filter(
    (r) => at(r, 'best_email') && !at(r, 'best_email').endsWith(`@${at(r, 'domain')}`),
  );
  if (off.length) throw new Error(`${off.length} row(s) are off-domain`);
  const mismatched = rows.filter((r) => at(r, 'best_email') !== at(r, 'email'));
  if (mismatched.length) throw new Error(`${mismatched.length} row(s) have best_email !== email`);
  return `${rows.length} rows, all basis=known, all same-domain`;
});

/**
 * No document may state a Codex per-search quota rate. A search's share of the weekly limit
 * differs across the $20/$100/$200 plans and OpenAI publishes none of them, so any such
 * figure is a guess that reads as a fact. The docs once claimed "1% per 16 searches" and
 * were wrong by more than an order of magnitude; a user sizing a batch from it ran out
 * mid-run. Report the live percentage instead, and let the user pick the batch size.
 */
check('no invented Codex quota rate', () => {
  const rate = /\d+\s*%[^.]{0,40}\bper\b[^.]{0,30}\bsearch(es)?\b/i;
  // Whitespace is collapsed before matching, so a line break cannot hide the claim — a
  // paragraph wrapping "1% per 16 / searches" asserts exactly what one line would, and a
  // per-line check waves it through. Quoted spans are dropped first: citing the discredited
  // figure to warn against it is the opposite of asserting it, and the docs do exactly that.
  const docs = [...walk('skills', '.md'), 'README.md', 'TESTING.md'];
  const bad = docs.filter((f) =>
    rate.test(fs.readFileSync(f, 'utf8').replace(/"[^"]*"/g, '').replace(/\s+/g, ' ')),
  );
  if (bad.length) throw new Error(`quota rate stated as fact in ${bad.join(', ')}`);
  return `${docs.length} docs carry no invented per-search rate`;
});

if (failures.length) {
  console.error(`\n${failures.length} invariant(s) broken`);
  process.exit(1);
}
console.log('\nall invariants hold');
