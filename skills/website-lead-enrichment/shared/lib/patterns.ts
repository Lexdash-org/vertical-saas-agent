import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared email-format logic. The pattern table itself lives in patterns.json and is
 * read by BOTH this file and permute.py, so pattern LEARNING (matching a real email to
 * a pattern) and pattern GENERATION cannot drift apart — they were previously two
 * hand-maintained tables plus a third hand-typed copy inside a model prompt.
 *
 * Builders are derived from the pattern names rather than written out: every name is a
 * formula over {first, last, fi, li} joined by '.' or nothing.
 */

export const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'mx', 'prof', 'professor', 'sir', 'madam', 'rev', 'hon']);

/** Normalize a display name to its [a-z] tokens (accents stripped, titles dropped). */
export function nameTokens(raw: string): string[] {
  const decomp = (raw || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const toks: string[] = [];
  for (const t of decomp.toLowerCase().split(/\s+/)) {
    const cleaned = [...t].filter((c) => c >= 'a' && c <= 'z').join('');
    if (!cleaned || TITLES.has(cleaned)) continue;
    toks.push(cleaned);
  }
  return toks;
}

/** first = first token, last = last token — the skill's rule. */
export function firstLast(raw: string): { first: string; last: string } | null {
  const t = nameTokens(raw);
  if (t.length < 2) return null;
  return { first: t[0], last: t[t.length - 1] };
}

// A pattern name IS its formula. Alternation is left-to-right, so listing the long
// tokens first makes "filast" match fi+last rather than stalling on "fi"+"last".
const TOKEN = /first|last|fi|li/g;
const VALID = /^(?:first|last|fi|li)(?:\.?(?:first|last|fi|li))*$/;

/** Turn a pattern name into its local-part builder. Dots pass through untouched. */
function compile(name: string): (f: string, l: string) => string {
  if (!VALID.test(name)) {
    throw new Error(`patterns.json: "${name}" is not a formula over first|last|fi|li`);
  }
  return (f, l) =>
    name.replace(TOKEN, (t) =>
      t === 'first' ? f : t === 'last' ? l : t === 'fi' ? f[0] : l[0],
    );
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(fs.readFileSync(path.join(HERE, 'patterns.json'), 'utf8')) as {
  patterns: string[];
};

/**
 * The canonical local-part patterns, in rank order. Shared with permute.py.
 *
 * A Map because all three consumers want a different shape of the same table: iterate in
 * rank order, test membership, and look one up by name.
 */
export const PATTERNS: ReadonlyMap<string, (f: string, l: string) => string> = new Map(
  TABLE.patterns.map((name) => [name, compile(name)] as const),
);

/** Build a person's email under a named pattern @ domain, or null if unbuildable. */
export function buildEmail(pattern: string, name: string, domain: string): string | null {
  const build = PATTERNS.get(pattern);
  const fl = firstLast(name);
  if (!fl || !build || !domain) return null;
  return `${build(fl.first, fl.last)}@${domain}`;
}
