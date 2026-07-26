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

/** Read a declared variable. Empty string is treated as unset — a blank line in .env. */
export function readEnv(key: EnvKey, env: NodeJS.ProcessEnv = process.env): string | undefined {
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
