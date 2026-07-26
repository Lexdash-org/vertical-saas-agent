---
name: discover-web-emails
description: Use when named people still have no email after their employer's own site has been fully scraped, the address would have to come from a publication, staff directory, or professional register elsewhere on the open web, and the Codex CLI is available. Optional stage - skip it when Codex is absent.
license: MIT
metadata:
  author: Lexdash-org
---

# Discover Missing Emails on the Open Web

## This stage is optional

**Codex is not required to use this skill.** If the user doesn't have the Codex CLI, or
doesn't want to spend the weekly quota, skip this stage entirely and carry on to stage 6.
Do not ask them to install Codex, and do not substitute agent browsing or a search engine
for it — the guards below are what make a sourced address trustworthy, and an
approximation without them is worse than no address.

Skipping costs only the off-domain addresses described below. Everything the companies
publish on their own sites (stages 1–4) and every prediction (stages 6–8) is unaffected.
Say plainly in the run summary that the stage was skipped and why.

## Purpose

For people still missing a real address, run an agentic web search per person and keep
only addresses that are **sourced** (a real URL) and **identity-confirmed**. This reaches
what no scrape or prediction can: a clinician's `@hospital.org.au` or `@university.edu`
address published on a paper or a staff register, on a domain their employer does not own.

Do not scrape the employer's own site (earlier stages own that), infer patterns, or
predict addresses.

## Required inputs

- An authenticated **Codex CLI** ≥ v0.145 (`codex login`). `LEADGEN_CODEX_BIN` overrides the
  binary; it defaults to `codex` on `PATH`. See `./providers.md`.
- `out/.work/team-master.csv` from the earlier stages.
- `--source-csv <csv>` — the original company list, for specialty/suburb/state context.
  **Required**; there is no default. Column names default to `Website`, `Specialty`,
  `Suburb`, `State` and are overridable with `--col`, `--specialty-col`, `--suburb-col`,
  `--state-col`. A missing website column is fatal; missing context columns warn, because
  blank specialty and location weaken the identity guard badly.

`OPENAI_API_KEY` must be unset — the runner deletes it from the child environment so Codex
uses the ChatGPT subscription. With it set, the run bills an API key instead.

## Who gets searched

Three gates, in order: skip anyone who already has a scraped `email`; skip anyone already
in the ledger; skip any name that is a single token (not searchable). The rest are ordered
by a **findability score** — having a title, having a specialty, and a
doctor/professor/surgeon/director-shaped title all add weight — and `--limit` cuts from
the top of that queue. It is a priority cut, not a random sample: the long tail of junior
staff is genuinely low yield.

## The two guardrails

### Identity guard — the reason this stage is safe

An address counts only when the source's **specialty and location and employer** all match
this person. Same name in another city, country, or institution is a different person.

This is not hypothetical: without it, a Shiraz professor's address was pinned to a
Melbourne clinician. The model returns `identity_match: confirmed | uncertain | mismatch`,
and **only `confirmed` is accepted** — `uncertain` is discarded outright, not downgraded.
A hit also needs a real `source_url` and a syntactically valid address.

### Budget guard

The prompt caps the agent at **6 searches and 8 opened pages**. Without a cap it spirals
past 40 searches and dies on context-window exhaustion.

Know the limit of this: **the cap is prompt-side only.** Nothing in the runner counts
searches. The sole hard enforcement is a 240s per-person `SIGKILL`. Treat the budget as a
strong instruction, not a guarantee.

## Weekly quota throttle

Codex runs on a subscription with a **weekly** limit and no headless `usage` command. The
runner reads `account/rateLimits/read` over the app-server, paces down as the weekly
percentage climbs, and stops cleanly at `--stop-at-percent` (default 90), resuming from
the ledger after the window resets. It re-checks every 40 completions.

**How much one search costs is not knowable, so no document here states a rate.** The
per-search share of the weekly limit differs across the $20, $100 and $200 plans and is not
published by OpenAI. An earlier version of this file asserted "1% per 16 searches"; it was
wrong by more than an order of magnitude, and anyone sizing a batch from it would have run
out mid-run. A CI invariant now rejects any such claim in any document.

Measurements live in exactly one place — the observations table in
[TESTING.md](../../../TESTING.md). Record what a run actually consumed there, naming the
plan tier. Never promote a measurement into a rate, here or anywhere else: one tier's
number tells you nothing about another's.

Treat the live percentage as the only trustworthy number, and let the user choose the batch
size against it. `--limit N` carries that choice through, ranked so titled staff go first,
and **the stage refuses to run without it** — so an unbounded run is impossible rather than
merely discouraged.

If the usage probe fails — spawn error, 20s timeout, unexpected shape — the run **stops and
reports**. It used to return null and let the batch continue with the throttle silently
disabled, which is the worst outcome when the true cost per search is unknown: an uncapped
run against an unknown rate. Failing closed can only cost a rerun.

## Mechanics that bite

- `codex exec` needs **stdin closed**, or it blocks reading stdin and ignores the prompt.
- Codex may return several comma-separated addresses, or prose, or `[redacted]`. Split and
  validate to a real address before trusting anything.
- Rate-limit detection reads Codex's own error channel only, so a source page containing
  "quota" or "429" no longer aborts the batch. Keep it that way — matching on model output
  or page text reintroduces spurious halts mid-run.
- The prompt in `references/web-email-search-prompt.md` is **documentation**; the runner
  builds its own condensed version in code. Editing the reference file alone changes
  nothing.
- Location is assembled as `<suburb>, <state>, Australia` — the country is hardcoded. This
  stage is not market-agnostic; adapt it before pointing it at another market.

## Output and handoff

Ledger `web-search-ledger.jsonl`: `{rowId, domain, name, email, source_url,
identity_match, confidence, notes}`. `rowId` is the master's **positional row index** —
see `./pipeline-state.md` for why reordering the master invalidates it.

Merged into the master as `web_found_email`, `web_found_source`, `web_found_confidence`,
and into `best_email` with basis `web-found:<confidence>` for anyone without a scraped
address.

`not_found` and `mismatch` are recorded as **done and never retried**. Only hard errors
come back around.

Roughly half of all hits are the clinic inbox earlier stages already had; the prize is the
30–40% that are personal or off-domain.

After a batch, **re-run stages 6–8**. New real addresses sharpen the learned pattern for
everyone else at that company, and re-running prediction is cheap. Stage 8 preserves
`web-found` results rather than overwriting them, so the order is safe.
