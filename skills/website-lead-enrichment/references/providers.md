# Providers and credentials

The single source for what each stage needs and what it must never substitute. The stage
references point here; they do not restate it.

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
corrupts the provenance contract in `./pipeline-state.md`. Missing credentials are a
configuration problem to surface, never a routing problem to work around.

## Credentials

Real values live in **`~/.leadgen/.env`** — one file, for every host and every project, so
a user running both Claude Code and Codex configures once and a skill reinstall cannot
delete their keys. `.env.example` documents the shape. `LEADGEN_ENV` points at a different
file, for tests and CI.

Every name is declared once in `scripts/lib/env.ts` and read through `readEnv()` /
`requireEnv()`. Nothing else in the project may name a variable — CI enforces it — because
a missed rename surfaces as "key not set", which looks exactly like a user who never
configured anything.

| Variable | Provider | Used for |
|---|---|---|
| `LEADGEN_FIRECRAWL_API_KEY` | Firecrawl | site URL mapping (stage 1 only) |
| `LEADGEN_ZYTE_API_KEY` | Zyte | every page fetch (stages 2, 3, 4) |
| `LEADGEN_LLM_API_KEY` | any OpenAI-compatible | ranking, extraction, pattern judgment |
| `LEADGEN_LLM_BASE_URL` | any OpenAI-compatible | omit for `api.openai.com` |
| `LEADGEN_LLM_MODEL_REASONING` | — | reasoning role — ranking and judgment |
| `LEADGEN_LLM_MODEL_EXTRACTION` | — | extraction role; defaults to the reasoning model |
| `LEADGEN_CODEX_MODEL` | Codex CLI | optional; defaults to `gpt-5.6-sol` |
| `LEADGEN_CODEX_BIN` | Codex CLI | optional **override** — Codex is auto-detected |
| `LEADGEN_OUT_DIR` | — | optional; results default to `./out` where the user runs |
| `LEADGEN_DEBUG` | — | optional; verbose agent step tracing |

### The prefix is the point

`LEADGEN_` is not decoration. A credential stored under a shared name — `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY` — silently switches Claude Code and Codex from the subscription the
user pays for to API billing. Owning the whole namespace means this project can never do
that to someone, whatever they set it in.

`OPENAI_API_KEY` must stay **unset**. Every Codex spawn deletes it from the child
environment so Codex authenticates against the ChatGPT subscription rather than a stray
API key. This project never reads it.

### Any OpenAI-compatible LLM

The LLM is not tied to one vendor. Anything speaking the OpenAI chat-completions API
works — OpenAI, Azure OpenAI, OpenRouter, Together, Groq, vLLM, Ollama, LM Studio. Set
`LEADGEN_LLM_BASE_URL` to the provider's base URL, omitting it for OpenAI itself.

There is **one** provider path. Azure had a dedicated preset; it was removed because Azure
already speaks the OpenAI API under `/openai/v1/`, so the preset was a second route to the
same place — and it cost a provider-selection bug, a four-deep model fallback chain, two
undocumented variables, and an either/or caveat in preflight. Azure users set:

```
LEADGEN_LLM_BASE_URL=https://<resource>.cognitiveservices.azure.com/openai/v1/
LEADGEN_LLM_MODEL_REASONING=<deployment name>
```

### Azure: the two ways the model name goes wrong

Both are configuration errors, they are the most common thing to get wrong here, and they
look nothing alike. `scripts/doctor/doctor.ts` names them; this is what it is telling you:

| Response | Meaning | Fix |
|---|---|---|
| `404 deployment does not exist` | No deployment on this resource carries that name | Copy the exact name from Azure AI Foundry → **Deployments** |
| `400 operation not allowed in this deployment` | The deployment exists, but not for chat completions | It is almost always a **Global Batch** deployment — redeploy as Standard or Global Standard |

**`GET /openai/v1/models` does not list your deployments.** It returns the model *catalog*
for the region — every model Azure could offer you, whether or not you have deployed one.
Pasting a name from that list produces a confident-looking configuration in which every
call 404s, and the response gives no hint that the name came from the wrong list. The
deployments blade in the portal is the only authority on what a valid model name is here.

Two roles exist because the jobs differ: **reasoning** ranks pages and adjudicates
ambiguous email formats; **extraction** pulls structured records out of page text. One
model can fill both — point the two variables at the same name, or set only the reasoning
one. Both roles need reliable JSON output (`response_format: json_object`); a model that
ignores that will fail extraction.

## What each stage actually demands

Ask for only the client you need — `scripts/lib/llm.ts` splits them for exactly this
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
runs against a **weekly** quota — see `./05-discover-web-emails.md` for the throttle.

## Preflight

Before starting a run, check the keys the selected stages need and report every missing
one at once rather than failing at the first stage that touches a provider.

`scripts/doctor/doctor.ts` does exactly that — one cheap call per configured provider,
PASS/FAIL/SKIP per line, non-zero exit only if something *configured* is broken. Run it
instead of reasoning about which variables are present: a key that is set but rejected
reads identically to a working one until something calls it.

The LLM needs `LEADGEN_LLM_API_KEY` and `LEADGEN_LLM_MODEL_REASONING`. There is one
provider path, so there is no either/or to reason about: if those two are set, the LLM is
configured.

For Codex, run `scripts/discover-web-emails/codex-usage-check.ts`. It uses the
same resolver the runner does, so it cannot report a binary that then fails to spawn, and
it exits cleanly when Codex is absent. Report that as "stage 5 will be skipped", not as a
missing prerequisite.

Codex is **auto-detected** — `LEADGEN_CODEX_BIN` if it points at a real executable, otherwise
`PATH`, otherwise the usual install locations (homebrew, nvm, volta, `~/.local/bin`). A
`LEADGEN_CODEX_BIN` pinned to a path that doesn't exist is reported and ignored rather than
trusted, because an absolute path copied between machines goes stale silently.

## Never do

- Print, log, or echo a credential value, including into a ledger or an error message.
  This one is enforced, not merely asked for: `scripts/lib/redact.ts` is the single
  redactor, stages exit through `reportFatal` and record caught errors through `brief`,
  and a CI invariant rejects any code that prints or stores an error message raw. It
  matters because a provider's own 401 body can quote the key back — OpenAI's gives up
  the first eight and last four characters of it.
- Copy `~/.leadgen/.env` into the skill folder or any distributed artifact.
- Commit a real key. `.env` is gitignored; `.env.example` carries placeholders only.
- Suggest putting a key in a shell profile. This project reads one file; a credential in
  `~/.zshrc` is global to every tool on the machine and outlives any uninstall.
