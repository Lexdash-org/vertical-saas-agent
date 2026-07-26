/**
 * Every environment variable this project reads, declared exactly once.
 *
 * Two reasons this file exists rather than string literals scattered across the stages:
 *
 * 1. **Renaming must not fail at runtime.** A mistyped or missed variable name surfaces as
 *    "key not set", which is indistinguishable from a user who never configured anything —
 *    the worst possible error during onboarding. Going through `readEnv('zyteKey')` makes
 *    a typo a TypeScript error instead.
 *
 * 2. **Nothing here may collide with another tool.** Every name is prefixed `LEADGEN_`.
 *    An API key in a shared name like `OPENAI_API_KEY` silently switches Claude Code and
 *    Codex from subscription billing to API billing, so this project owns its namespace
 *    completely and never reads a variable another CLI might also read.
 *
 * `OPENAI_API_KEY` is deliberately absent: it is never *read*, only deleted from the
 * environment handed to a Codex child process so Codex uses the ChatGPT subscription.
 *
 * This is the only file allowed to touch `process.env` — enforced by
 * `.github/scripts/check-invariants.ts`.
 */

import os from 'node:os';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

export const ENV = {
  firecrawlKey: 'LEADGEN_FIRECRAWL_API_KEY',
  zyteKey: 'LEADGEN_ZYTE_API_KEY',
  llmKey: 'LEADGEN_LLM_API_KEY',
  llmBaseUrl: 'LEADGEN_LLM_BASE_URL',
  llmModelReasoning: 'LEADGEN_LLM_MODEL_REASONING',
  llmModelExtraction: 'LEADGEN_LLM_MODEL_EXTRACTION',
  codexBin: 'LEADGEN_CODEX_BIN',
  codexModel: 'LEADGEN_CODEX_MODEL',
  outDir: 'LEADGEN_OUT_DIR',
  envFile: 'LEADGEN_ENV',
  debug: 'LEADGEN_DEBUG',
} as const;

export type EnvKey = keyof typeof ENV;

/** Where the one config file lives, for error messages. Kept here so it reads the same everywhere. */
export const CONFIG_HINT = '~/.leadgen/.env';

/**
 * The one config file, for every host and every project.
 *
 * Resolved from the shell only — `LEADGEN_ENV` is the pointer *to* the file, so it cannot
 * live inside it. An explicit override for tests and CI, not project auto-discovery.
 */
export const CONFIG_ENV = process.env[ENV.envFile]
  ? path.resolve(process.env[ENV.envFile] as string)
  : path.join(os.homedir(), '.leadgen', '.env');

let configLoaded = false;

/**
 * Load the config file, once.
 *
 * **Lazy on purpose, and the ordering is load-bearing.** `paths.ts` must read the shell's
 * `LEADGEN_OUT_DIR` *before* this runs: `override: true` is deliberate — it stops a stale key
 * exported from a shell profile shadowing the valid one and 401ing every request — but it
 * would equally let the file win over the shell for the output directory, which is how tests
 * redirect a run. Loading at module scope here would silently break that.
 *
 * `readEnv` calls this so a caller who imports only this module still sees configured keys.
 * It used to be `paths.ts` that loaded the file, as an import side effect, which meant
 * reading a credential without having imported `paths.ts` returned undefined and reported a
 * fully configured machine as unconfigured — precisely the failure this file exists to
 * prevent, per rule 1 above. It cost a real session a wrong diagnosis before it was found.
 */
export function loadConfig(): void {
  if (configLoaded) return;
  configLoaded = true;
  loadDotenv({ path: CONFIG_ENV, quiet: true, override: true });
}

/** Read a declared variable. Empty string is treated as unset — a blank line in .env. */
export function readEnv(key: EnvKey, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Only for the real environment: an injected env is a test's own, and must stay untouched.
  if (env === process.env) loadConfig();
  const raw = env[ENV[key]];
  return raw && raw.trim() ? raw.trim() : undefined;
}

/**
 * Read a variable that the caller cannot proceed without.
 *
 * The single "missing credential" message in the project: it names the variable, says what
 * it is for, and points at the file to put it in. A user who sees this should not have to
 * search the docs to act on it.
 */
export function requireEnv(key: EnvKey, purpose: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = readEnv(key, env);
  if (value) return value;
  throw new Error(
    `${ENV[key]} is not set — needed for ${purpose}.\n` +
      `Add it to ${CONFIG_HINT} (one line: ${ENV[key]}=...), then run again.`,
  );
}
