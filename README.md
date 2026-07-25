# Website Lead Enrichment

Turn a list of company websites into the **people who work there and their email
addresses** — for the case where the contacts exist in no data vendor, only on the
companies' own sites.

Built and validated on 1,097 Australian private medical clinics, which produced 9,122
people.

This is an **Agent Skill**, not a CLI. You point Claude at a CSV of websites and it runs
the pipeline for you.

---

## What it does

Nine stages, in three groups:

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
| Python | 3.8+ (one script, standard library only) |
| Firecrawl | API key — site URL mapping (stage 1) |
| Zyte | API key — page fetching (stages 2–4) |
| An LLM | Any OpenAI-compatible endpoint (see [Configuration](#configuration)) |
| Codex CLI | **Optional.** Only for stage 5; skip it and everything else runs |

Stages 6 and 8 need no credentials at all — stage 6 is plain DNS, stage 8 is string
generation.

## Installation

Ask Claude: *"Install the website lead enrichment skill"* — the
`install-website-lead-enrichment` skill downloads it, places the folders, walks you
through credentials, and runs a health check.

By hand, from a clone:

```bash
git clone https://github.com/Lexdash-org/vertical-saas-agent
cd vertical-saas-agent
npm install
cp .env.example .env      # then fill it in
```

To use it globally rather than from the clone, copy the skill folder plus the files it
needs to run into your agent's skills directory:

```bash
cp -R .claude/skills/website-lead-enrichment ~/.claude/skills/
cp package.json tsconfig.json .env.example ~/.claude/skills/website-lead-enrichment/
cp -R fixtures ~/.claude/skills/website-lead-enrichment/
cd ~/.claude/skills/website-lead-enrichment && npm install
```

The `package.json` matters: the stages find their project root by walking up for one, and
throw at startup without it.

## Basic usage

Give Claude a CSV with a website column and ask in plain language:

> Enrich this list of clinic websites — I need staff names and email addresses.
> `fixtures/companies.example.csv`

Claude confirms the plan once (how many companies, which stages, what it will spend), then
runs stages 1–4 and 6–8 straight through. It pauses before stage 5 only, because that one
is optional and spends a weekly Codex quota.

You get four files in `out/`:

| File | Contents | Safe to send? |
|---|---|---|
| `team-master.csv` | every person, every column | mixed — read the basis |
| `verified-real.csv` | people with a real personal address | **yes** |
| `company-inboxes.csv` | one row per company with a published inbox | **yes** — reaches the business, not a person |
| `predicted-unverified.csv` | `learned:` / `default:` guesses | **no — verify first** |

> **Sending `predicted-unverified.csv` without running it through an email verification
> service will generate bounces and damage your sending domain.** For a list of small
> businesses, `company-inboxes.csv` is usually the largest of the sendable files.

<details>
<summary>Running a stage by hand (for working on this repo)</summary>

```bash
S=.claude/skills/website-lead-enrichment/subskills
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

Run them one at a time — two stages writing `out/team-master.csv` concurrently will
clobber each other. Every stage is resumable; re-running one picks up where it stopped.

</details>

## Configuration

Copy `.env.example` to `.env` (gitignored) and fill in:

| Variable | Required | Purpose |
|---|---|---|
| `FIRECRAWL_API_KEY` | yes | site URL mapping (stage 1) |
| `ZYTE_API_KEY` | yes | page fetching (stages 2–4) |
| `LLM_API_KEY` | yes¹ | any OpenAI-compatible provider |
| `LLM_BASE_URL` | no | omit for `api.openai.com`; else the provider's base URL |
| `LLM_MODEL_REASONING` | yes¹ | ranking and format judgment |
| `LLM_MODEL_EXTRACTION` | no | people out of page text; defaults to the reasoning model |
| `CODEX_MODEL` | no | stage 5 model, defaults to `gpt-5.6-sol` |
| `CODEX_BIN` | no | override only — Codex is auto-detected from `PATH` |
| `LEADGEN_ROOT` | no | project root, when installed outside a clone |
| `LEADGEN_OUT_DIR` | no | send output somewhere other than `out/` |

¹ Or use the Azure preset instead: `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_DEPLOYMENT_SOL`, `AZURE_OPENAI_DEPLOYMENT_LUNA`. `LLM_*` wins when both are
set. Examples for OpenRouter, Together, Groq and Ollama are in `.env.example`.

**Put your key in `LLM_API_KEY`, not `OPENAI_API_KEY`.** That variable must stay unset —
stage 5 clears it so Codex uses the ChatGPT subscription rather than billing your key.

Full contract: `.claude/skills/website-lead-enrichment/shared/PROVIDERS.md`.

## How to run tests

**There is no automated test suite yet.** Be aware of that before trusting a change.
What exists:

```bash
npm run typecheck                 # tsc --noEmit across the whole skill
npx tsc --noEmit --noUnusedLocals # also catches dead code
```

A free, keyless smoke test that exercises the install, dependencies and path resolution
(DNS only, no credits):

```bash
LEADGEN_OUT_DIR=/tmp/wle-smoke npx tsx \
  .claude/skills/website-lead-enrichment/subskills/resolve-email-domains/scripts/resolve-email-domains.ts \
  --input fixtures/companies.example.csv
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
- `examples/enriched-sample.csv` holds **50 verified addresses** — every one read directly
  off the company's own website, on that company's own domain, where the company published
  it themselves. No predicted or guessed address appears in it, and nothing sourced
  off-domain does either. `examples/make-samples.py` is committed so that filter is
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
- your Node and Python versions, and which LLM provider you configured
- whether Codex is installed

Please do not paste `.env` contents, real lead lists, or enrichment output into an issue.

**Security issues** — if you find a vulnerability or a leaked credential, report it
privately to the repository owners rather than opening a public issue.
