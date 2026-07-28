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
import ts from 'typescript';
import { ENV, SECRET_KEYS } from '../../skills/website-lead-enrichment/scripts/lib/env.js';
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
/**
 * The role-inbox vocabulary lives in `lib/emails.ts` and nowhere else.
 *
 * CLAUDE.md already forbade a second copy; nothing enforced it, and four appeared. They
 * drifted exactly as the pattern table once did: `reception1@` matched in stage 3 and not
 * in stage 4, so one address was a company's primary inbox to one stage and an ordinary
 * address to the next. A rule this specific should fail a build, not a review.
 */
check('one role-inbox vocabulary', () => {
  const home = 'skills/website-lead-enrichment/scripts/lib/emails.ts';
  const offenders = walk('skills')
    .filter((f) => f !== home)
    .filter((f) => /\/\^?\(\?:?info\||\binfo\|reception\b/.test(fs.readFileSync(f, 'utf8')));
  if (offenders.length) {
    throw new Error(`role-inbox regex outside ${home}: ${offenders.join(', ')}`);
  }
  return `declared once, in ${home.split('/').pop()}`;
});

/**
 * A shell block in a shipped doc runs in whatever shell the user's agent has, and on macOS
 * that is zsh — which does not word-split an unquoted parameter. `for item in $NEEDS` is
 * five filenames under bash and one impossible one under zsh, so the install step aborted
 * for every macOS user while CI stayed green: the install job pins `shell: bash`, so it
 * cannot see this class of bug at all.
 *
 * Only fenced blocks are scanned — prose citing the broken form to warn against it, as the
 * install step now does, is the opposite of shipping it. Quoted spans are dropped first,
 * which is what makes `"$@"` and `"$SKILLS_DIR/..."` legal: both survive any shell.
 */
/** Every shipped document whose fenced blocks a user's agent will actually execute. */
const DOCS = [...walk('skills', '.md'), 'README.md', 'TESTING.md'];

interface ShellLine { file: string; lineNo: number; line: string; }

/** Every line inside a fenced block, across the shipped docs. Walked once. */
const FENCED_SHELL_LINES: ShellLine[] = DOCS.flatMap((file) => {
  const out: ShellLine[] = [];
  let fenced = false;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('```')) { fenced = !fenced; return; }
    if (fenced) out.push({ file, lineNo: i + 1, line });
  });
  return out;
});

/**
 * The word list of every `for … in …` inside a fenced block, with quoted spans removed —
 * those are literals and survive any shell. One scanner, because two hand-copied copies of
 * it had already disagreed about whether `$(…)` counts as part of the list, which is the
 * same duplicate-source-of-truth failure this file exists to reject everywhere else.
 */
const FOR_LISTS: (ShellLine & { list: string })[] = FENCED_SHELL_LINES.flatMap((s) => {
  const list = /^\s*for\s+\w+\s+in\s+([^;]*?)(?:;|\s\bdo\b|$)/.exec(s.line)?.[1];
  return list === undefined
    ? []
    : [{ ...s, list: list.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '') }];
});

/**
 * Shell hazards that make a shipped block behave differently under bash and zsh.
 *
 * A shell block in a shipped doc runs in whatever shell the user's agent has, and on macOS
 * that is zsh. The install job pins `shell: bash`, so it cannot see this class of bug at
 * all — every one of these was found by a person on a Mac, after CI went green.
 *
 * Two hazards so far, pointing in opposite directions, which is why this is a table rather
 * than a check: the third one someone finds is a row, not a third copy of the scanner.
 */
const SHELL_HAZARDS: { name: string; why: string; hit: (list: string) => boolean }[] = [
  {
    name: 'unquoted expansion in a for-list',
    why: 'splits into words under bash and stays one impossible filename under zsh',
    // `for item in $NEEDS` — five entries under bash, one under zsh, which aborted the
    // install for every macOS user.
    hit: (list) => list.includes('$'),
  },
  {
    name: 'glob in a for-list',
    why: 'a glob matching nothing aborts the whole block under zsh, where bash carries on',
    // Command substitution may contain a glob — it runs in its own context, and its
    // emptiness is a value rather than a fatal error.
    hit: (list) => /[*?]|\[[^\]]+\]/.test(list.replace(/\$\([^)]*\)/g, '')),
  },
];

check('shell blocks are shell-portable', () => {
  // The rationale rides on the offending line rather than a fixed header, so a lone glob
  // is not reported under a paragraph that also explains word-splitting.
  const offenders = SHELL_HAZARDS.flatMap((h) =>
    FOR_LISTS
      .filter((f) => h.hit(f.list))
      .map((f) => `${f.file}:${f.lineNo} — ${h.name}, which ${h.why}\n        ${f.line.trim()}`),
  );
  if (offenders.length) throw new Error(`shell blocks are not portable:\n    ${offenders.join('\n    ')}`);
  return `${DOCS.length} docs, ${FOR_LISTS.length} for-lists, ${SHELL_HAZARDS.length} hazards clear`;
});

