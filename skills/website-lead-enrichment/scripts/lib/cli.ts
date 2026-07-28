/**
 * Argument handling shared by every stage entry point.
 *
 * These were duplicated verbatim in up to ten scripts — including the "--input is
 * required" hint, which named a fixture path from seven different files. One copy.
 */
import { inspect } from 'node:util';
import { redact } from './redact.js';

export const argVal = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export const hasFlag = (flag: string): boolean => process.argv.includes(flag);

/** Fail loudly rather than silently defaulting to somebody's private lead list. */
export function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/**
 * The last thing a crashing stage prints. One choke point, because it is the one place a
 * provider's own words reach the user unedited.
 *
 * Every stage used to end `main().catch((e) => { console.error(e); process.exit(1); })`,
 * which prints the error object whole. OpenAI's 401 body quotes the key back partially
 * masked — the first eight and last four characters of a real credential — so a mistyped
 * key turned the standard crash path into a credential disclosure, in the output a user is
 * most likely to paste into a bug report.
 *
 * The stack is kept: redacting it costs nothing and losing it would make every stage
 * failure harder to diagnose than it needs to be.
 */
export function reportFatal(err: unknown): never {
  // `util.inspect`, not `err.stack`: the stack alone drops `err.cause` and the enumerable
  // fields an SDK error carries (`status`, `headers`, the response body). `scrape.ts` says
  // in its own retry comment that Undici reports the real network fault in the cause, not
  // the message — so printing only the stack would discard exactly the field this codebase
  // already identified as load-bearing. One `redact` still covers the whole rendering.
  console.error(redact(inspect(err, { depth: 3 })));
  process.exit(1);
}

/** The company-list CSV. Required everywhere; there is deliberately no default. */
export const requireInput = (flag = '--input'): string =>
  argVal(flag) ??
  die(`${flag} is required: pass a CSV of companies (see examples/input/companies.example.csv)`);

/**
 * Locate a column, failing loudly when it is absent.
 *
 * `header.indexOf()` returning -1 silently produced `row[-1] === undefined`, so three
 * stages printed "0 domains" and exited 0 on a CSV whose headers simply differed. That
 * is the worst possible failure for the first thing a new user touches.
 */
export function requireColumn(header: string[], name: string, flag = '--col'): number {
  const i = header.indexOf(name);
  if (i < 0) {
    die(`no "${name}" column in the input CSV. Header: ${header.join(', ')}. Pass ${flag} <name>.`);
  }
  return i;
}
