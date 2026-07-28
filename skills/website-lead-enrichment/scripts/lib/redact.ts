import { readEnv, SECRET_KEYS } from './env.js';

/**
 * Remove anything credential-shaped from text that came back from a provider.
 *
 * "Never print, log, or echo a credential value, including into an error message" is a
 * project rule stated in CLAUDE.md and in `references/providers.md`. This is the one place
 * that implements it, so the rule has a single definition to test and to fix.
 *
 * Not hypothetical: OpenAI's 401 body quotes the key back partially masked
 * (`sk-notar**lkey`) — the first eight and last four characters of a real credential.
 * Provider error text reaches a terminal, a ledger, or a pasted bug report.
 */

/**
 * Key prefixes worth masking on sight, for the masked forms a provider echoes back that
 * never equal the configured value.
 *
 * Deliberately narrow. A looser list containing `key` matched Zyte's `/auth/key-not-found`
 * error type and destroyed the diagnosis itself — the redactor has to leave the message
 * usable, or a user routes around it by printing the raw error.
 */
const KEY_SHAPED = /\b(?:sk|fc|xai|gsk)-[A-Za-z0-9_*-]{4,}/gi;

/**
 * A long opaque path segment inside a URL, which is how gateways that route by token embed
 * a credential — `https://gw.example.com/v1/tok_9f8e7d6c5b4a/`. Such a token need not be
 * any variable this project declares, so exact-match removal cannot reach it.
 *
 * The lookbehind requires a `://` and at least one `/` ahead of the segment, so the host is
 * never matched and a bare filesystem path in prose is left alone. The 16-character floor
 * keeps the diagnosis intact: the segments worth reading are short (`openai`, `v1`, `chat`),
 * and eliding them would remove the reason the endpoint is printed at all — telling an
 * Azure user their base URL is missing `/openai/v1/`.
 */
const URL_TOKEN = /(?<=https?:\/\/[^\s"'<>]*\/)[A-Za-z0-9_-]{16,}(?=\/|[\s"'<>]|$)/g;

export function redact(text: string): string {
  let out = text;
  // The secret list is declared in env.ts, which owns every variable name in the project.
  for (const key of SECRET_KEYS) {
    const value = readEnv(key);
    if (value) out = out.split(value).join('<redacted>');
  }
  return out.replace(KEY_SHAPED, '<redacted>').replace(URL_TOKEN, '<redacted>');
}

/**
 * An error's message, redacted and otherwise untouched.
 *
 * For code that *matches* on the text — retry predicates testing for `401`, `payment`,
 * `batch` — where collapsing whitespace or truncating could change the answer. Redaction
 * cannot: it only ever replaces a credential with a fixed token.
 */
export const messageOf = (err: unknown): string =>
  redact(err instanceof Error ? err.message : String(err));

/** An error rendered as one readable, redacted line — the form a terminal wants. */
export function brief(err: unknown, max = 200): string {
  return messageOf(err).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * HTTP status off an SDK error object, or off its message when the object carries none.
 *
 * Here rather than in `llm.ts` for two reasons. It is not LLM-specific — Firecrawl, Zyte
 * and the LLM all report through it. And `llm.ts` value-imports the Firecrawl and OpenAI
 * SDKs, so `site.ts` reaching into it for this one pure function loaded ~100 ms of
 * provider clients into every consumer of `parseCsv` — including the DNS-only, keyless
 * smoke test whose whole selling point is needing no credentials and starting fast.
 */
export function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number } | undefined;
  const direct = e?.status ?? e?.statusCode;
  if (typeof direct === 'number') return direct;
  return Number(/\b[45]\d\d\b/.exec(messageOf(err))?.[0]) || undefined;
}
