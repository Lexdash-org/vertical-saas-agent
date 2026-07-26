import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared email-format logic. The pattern table itself lives in patterns.json and is
 * read by BOTH this file and permute.ts, so pattern LEARNING (matching a real email to
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

/**
 * Split a name for DISPLAY — a sequencer's `{{first_name}}`, not an email local-part.
 *
 * `nameTokens` is wrong for this: it lowercases and drops everything outside [a-z], so
 * "De Souza" comes back as "souza" and lands in a live campaign that way. Here the
 * original casing and particles survive; only honorifics are removed.
 *
 * `last` takes every remaining token rather than just the final one, because "van der
 * Berg" is a surname, not three. That differs from `firstLast` on purpose — addresses
 * need one token, humans need the whole name.
 *
 *   "Dr. Alison De Souza"  -> { first: "Alison", last: "De Souza" }
 *   "Cher"                 -> { first: "Cher",   last: "" }
 */
export function displayName(raw: string): { first: string; last: string } {
  const tokens = (raw || '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !TITLES.has(t.toLowerCase().replace(/[^a-z]/g, '')));
  if (!tokens.length) return { first: '', last: '' };
  return { first: tokens[0], last: tokens.slice(1).join(' ') };
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
 * The canonical local-part patterns, in rank order. Shared with permute.ts.
 *
 * A Map because all three consumers want a different shape of the same table: iterate in
 * rank order, test membership, and look one up by name.
 */
export const PATTERNS: ReadonlyMap<string, (f: string, l: string) => string> = new Map(
  TABLE.patterns.map((name) => [name, compile(name)] as const),
);

/**
 * A company's *observed* local-part format, as a template over four placeholders:
 *
 *   {first} {last} {fi} {li}      e.g. "{last}.admin"  "{first}_{last}"  "dr{last}"
 *
 * Deliberately looser than the 18 canonical patterns. Those are the ranked guesses used
 * when we know nothing; a template is used only when a company's own published addresses
 * show its house style — including styles the canonical table cannot express:
 *
 *   {last}.admin     osa.melbourne  (kondogiannis.admin@, li.admin@, stoney.admin@)
 *   {first}_{last}   snp.com.au     (underscore — never generated blind)
 *   dr{last}         several solo practices
 *
 * The dot-only rule still governs *blind* guessing. Observed evidence overrides it,
 * because a separator the company demonstrably uses is not a guess.
 */
const TEMPLATE_TOKEN = /\{(first|last|fi|li)\}/g;
/** Literal text between placeholders — letters, digits, dot, underscore, hyphen. */
const TEMPLATE_VALID = /^(?:\{(?:first|last|fi|li)\}|[a-z0-9._-]{1,20})+$/;

/** Does this look like a usable template, and does it reference at least one name part? */
export function isValidTemplate(t: string): boolean {
  return (
    typeof t === 'string' &&
    t.length <= 60 &&
    TEMPLATE_VALID.test(t) &&
    /\{(first|last|fi|li)\}/.test(t)
  );
}

/** Render a template for one person, or null when the name can't fill it. */
export function applyTemplate(template: string, name: string, domain: string): string | null {
  if (!isValidTemplate(template) || !domain) return null;
  const t = nameTokens(name);
  if (!t.length) return null;
  const first = t[0];
  const last = t.length > 1 ? t[t.length - 1] : '';
  let bad = false;
  const local = template.replace(TEMPLATE_TOKEN, (_m, tok: string) => {
    const v = tok === 'first' ? first : tok === 'last' ? last : tok === 'fi' ? first[0] : last[0];
    if (!v) bad = true;
    return v ?? '';
  });
  return bad || !local ? null : `${local}@${domain}`;
}

/**
 * A canonical name is already a formula, so it converts to a template mechanically:
 * "filast" -> "{fi}{last}". Left-to-right alternation keeps the longest-token behaviour.
 */
export const templateFor = (canonical: string): string =>
  canonical.replace(TOKEN, (t) => `{${t}}`);

/**
 * Build a person's email @ domain from either a canonical pattern name ("first.last")
 * or an observed template ("{last}.admin"). Returns null if unbuildable.
 *
 * Both go through applyTemplate, so a single-token name behaves consistently: it can
 * satisfy "first" ("Kate" -> kate@) but not "first.last", which needs a surname.
 */
export function buildEmail(pattern: string, name: string, domain: string): string | null {
  if (pattern.includes('{')) return applyTemplate(pattern, name, domain);
  if (!PATTERNS.has(pattern)) return null;
  return applyTemplate(templateFor(pattern), name, domain);
}
