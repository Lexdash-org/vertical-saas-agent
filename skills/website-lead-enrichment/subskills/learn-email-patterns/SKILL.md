---
name: learn-email-patterns
description: Use when a company already has at least one real staff email on its own domain and the format of that address should be generalized to colleagues who have no published address yet.
---

# Learn Each Company's Email Format

## Purpose

This is the multiplier. One real address at a company reveals the format for everyone else
there: `chris.hemmings@` means `first.last`, `howellsr@` means `lastfi`. Turning that into
a stored per-domain pattern is what lifts predictions above a blanket `first.last` guess.

Do not scrape, do not search, do not generate addresses — stage 8 applies what is learned
here.

## Required inputs

- `out/team-master.csv` (required) and `out/email-domain-cache.jsonl` (optional).
- An LLM in the reasoning role, for the ambiguous cases only. `--no-ai` skips it entirely
  and needs no credentials at all. See `../../shared/PROVIDERS.md`.

This stage does **not** require `FIRECRAWL_API_KEY`. It never fetches anything, and asking
for a scraping key here was a bug.

## Evidence

Per domain, gather every address in `email`, `business_email`, `all_business_emails`,
`related_email`, and `web_found_email`, then keep only those that are:

- on the company's own or mail domain (first-label match, so cross-TLD counts), **and**
- not role-shaped.

Sourced web-found addresses are included on purpose — an off-domain one is dropped by the
same-domain filter, and a same-domain one is exactly the new evidence that makes re-running
this stage after web discovery worthwhile.

**Never learn a personal pattern from a role inbox.** `info@`, `reception@`, `admin@` and
friends are company addresses; they encode nothing about how staff names map to mailboxes.

Two sharp edges in the filter:

- The role test is **prefix-based and not anchored at the `@`**, so real given names that
  begin with a role word are silently discarded as evidence — `hrishi@` (matches `hr`),
  `teamer@`, `doctorow@`. Under-collection, never wrong promotion.
- Domain matching compares the **first label only**, so `clinic.com.au` evidence matches a
  site at `clinic.io`. Loose on purpose for cross-TLD mail domains.

A domain with no surviving evidence is skipped entirely and never reaches the model.

## Matching

Deterministic first: for each evidence address, test whether any staff member's name
under any of the canonical patterns reproduces its local part. Highest vote count wins;
ties break toward the higher-ranked pattern, so `first.last` wins a tie.

Only when nothing matches deterministically does the reasoning model judge the format —
nicknames, initials, compound surnames. Up to 25 names and 5 example addresses go to it.
Its answer is accepted **only** if it names one of the canonical patterns; `unknown`,
malformed JSON, or an API error leaves the domain unlearned.

The canonical patterns live in `../../shared/lib/patterns.json` and are read by this
stage, by `permute.py`, and by the model prompt's allowed-list. Do not retype them
anywhere — that is how the three copies drifted before.

## Re-running

There is no ledger — every run re-derives patterns from the current master. Results are
**merged into** `out/company-email-patterns.json` rather than replacing it, so a run can
only add or refresh a company's pattern, never remove one.

That makes `--no-ai` safe: it skips the model pass and keeps whatever the model worked out
on earlier runs. Re-run this stage freely after new emails arrive.

## Output and handoff

`out/company-email-patterns.json`, keyed by the master's `domain`:

```json
{ "clinic.com.au": {
    "pattern": "first.last",
    "confidence": "deterministic",
    "source": "jane.smith@clinic.com.au",
    "evidence": ["jane.smith@clinic.com.au"] } }
```

`confidence` is exactly `deterministic` or `ai`; stage 8 turns the latter into an `(ai)`
suffix on `best_email_basis` so a model-judged format is never presented as a matched one.

Hand off to email-permutation, which applies the pattern at rank 1 for people without a
real address.
