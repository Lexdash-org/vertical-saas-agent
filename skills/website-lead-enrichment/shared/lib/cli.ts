/**
 * Argument handling shared by every stage entry point.
 *
 * These were duplicated verbatim in up to ten scripts — including the "--input is
 * required" hint, which named a fixture path from seven different files. One copy.
 */

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
