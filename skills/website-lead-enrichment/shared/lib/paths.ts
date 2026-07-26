import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { ENV } from './env.js';
import { die } from './cli.js';
import { parseCsv } from './site.js';

/**
 * Where the configuration and the output live.
 *
 * Both are absolute and independent of how the skill was installed. That is the point:
 * the skill is normally installed globally (`~/.claude/skills/`, `~/.agents/skills/`), and
 * anything derived from the install location either hides the user's results inside a
 * skills folder or gets wiped by the next reinstall.
 */

/**
 * The one config file, for every host and every project.
 *
 * A single absolute path means a user who runs both Claude Code and Codex configures their
 * keys once, and a reinstall of the skill cannot delete them. `LEADGEN_ENV` overrides it —
 * an explicit pointer for tests and CI, not project auto-discovery.
 */
export const CONFIG_ENV = process.env[ENV.envFile]
  ? path.resolve(process.env[ENV.envFile] as string)
  : path.join(os.homedir(), '.leadgen', '.env');

/**
 * Loaded at module load, before OUT_DIR is computed, so `LEADGEN_OUT_DIR` can come from
 * the config file. That used to be impossible — the config path depended on walking up
 * for a package.json, which had to happen after import time.
 *
 * `override: true` is deliberate and load-bearing: a stale key exported from a shell
 * profile otherwise shadows the valid one in the config file and every request 401s.
 */
const shellOutDir = process.env[ENV.outDir]; // captured before dotenv can overwrite it
loadDotenv({ path: CONFIG_ENV, quiet: true, override: true });

/**
 * Results land in the directory the user is standing in, not next to the installed skill.
 *
 * Precedence: a shell `LEADGEN_OUT_DIR` (how tests redirect a run) beats the config file,
 * which beats `./out`.
 */
export const OUT_DIR = path.resolve(
  shellOutDir ?? process.env[ENV.outDir] ?? path.join(process.cwd(), 'out'),
);

/**
 * `out/` holds ONLY the four files a user is meant to open; everything a stage needs
 * to resume lives under `out/.work/`.
 *
 * The split is about scale, not tidiness. Stage 2 writes one JSON per company, so a
 * flat `out/` on the 1,097-company run produced 1,113 files with the four deliverables
 * buried among them. Hiding the working set also answers "which of these can I delete?"
 * — all of `.work/` is disposable, at the cost of re-running.
 */
export const WORK_DIR = path.join(OUT_DIR, '.work');
/** Per-company extraction results from stage 2, one JSON each. */
export const COMPANIES_DIR = path.join(WORK_DIR, 'companies');
/** Append-only resume ledgers. See shared/PIPELINE-STATE.md. */
export const LEDGER_DIR = path.join(WORK_DIR, 'ledgers');

export const outPath = (name: string): string => path.join(OUT_DIR, name);
export const workPath = (...parts: string[]): string => path.join(WORK_DIR, ...parts);
export const ledgerPath = (name: string): string => path.join(LEDGER_DIR, name);

/**
 * The master is working state, not a deliverable: every stage reads and rewrites it, it
 * is 20 columns wide, and no salesperson will ever open it. It lives with the rest of the
 * resume state. The three files below are what a run is FOR.
 */
export const MASTER_CSV = workPath('team-master.csv');

/** The only files a user is meant to open. Named for what to DO with them. */
export const READY_CSV = outPath('ready-to-send.csv');
export const VERIFY_CSV = outPath('verify-before-sending.csv');
export const INBOX_CSV = outPath('company-inboxes.csv');
export const README_TXT = outPath('README.txt');

/** Structured run counts, so a caller reports from data rather than parsing console text. */
export const SUMMARY_JSON = workPath('run-summary.json');

/**
 * Create the output tree. Safe to call repeatedly; `recursive` makes the parents too.
 * Every entry point needs this, including the ones that never read `.env`.
 */
export function ensureDirs(): void {
  fs.mkdirSync(COMPANIES_DIR, { recursive: true });
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
}

/**
 * Read the master, or stop with a message that says what to run first.
 *
 * Every stage downstream of extraction needs it. A missing master means the pipeline was
 * started in the middle — nothing is broken — and an unhandled ENOENT stack trace is a
 * terrible answer to that, especially on a fresh install where it is the likeliest state.
 *
 * Stages that CREATE or fill the master (extract-team-members, harvest-business-emails,
 * resolve-email-domains) deliberately do not use this: for them an absent master is
 * normal and they carry on with an empty set.
 */
export function readMaster(): { header: string[]; rows: string[][] } {
  if (!fs.existsSync(MASTER_CSV)) {
    die(
      `no team-master.csv yet — nothing has been extracted into ${OUT_DIR}.\n` +
        '       Run the earlier stages first: discover-team-pages, then extract-team-members.\n' +
        '       They create the master this stage reads.',
    );
  }
  return parseCsv(fs.readFileSync(MASTER_CSV, 'utf8'));
}

/**
 * Write via a temp file and rename, so a crash can never leave a half-written file.
 *
 * Load-bearing for the master: every stage rewrites it whole, and a truncated master is
 * an unrecoverable run. `rename` within a directory is atomic on POSIX and NTFS.
 */
export function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

/**
 * Prepare an entry point to run. Call once at the top of each; libraries must not.
 *
 * The config file is already loaded by the time any module body runs (see CONFIG_ENV
 * above), so this only has to create the output tree. It keeps its name and its call
 * sites because "load the environment" is still what a stage means by it.
 */
export function loadEnv(): void {
  ensureDirs();
}