/**
 * The install steps each re-derive `SKILLS_DIR` themselves, because a variable set in one
 * fenced block is gone by the next — most agent runtimes give each command a fresh shell.
 * That repetition is deliberate and cannot be factored out: at the point it first runs,
 * nothing is installed yet, so there is no file to source it from.
 *
 * It is still *logic*, not a constant. Add a third runtime or an `XDG_DATA_HOME` rule and
 * every copy has to move together — the same reason CLAUDE.md and AGENTS.md are compared
 * rather than trusted.
 */
check('every re-derived install path agrees', () => {
  // All four are re-derived per block and drift the same way. Guarding only SKILLS_DIR
  // would leave DEST — the value every block actually consumes — unchecked.
  // Every assignment on the line, not just the leading one. These derivations carry a
  // fallback on the same line — `SKILLS_DIR=…claude…; [ -d … ] || SKILLS_DIR=…agents…` —
  // and an earlier version compared only up to the first `;`, so the second assignment
  // could drift freely. That is the `.agents` branch: the least-exercised install path,
  // and the one a check exists to protect.
  const ASSIGN = /\b(SKILLS_DIR|DEST|STAGE|CHECK)=("[^"]*"|\S*)/g;
  const byName = new Map<string, Map<string, string>>();
  for (const s of FENCED_SHELL_LINES) {
    // The ordered set of values a line assigns to each name — order matters, since it is
    // the fallback chain.
    const perName = new Map<string, string[]>();
    for (const m of s.line.matchAll(ASSIGN)) {
      perName.set(m[1], [...(perName.get(m[1]) ?? []), m[2]]);
    }
    for (const [name, values] of perName) {
      const derivation = values.join(' || ');
      const spellings = byName.get(name) ?? new Map<string, string>();
      // First location wins, so the failure names where the majority form lives.
      if (!spellings.has(derivation)) spellings.set(derivation, `${s.file}:${s.lineNo}`);
      byName.set(name, spellings);
    }
  }
  if (!byName.size) throw new Error('no install-path derivations found — did the install step move?');
  const drifted = [...byName].filter(([, spellings]) => spellings.size > 1);
  if (drifted.length) {
    throw new Error(
      drifted
        .map(([name, s]) => `${name} has ${s.size} spellings:\n    ${[...s].map(([t, w]) => `${w} → ${t}`).join('\n    ')}`)
        .join('\n  '),
    );
  }
  return `${byName.size} names, each spelled one way`;
});

/**
 * Every credential in `ENV` must be listed in `SECRET_KEYS`, or `redact` stops covering it.
 *
 * `SECRET_KEYS` sits next to `ENV` so the two are read together, but proximity is not
 * enforcement: adding a fourth credential and forgetting the list fails *silently* — no
 * compile error, no test failure, the value simply starts appearing in ledgers. The naming
 * convention is the tell, so it is what gets checked.
 */
check('every credential is declared secret', () => {
  const looksSecret = Object.keys(ENV).filter((k) => /Key$/.test(k));
  if (!looksSecret.length) throw new Error('no *Key variables found — did ENV get renamed?');
  const missing = looksSecret.filter((k) => !(SECRET_KEYS as readonly string[]).includes(k));
  if (missing.length) {
    throw new Error(`in ENV but absent from SECRET_KEYS, so redact() will not remove them: ${missing.join(', ')}`);
  }
  return `${looksSecret.length} credentials, all redacted`;
});

/**
 * No stage may print or persist a caught error without redacting it first.
 *
 * `console.error(err)` prints the error object whole, and a provider's 401 body can quote
 * the key back partially masked — OpenAI's does, giving up the first eight and last four
 * characters. Nine stages ended exactly that way, so a mistyped key turned the ordinary
 * crash path into a credential disclosure, in the output most likely to be pasted into a
 * bug report. Two stages also wrote the raw message into a ledger and an output CSV, where
 * sanitising the console alone would have left it on disk.
 *
 * `reportFatal` (lib/cli.ts) and `brief` (lib/redact.ts) are the sanctioned exits.
 */
/**
 * The only functions allowed to receive a caught error directly.
 *
 * `explainLlmError` qualifies because it reads the error solely through `statusOf` and
 * `messageOf` and returns fixed sentences — it never passes provider text through.
 */
const ERROR_SINKS = new Set([
  'brief', 'messageOf', 'redact', 'reportFatal', 'statusOf', 'explainLlmError',
]);

