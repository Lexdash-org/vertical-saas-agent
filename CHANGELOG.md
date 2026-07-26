# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this ships as an agent skill, a change to what `SKILL.md` instructs the agent to
do is a behaviour change and is versioned like one, even when no code changed.

## [Unreleased]

## [1.0.0] - 2026-07-27

Initial public release. Everything below is new — there is no prior version to have
changed from.

### The skills

- **`find-team-emails`** — the only published skill, and the front door. Checks what is
  already in place and does only what is missing: installs Node if the user agrees,
  fetches and verifies the release (or uses a copy already on disk), installs
  dependencies, walks through credentials, proves the install with two credential-free
  stages, then runs the enrichment that was asked for. On an already-working install it
  skips setup entirely and goes straight to the work.
- **`website-lead-enrichment`** — the eight-stage pipeline it installs. Ranks team pages
  (Firecrawl + LLM), extracts people (Zyte + LLM, including Cloudflare-obfuscated
  addresses), harvests company inboxes, recovers cross-domain addresses, optionally
  searches the open web via Codex, confirms mail domains over DNS, learns each company's
  address format, and permutes candidates for everyone still without one.

### What a run produces

- Three files in `out/`, in the directory the user ran from, named for what to do with
  them: **`ready-to-send.csv`**, **`company-inboxes.csv`**, **`verify-before-sending.csv`**,
  plus a `README.txt` explaining them. Pipeline state lives in `out/.work/`.
- Both person files share 13 columns, so one saved column mapping works for either.
  `email` holds the recommended address, `first_name`/`last_name` are split for
  personalisation preserving case and particles ("van der Berg", not "berg").
- **`status`, `source` and `proof`** say in plain English how much to trust each address
  and show the evidence — the page it was published on, or the real address a format was
  copied from. A prediction has no proof and says so.
- `out/.work/run-summary.json` — structured counts, so a caller reports from data rather
  than parsing console output.

### The honesty contract

- Every address carries a `best_email_basis`: `known` and `web-found:*` are real,
  `learned:*` and `default:*` are unverified predictions. The file split exists so a guess
  cannot reach a sequencer by accident. A CI invariant asserts only real addresses can
  route to `ready-to-send.csv`.
- **Per-company format learning** — one real address at a company reveals the format for
  its colleagues. Deterministic matching first; an LLM judges the remainder, and its
  answer is accepted only if it reproduces an address that company actually publishes.
  Answers may be a canonical pattern or a free-form template over
  `{first} {last} {fi} {li}`, capturing house styles the 18 canonical patterns cannot.

### Configuration

- **One config file: `~/.leadgen/.env`** — for every agent and every project, so keys are
  set once and survive a reinstall.
- **Every variable is prefixed `LEADGEN_`**, so nothing this project reads can collide
  with another CLI. The risk is concrete: a key under a shared name like `OPENAI_API_KEY`
  or `ANTHROPIC_API_KEY` silently switches Claude Code and Codex from the user's
  subscription to API billing. This project reads neither, and strips `OPENAI_API_KEY`
  from every Codex child process.
- Any OpenAI-compatible endpoint — OpenAI, OpenRouter, Together, Groq, Ollama, vLLM, and
  Azure via its `/openai/v1/` path. One provider code path, no per-vendor presets.
- `scripts/lib/env.ts` declares every variable name once; a mistyped name is a TypeScript
  error rather than a runtime "key not set". CI rejects a hard-coded name anywhere else
  and requires `.env.example` to match the declared set exactly.

### Engineering

- Resumable stages: each appends to a ledger and skips completed work, so an interrupted
  batch continues rather than restarting.
- A site whose website is unreachable is detected once and skipped, rather than consuming
  a full extraction budget to discover the same thing expensively.
- **Node is the only runtime.** No Python interpreter is required.
- MIT licence, README, TESTING.md, CONTRIBUTING.md, SECURITY.md, trigger evals, and a CI
  workflow that validates every `SKILL.md` against the Agent Skills specification.
- `npm run check` — spec compliance for every `SKILL.md` plus ten project invariants,
  including that the shipped example contains no predicted addresses.
- `examples/output/enriched-sample.csv` — 50 real addresses, every one published by the
  company itself on its own domain, with the filter that produced them committed alongside
  so what ships is auditable rather than asserted.

### Known limitations

- No unit test suite. `npm run check`, `npm run typecheck` and the manual scenarios in
  TESTING.md are what exist.
- Stage 5 hardcodes `Australia` into its search location string.
- Stage 4 treats two domains as the same business when their first labels share a
  six-character prefix — deliberately loose, and it can occasionally merge two
  similarly-named businesses.
- Nothing verifies deliverability. A confirmed mail domain does not mean the mailbox
  exists; run `verify-before-sending.csv` through a verification service before sending.

[Unreleased]: https://github.com/Lexdash-org/vertical-saas-agent/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Lexdash-org/vertical-saas-agent/releases/tag/v1.0.0
