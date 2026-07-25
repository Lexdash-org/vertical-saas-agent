import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * One place that knows where the project root, the .env and the out/ directory are.
 *
 * Every stage used to recompute these with a hardcoded `path.resolve(HERE, '../../.env')`,
 * which silently broke the moment a script moved one directory deeper. Stages now import
 * from here instead, so nesting depth stops being load-bearing.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Walk up until we find a package.json. Env override wins, for installs outside a repo. */
function findRoot(): string {
  const override = process.env.LEADGEN_ROOT;
  if (override) return path.resolve(override);
  let dir = HERE;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  throw new Error(
    'could not locate the project root (no package.json found above the skill folder). ' +
      'Set LEADGEN_ROOT to the directory holding package.json and out/.',
  );
}

const ROOT = findRoot();

/** Shared pipeline state. Every stage reads and writes the same master here. */
export const OUT_DIR = process.env.LEADGEN_OUT_DIR
  ? path.resolve(process.env.LEADGEN_OUT_DIR)
  : path.join(ROOT, 'out');

export const outPath = (name: string): string => path.join(OUT_DIR, name);

export const MASTER_CSV = outPath('team-master.csv');

let loaded = false;

/**
 * Load <root>/.env. Call once at the top of every entry point; libraries must not.
 *
 * `override: true` is deliberate and load-bearing: a stale ZYTE_API_KEY exported from a
 * shell profile otherwise shadows the valid key in .env and every fetch 401s.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  loadDotenv({ path: path.join(ROOT, '.env'), quiet: true, override: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}
