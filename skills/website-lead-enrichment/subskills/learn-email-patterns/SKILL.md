---
name: learn-email-patterns
description: Use when a company already has at least one real staff email on its own domain and the format of that address should be generalized to colleagues who have no published address yet.
license: MIT
metadata:
  author: Lexdash-org
---

# Learn Each Company's Email Format

## Purpose

This is the multiplier. One real address at a company reveals the format for everyone else
there: `chris.hemmings@` means `first.last`, `howellsr@` means `lastfi`. Turning that into
a stored per-domain pattern is what lifts predictions above a blanket `first.last` guess.

Do not scrape, do not search, do not generate addresses — stage 8 applies what is learned
here.

## Required inputs

- `out/.work/team-master.csv` (required) and `out/.work/ledgers/email-domain-cache.jsonl` (optional).
- An LLM in the reasoning role, for the ambiguous cases only. `--no-ai` skips it entirely
  and needs no credentials at all. See `../../shared/PROVIDERS.md`.

This stage does **not** require `LEADGEN_FIRECRAWL_API_KEY`. It never fetches anything, and asking
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

**Deterministic first.** For each non-role evidence address, test whether any staff
member's name under any canonical pattern reproduces its local part. Highest vote count
wins; ties break toward the higher-ranked pattern, so `first.last` wins a tie.

**Then the model**, for companies where nothing matched. It receives up to 25 staff names
and up to **12 addresses — every address on the company's own domain, role inboxes
included**. That breadth is deliberate: a house style is often only legible in the
addresses that look like role accounts.

It may answer with either:

- a **canonical pattern name** (`first.last`, `filast`, …), or
- a **template** over `{first} {last} {fi} {li}` plus literal text, when the company's
  real addresses show a style the canonical names cannot express:

| Template | Reproduces |
|---|---|
| `{last}.admin` | `kondogiannis.admin@`, `li.admin@`, `stoney.admin@` |
| `admin.dr{last}` | `admin.drmolnar@` |
| `{first}_{last}` | `anna_eastman@`, `allan_lim@` — underscore |
| `dr{last}` | `drlennox@`, `drsharma@` |

### The proof gate

An answer is accepted **only if it reproduces one of that company's own observed
addresses** — the code substitutes each staff name into the proposed pattern and requires
an exact match against a real address. `unknown`, an unparseable answer, or one that
reproduces nothing is rejected and the domain stays unlearned, with the rejection logged.

This matters more than the extra coverage. A learned pattern is applied to *every*
colleague at that company, so a confident-but-wrong format multiplies one bad guess across
a whole staff list. Rejecting is cheap; the fallback is the ordinary `default:first.last`.

The canonical patterns live in `../../shared/lib/patterns.json` and are read by this
stage, by `permute.ts`, and by the model prompt's allowed-list. Do not retype them
anywhere — that is how the three copies drifted before.

## Re-running

There is no ledger — every run re-derives patterns from the current master. Results are
**merged into** `out/.work/company-email-patterns.json` rather than replacing it, so a run can
only add or refresh a company's pattern, never remove one.

That makes `--no-ai` safe: it skips the model pass and keeps whatever the model worked out
on earlier runs. Re-run this stage freely after new emails arrive.

## Output and handoff

`out/.work/company-email-patterns.json`, keyed by the master's `domain`:

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