/**
 * Error fields that cannot carry a credential: numbers and short enum-ish codes.
 *
 * Reading `err.code` to tell ENOTFOUND from ETIMEDOUT is not a disclosure risk, and
 * forcing it through a redactor would be cargo cult. `message`, `stack`, `cause`,
 * `response` and `body` are deliberately absent — those carry the provider's own words.
 */
const SAFE_ERROR_PROPS = new Set(['code', 'errno', 'status', 'statusCode', 'name']);

/**
 * Is this reference to a caught error safe?
 *
 * Safe means the raw value cannot reach a terminal, a file, or a model from here:
 *   - it is an argument to a redactor (`brief(err)`, `messageOf(err.cause)`)
 *   - it is being type-tested (`err instanceof Error`)
 *   - it is re-thrown, or stored for a later re-throw (`lastErr = err`)
 *
 * Storing is allowed without following the alias, which is the one thing this does not
 * prove. Both current cases (`scrape.ts`, `site.ts`) store only to `throw` later.
 */
function isSafeUse(ref: ts.Identifier): boolean {
  let node: ts.Node = ref;
  while (node.parent && !ts.isCatchClause(node.parent)) {
    const parent = node.parent;
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (ERROR_SINKS.has(calleeName)) return true;
    }
    if (ts.isThrowStatement(parent)) return true;
    // `err.code`, and the same through a cast or optional chain.
    if (ts.isPropertyAccessExpression(parent) && SAFE_ERROR_PROPS.has(parent.name.text)) return true;
    if (ts.isBinaryExpression(parent)) {
      if (parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return true;
      // `lastErr = err` — stored, not emitted.
      if (parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) return true;
    }
    node = parent;
  }
  return false;
}

check('caught errors are redacted before they are printed or stored', () => {
  /**
   * Parsed, not pattern-matched.
   *
   * The first two versions of this were a list of regexes for shapes I had already seen,
   * and they leaked in every direction: `console.log(err)` (only `console.error` was
   * listed), `console.error('context:', err)` (the error had to be the sole argument),
   * `${err}` bare template coercion, `err.stack`, `err.cause`, a catch bound to any name
   * other than err/e/error, and anything wrapped across two lines. One of them even
   * carried a `\1` backreference into a pattern with no capture groups, so it enforced
   * nothing at all.
   *
   * Every one of those is closed by asking the compiler instead: find each `catch`
   * binding, then find every reference to it, and require that each reference is either
   * handed to a redactor, tested with `instanceof`, re-thrown, or stored in a variable.
   * `typescript` is already a devDependency, so this costs no new install.
   */
  const offenders: string[] = [];
  for (const file of walk('skills')) {
    // The redactors themselves must handle the raw value — that is their job.
    if (/lib[\\/](redact|cli)\.ts$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);

    const visitCatch = (clause: ts.CatchClause): void => {
      const bound = clause.variableDeclaration?.name;
      if (!bound || !ts.isIdentifier(bound)) return; // `catch { }` binds nothing
      const name = bound.text;

      const checkRef = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === name && node !== bound) {
          if (!isSafeUse(node)) {
            const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
            offenders.push(
              `${file}:${line + 1} — \`${name}\` reaches output unredacted` +
                `\n        ${text.split('\n')[line].trim()}`,
            );
          }
          return;
        }
        node.forEachChild(checkRef);
      };
      clause.block.forEachChild(checkRef);
    };

    const walkNode = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) visitCatch(node);
      node.forEachChild(walkNode);
    };
    walkNode(src);
  }
  if (offenders.length) throw new Error(`unredacted provider text:\n    ${offenders.join('\n    ')}`);
  return `every catch binding reaches output through ${[...ERROR_SINKS].join('/')}`;
});

check('no invented Codex quota rate', () => {
  const rate = /\d+\s*%[^.]{0,40}\bper\b[^.]{0,30}\bsearch(es)?\b/i;
  // Whitespace is collapsed before matching, so a line break cannot hide the claim — a
  // paragraph wrapping "1% per 16 / searches" asserts exactly what one line would, and a
  // per-line check waves it through. Quoted spans are dropped first: citing the discredited
  // figure to warn against it is the opposite of asserting it, and the docs do exactly that.
  const bad = DOCS.filter((f) =>
    rate.test(fs.readFileSync(f, 'utf8').replace(/"[^"]*"/g, '').replace(/\s+/g, ' ')),
  );
  if (bad.length) throw new Error(`quota rate stated as fact in ${bad.join(', ')}`);
  return `${DOCS.length} docs carry no invented per-search rate`;
});

if (failures.length) {
  console.error(`\n${failures.length} invariant(s) broken`);
  process.exit(1);
}
console.log('\nall invariants hold');
