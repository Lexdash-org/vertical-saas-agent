# Website Lead Enrichment

Turn a list of company websites into the **people who work there and their email
addresses** — for the case where the contacts exist in no data vendor, only on the
companies' own sites.

Built and validated on 1,097 Australian private medical clinics, which produced 9,122
people.

This is an **Agent Skill**, not a CLI. You point a coding agent at a CSV of websites and it
runs the pipeline for you. Built and tested on Claude Code; the skill body names no
host-specific tools, so any agent that reads `SKILL.md` and can run shell commands should
work.

---

## What it does

Eight stages, in three groups:

```
EXTRACT (real addresses)            DISCOVER (real)          PREDICT (the rest)
──────────────────────              ───────────────          ──────────────────
1. rank team pages    (Firecrawl+LLM)
2. scrape + extract people (Zyte+LLM)  5. open-web search    6. MX-confirm the mail domain
3. harvest business inboxes (Zyte)        via Codex          7. learn each company's format
4. recover cross-domain inboxes (Zyte)    (OPTIONAL)         8. permute + rank candidates
```

Every person ends with a `best_email` and a **`best_email_basis`** saying how much to
trust it:

`known` (scraped) > `web-found` (sourced, with a URL) > `learned:<pattern>` > `default:first.last`

The separation is the point. Scraped and sourced addresses are real; anything with a
`learned:` or `default:` basis is a **guess that has never been verified**.

## Project status

**Pre-release.** The pipeline is validated on a real 1,097-company run, but:

