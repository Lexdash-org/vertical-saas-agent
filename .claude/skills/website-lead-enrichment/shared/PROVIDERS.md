# Providers and credentials

The single source for what each stage needs and what it must never substitute. Subskills
reference this file; they do not restate it.

## The no-fallback rule

Every stage below names the provider it requires. When that provider's credential is
missing, **report the missing prerequisite and stop**. Do not substitute:

- agent-native browsing or the harness's own fetch/web tools
- `curl`, `wget`, plain HTTP, or a scripted HTTP client
- Playwright, Puppeteer, or any local headless browser
- a search engine in place of a site map
- a guessed URL (`/team`, `/about`) in place of a discovered one

The pipeline's value is that every returned address is traceable to a named source. A
silent fallback produces rows that look identical to sourced ones but aren't, which
corrupts the provenance contract in `PIPELINE-STATE.md`. Missing credentials are a
configuration problem to surface, never a routing problem to work around.

## Credentials

Real values live in `<project-root>/.env`, which is gitignored. `.env.example` documents
the shape. `loadEnv()` in `shared/lib/paths.ts` loads it for every entry point.

| Variable | Provider | Used for |
|---|---|---|
| `FIRECRAWL_API_KEY` | Firecrawl | site URL mapping (stage 1 only) |
| `ZYTE_API_KEY` | Zyte | every page fetch (stages 2, 3, 4) |
| `LLM_API_KEY` **or** `AZURE_OPENAI_API_KEY` | any OpenAI-compatible | ranking, extraction, pattern judgment |
| `LLM_BASE_URL` **or** `AZURE_OPENAI_ENDPOINT` | any OpenAI-compatible | omit `LLM_BASE_URL` for `api.openai.com` |
| `LLM_MODEL_REASONING` **or** `AZURE_OPENAI_DEPLOYMENT_SOL` | — | reasoning role — ranking and judgment |
| `LLM_MODEL_EXTRACTION` **or** `AZURE_OPENAI_DEPLOYMENT_LUNA` | — | extraction role — people out of page text |
| `CODEX_MODEL` | Codex CLI | optional; defaults to `gpt-5.6-sol` |
| `CODEX_BIN` | Codex CLI | optional **override** — Codex is auto-detected |

**The LLM rows are either/or.** Reporting `LLM_API_KEY: missing` on a machine configured
with the Azure preset is a false alarm — check for *one of each pair*, not for `LLM_*`
specifically. A working Azure setup has no `LLM_*` variables at all.
| `LEADGEN_ROOT` | — | optional; project root when installed outside the repo |
| `LEADGEN_OUT_DIR` | — | optional; redirect pipeline state, e.g. for a test run |

### Any OpenAI-compatible LLM

The LLM is not tied to one vendor. Anything speaking the OpenAI chat-completions API
works — OpenAI, Azure OpenAI, OpenRouter, Together, Groq, vLLM, Ollama, LM Studio. Set
`LLM_BASE_URL` to the provider's base URL (omit it for OpenAI itself).

Two roles exist because the jobs differ: **reasoning** ranks pages and adjudicates
ambiguous email formats; **extraction** pulls structured records out of page text. One
model can fill both — point the two variables at the same name. Both roles need reliable
JSON output (`response_format: json_object`); a model that ignores that will fail
extraction.

**Azure preset.** The validated defaults are Azure `gpt-5.6-sol` (reasoning) and
`gpt-5.6-luna` (extraction). Setting `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_DEPLOYMENT_SOL` and `AZURE_OPENAI_DEPLOYMENT_LUNA` works instead of the
`LLM_*` variables — the `/openai/v1` compatible path is applied automatically, and the
model name is the deployment name. `LLM_*` wins when both are present.

`OPENAI_API_KEY` must stay **unset**. Stage 5 deletes it from the Codex child environment
so Codex authenticates against the ChatGPT subscription rather than a stray API key.

## What each stage actually demands

Ask for only the client you need — `shared/lib/llm.ts` splits them for exactly this
reason. A stage that never fetches a page must not fail on a missing scraping key.

| Stage | Firecrawl | Zyte | LLM | Codex |
|---|---|---|---|---|
| 1 discover-team-pages | required | — | reasoning | — |
| 2 extract-team-members | — | required | reasoning + extraction | — |
| 3 harvest-business-emails | — | required | — | — |
| 4 recover-related-emails | — | required | — | — |
| 5 discover-web-emails | — | — | — | **optional — skip the stage** |
| 6 resolve-email-domains | — | — | — | — |
| 7 learn-email-patterns | — | — | reasoning (skip with `--no-ai`) | — |
| 8 email-permutation | — | — | — | — |

Stages 6 and 8 need no credentials at all. Stage 6 is plain DNS; stage 8 is string
generation. Both are free to re-run, which is why the pipeline leans on them.

## Codex is optional — stage 5 can be skipped

**Codex is not required to use this skill.** If it isn't installed, or the user doesn't
want to spend the quota, skip stage 5 and run the pipeline without it. Do not treat a
missing Codex as a blocked run, and do not ask the user to install it.

What skipping costs: only the open-web addresses — a clinician's `@hospital.org.au` or
`@university.edu` published on a paper or staff register. Every other source is unaffected.
Stages 1–4 still collect real emails from the companies' own sites, and stages 6–8 still
predict the rest. In practice stage 5 is the smallest contributor of the five real-email
stages.

There is **no substitute** for it. Do not fall back to agent-native browsing or a search
engine to approximate it — that reintroduces exactly the unsourced, unverified-identity
addresses the stage's guards exist to prevent. Skip it, and say so in the run summary.

When Codex *is* used it needs an authenticated CLI (`codex login`) at version ≥ 0.145 and
runs against a **weekly** quota — see the discover-web-emails subskill for the throttle.

## Preflight

Before starting a run, check the keys the selected stages need and report every missing
one at once rather than failing at the first stage that touches a provider.

Check the LLM as **either** `LLM_API_KEY` **or** `AZURE_OPENAI_API_KEY` — never report one
missing while the other is set.

For Codex, run `subskills/discover-web-emails/scripts/codex-usage-check.ts`. It uses the
same resolver the runner does, so it cannot report a binary that then fails to spawn, and
it exits cleanly when Codex is absent. Report that as "stage 5 will be skipped", not as a
missing prerequisite.

Codex is **auto-detected** — `CODEX_BIN` if it points at a real executable, otherwise
`PATH`, otherwise the usual install locations (homebrew, nvm, volta, `~/.local/bin`). A
`CODEX_BIN` pinned to a path that doesn't exist is reported and ignored rather than
trusted, because an absolute path copied between machines goes stale silently.

## Never do

- Print, log, or echo a credential value, including into a ledger or an error message.
- Copy `.env` into the skill folder or any distributed artifact.
- Commit a real key. `.env` is gitignored; `.env.example` carries placeholders only.