- No automated test suite — see [How to run tests](#how-to-run-tests) for what does exist.
- Stage 5 hardcodes `Australia` into its location string; adapt before using it elsewhere.
- Stage 4 matches "same business, different domain" by a 6-character prefix, which is
  deliberately loose and can occasionally merge two similarly-named businesses.
- The installer's release-download path expects a tagged GitHub release; installing from
  a clone works today.

## Requirements

| | |
|---|---|
| Node.js | 20+ (uses `tsx`; no build step) |
| Firecrawl | API key — site URL mapping (stage 1) |
| Zyte | API key — page fetching (stages 2–4) |
| An LLM | Any OpenAI-compatible endpoint (see [Configuration](#configuration)) |
| Codex CLI | **Optional.** Only for stage 5; skip it and everything else runs |

Stages 6 and 8 need no credentials at all — stage 6 is plain DNS, stage 8 is string
generation.

## Installation

Just ask for what you want — *"find the staff emails for these clinic websites"* — and the
`find-team-emails` skill sets everything up the first time, then runs. It checks what is
already in place, so asking again later goes straight to the work.

By hand, from a clone:

```bash
git clone https://github.com/Lexdash-org/vertical-saas-agent
cd vertical-saas-agent
npm install
mkdir -p ~/.leadgen && cp .env.example ~/.leadgen/.env   # then fill it in
```

To use it globally rather than from the clone, copy the skill folder plus the files it
needs to run into your agent's skills directory — `~/.claude/skills/` for Claude Code,
`~/.agents/skills/` for the cross-runtime location that Codex, Copilot CLI and Gemini CLI
also read:

```bash
DEST=~/.claude/skills            # or ~/.agents/skills
cp -R skills/website-lead-enrichment "$DEST/"
cp package.json tsconfig.json .env.example "$DEST/website-lead-enrichment/"
cp -R examples "$DEST/website-lead-enrichment/"
cd "$DEST/website-lead-enrichment" && npm install
```

The `package.json` matters because npm resolves the stages' dependencies from it — but it
no longer affects where anything is read from or written to. Credentials come from
`~/.leadgen/.env` and results go to `./out` wherever you run, both independent of where the
skill happens to be installed.

## Basic usage

Give your agent a CSV with a website column and ask in plain language:

> Enrich this list of clinic websites — I need staff names and email addresses.
> `examples/input/companies.example.csv`

It confirms the plan once (how many companies, which stages, what it will spend), then
runs stages 1–4 and 6–8 straight through. It pauses before stage 5 only, because that one
is optional and spends a weekly Codex quota.

You get three files, and `out/` contains nothing else but a `README.txt` explaining them:

| File | Contents | Safe to send? |
|---|---|---|
| `ready-to-send.csv` | people with a real address | **yes** |
| `company-inboxes.csv` | one row per company with a published inbox | **yes** — reaches the business, not a person |
| `verify-before-sending.csv` | `learned:` / `default:` guesses | **no — verify first** |

Both person files share the same columns, so one saved column mapping works for either:

```
first_name, last_name, email, title, company, domain, website,
status, source, proof, business_email, all_business_emails, all_predicted_emails
```

`email` is the address to send to. `status` and `source` say in plain English how much to
trust it, and `proof` is a link you can open — the page the address was published on, or
the real address a format was copied from. A prediction has no proof, and says so.

Everything the pipeline needs to resume, including the full master CSV, lives in
`out/.work/`. `out/.work/run-summary.json` holds the machine-readable counts.

> **Sending `verify-before-sending.csv` without running it through an email verification
> service will generate bounces and damage your sending domain.** For a list of small
> businesses, `company-inboxes.csv` is usually the largest of the sendable files.

<details>
<summary>Running a stage by hand (for working on this repo)</summary>

```bash
S=skills/website-lead-enrichment/subskills
L=data/your-list.csv     # --input is required; there is no default
npx tsx $S/discover-team-pages/scripts/rank-batch.ts --input $L --col Website --name-col Name
npx tsx $S/extract-team-members/scripts/run-batch.ts --input $L
npx tsx $S/harvest-business-emails/scripts/harvest-business-emails.ts --input $L
npx tsx $S/recover-related-emails/scripts/harvest-related.ts --input $L
npx tsx $S/discover-web-emails/scripts/enrich-web-search.ts --source-csv $L   # optional
npx tsx $S/resolve-email-domains/scripts/resolve-email-domains.ts --input $L
npx tsx $S/learn-email-patterns/scripts/learn-email-patterns.ts
npx tsx $S/email-permutation/scripts/apply-permutation.ts
```

Run them one at a time — two stages writing `out/.work/team-master.csv` concurrently will
clobber each other. Every stage is resumable; re-running one picks up where it stopped.

</details>

## Configuration

**One file, in your home directory:**

```bash
mkdir -p ~/.leadgen && cp .env.example ~/.leadgen/.env
```

It is not inside the project and not inside the installed skill, so the same keys work from
every folder and on every agent, and reinstalling the skill cannot delete them.

| Variable | Required | Purpose |
|---|---|---|
| `LEADGEN_FIRECRAWL_API_KEY` | yes | site URL mapping (stage 1) |
| `LEADGEN_ZYTE_API_KEY` | yes | page fetching (stages 2–4) |
| `LEADGEN_LLM_API_KEY` | yes | any OpenAI-compatible provider |
| `LEADGEN_LLM_BASE_URL` | no | omit for `api.openai.com`; else the provider's base URL |
| `LEADGEN_LLM_MODEL_REASONING` | yes | ranking and format judgment |
| `LEADGEN_LLM_MODEL_EXTRACTION` | no | people out of page text; defaults to the reasoning model |
| `LEADGEN_CODEX_MODEL` | no | stage 5 model, defaults to `gpt-5.6-sol` |
| `LEADGEN_CODEX_BIN` | no | override only — Codex is auto-detected from `PATH` |
| `LEADGEN_OUT_DIR` | no | results default to `./out` in the folder you run from |
| `LEADGEN_DEBUG` | no | verbose agent step tracing |

Any OpenAI-compatible endpoint works — OpenRouter, Together, Groq, Ollama, vLLM, and Azure
via `https://<resource>.cognitiveservices.azure.com/openai/v1/` with your deployment names
as the model names. Base URLs for each are listed in `.env.example`.

**Every variable is prefixed `LEADGEN_` so it cannot collide with another tool.** That
matters: a key stored under a shared name like `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
silently switches Claude Code and Codex from the subscription you pay for to API billing.
This project never reads either one — and keep `OPENAI_API_KEY` unset, because every Codex
spawn strips it so Codex uses your ChatGPT subscription.

Full contract: `skills/website-lead-enrichment/shared/PROVIDERS.md`.

## How to run tests

**There is no unit test suite yet.** What exists is a typecheck plus a handful of
invariant checks — enough to catch a broken skill or a regressed generator, not enough
to trust a refactor blindly.

```bash
npm run check                     # SKILL.md spec compliance + project invariants
npm run typecheck                 # tsc --noEmit across the whole skill
npx tsc --noEmit --noUnusedLocals # also catches dead code
```

`npm run check` verifies that every `SKILL.md` matches the Agent Skills specification and
that its relative links resolve, that the pattern table is intact, that blind generation
still produces 18 dot-only candidates (16 when initials collide), and that the shipped
example contains no predicted addresses.

A free, keyless smoke test that exercises the install, dependencies and path resolution
(DNS only, no credits):

```bash
LEADGEN_OUT_DIR=/tmp/wle-smoke npx tsx \
  skills/website-lead-enrichment/subskills/resolve-email-domains/scripts/resolve-email-domains.ts \
  --input examples/input/companies.example.csv
```

A provider breakdown means it works. Manual end-to-end scenarios — including the
new-user install and a "does it refuse unsafe fallbacks" check — are in
[TESTING.md](TESTING.md).

Contributions adding real tests are very welcome; start with `shared/lib/`, which is pure
and has no I/O.

## Data and privacy

This tool collects business contact details about identifiable people, and predicts
addresses that have never been verified to belong to anyone.

- Pipeline output is **never committed** — `out/` and any `out-*/` scratch directory are
  gitignored.
- `examples/output/enriched-sample.csv` holds **50 verified addresses** — every one read directly
  off the company's own website, on that company's own domain, where the company published
  it themselves. No predicted or guessed address appears in it, and nothing sourced
  off-domain does either. `.github/scripts/make-samples.ts` is committed so that filter is
  auditable.
- What you may lawfully do with collected data is governed by privacy and anti-spam law
  where you and your targets are — GDPR, the Australian Privacy Act and Spam Act,
  CAN-SPAM — not by this project's licence. Check your obligations before sending.

## License

MIT — see [LICENSE](LICENSE).

## Reporting problems

Open an issue: <https://github.com/Lexdash-org/vertical-saas-agent/issues>

Useful things to include:

- which stage, and the exact command or request
- the console output (**redact your keys and any real contact data**)
- your Node version, and which LLM provider you configured
- whether Codex is installed

Please do not paste `.env` contents, real lead lists, or enrichment output into an issue.

**Security issues** — do not open a public issue. Email <mohan@lexdash.app>; see
[SECURITY.md](SECURITY.md).

Want to contribute? [CONTRIBUTING.md](CONTRIBUTING.md) covers the layout, the conventions
that are load-bearing, and what verification a PR needs.
