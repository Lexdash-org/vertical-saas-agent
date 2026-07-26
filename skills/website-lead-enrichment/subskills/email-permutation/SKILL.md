---
name: email-permutation
description: >-
  Use when first name, last name and a company domain must become ranked candidate work
  email addresses - "predict emails for these leads", "guess this person's work email",
  "I have names and domains but no emails", "permute emails for a lead list". NOT for:
  discovering which alternate domain a company sends from, verifying or bounce-checking
  addresses, cleaning a lead list, or uploading results to a sending platform.
license: MIT
metadata:
  author: Lexdash-org
---

# Email Permutation

## Overview

Turn `first name + last name + domain` into a ranked list of ~18 plausible business email
addresses. Pure string generation — no network calls, no MX lookups, no SMTP probes, no
paid APIs. Verification, if wanted, is a separate downstream step.

The wrinkle this skill exists for: many companies operate **two** domains — the
company/website domain, and a separate look-alike domain used for outbound mail so that
bounces and complaints never touch the primary domain's reputation.

| Company domain | Email domain |
|---|---|
| `example-ai.xyz` | `example-ai.info` |
| `getexample.com` | `tryexample.com` |
| `example.com`    | `example.com.au` |

## Two ways in

**Inside the pipeline** (the normal case), `scripts/apply-permutation.ts` is the entry
point. It decides who needs a guess, fills the two domain columns below, calls
`permute.ts` in-process, then merges the result into the master. See *In the pipeline* at
the end of this file for the priority rules and the basis strings it writes.

**Standalone**, `permute.ts` takes a CSV of names and domains and emits ranked candidates.
Everything between here and that section describes generation, which is identical either
way.

## Alignment Gate (run before executing)

Emit one line, then proceed unless corrected:

```
ALIGNMENT: generating ~18 ranked candidates for <N leads | one person>,
domain = <the winning domain> (<email_domain | company_domain>), no verification
— proceeding unless corrected
```

Only stop to ask if the input genuinely lacks any domain, or if it is unclear which
column holds the alternate mail domain versus the website domain.

## The Two Hard Rules

### 1. Domain selection is a strict fallback, never a cross-product

```
domain = email_domain or company_domain
```

If an email/sending domain is supplied, it **wins outright** — every pattern goes against
it and the company domain is not permuted at all. Only when no email domain is supplied
does the company domain get used. Never split the candidate budget across both.

The reasoning: a supplied email domain is a known fact about where that company's mail
actually lives. Spending half the guesses on the website domain would be spending them on
a domain already known not to be the mail domain.

If neither domain is present, skip the person.

### 2. Dot is the only separator — when guessing blind

Generated local-parts use **`.` or nothing**. No underscores, no hyphens, ever.
`john_smith@` and `john-smith@` are not produced by the 18 patterns.

**The exception, and its reason.** When a company's *own published addresses* show a
different house style, stage 7 may learn it as a template — including separators this
rule forbids (`anna_eastman@snp.com.au` is real; the generator would never invent it).
A template is only ever accepted after it reproduces an address that company actually
publishes. That is not a guess, so the dot-only rule does not apply to it.

Blind guessing stays dot-only. Observed evidence overrides.

Note the asymmetry, which is the easiest thing to get wrong here:

- **Input** names are normalized aggressively — hyphens and apostrophes are *collapsed*
  (`Mary-Jane` → `maryjane`).
- **Output** local-parts are then joined with `.` or nothing.

Normalization is about deciding what `first` and `last` *are*. It never leaks a separator
into the generated address.

## Name Normalization (input side)

Applied to each name field before any pattern runs:

| Step | Example |
|---|---|
| Lowercase | `SMITH` → `smith` |
| Strip accents (NFKD, drop combining marks) | `José` → `jose`, `Müller` → `muller` |
| Drop honorifics (`dr mr mrs ms miss mx prof professor sir madam rev hon`) | `Dr. Anna` → `anna` |
| Drop every non `a-z` char **in place** (collapse, don't split) | `O'Brien` → `obrien` |
| Multi-token **given** name → take the **first** token | `Anna Maria` → `anna` |
| Multi-token **surname** → take the **last** token | `van der Berg` → `berg` |

If either field is empty after normalization, skip the person.

## The Pattern Table (18, ranked)

Ordered by real-world B2B frequency. Deliberately market-agnostic — do not reorder for a
specific country or industry unless the user supplies evidence for that market.

The table is **not** written out in code. It lives in `../../shared/lib/patterns.json` as
an ordered list of names, and both `permute.ts` and `shared/lib/patterns.ts` derive their
builders from it — each name is its own formula over `first`, `last`, `fi`, `li` joined by
`.` or nothing. Edit the JSON, never a copy. (Three hand-maintained copies is what this
replaced.)

`f` = first, `l` = last, `fi`/`li` = first/last initial.

| # | Pattern | John Smith @ example.com |
|---|---|---|
| 1 | `first.last` | john.smith@example.com |
| 2 | `firstlast` | johnsmith@example.com |
| 3 | `first` | john@example.com |
| 4 | `filast` | jsmith@example.com |
| 5 | `fi.last` | j.smith@example.com |
| 6 | `first.li` | john.s@example.com |
| 7 | `firstli` | johns@example.com |
| 8 | `last.first` | smith.john@example.com |
| 9 | `lastfirst` | smithjohn@example.com |
| 10 | `last` | smith@example.com |
| 11 | `last.fi` | smith.j@example.com |
| 12 | `lastfi` | smithj@example.com |
| 13 | `fi.li` | j.s@example.com |
| 14 | `fili` | js@example.com |
| 15 | `li.fi` | s.j@example.com |
| 16 | `lifi` | sj@example.com |
| 17 | `lifirst` | sjohn@example.com |
| 18 | `li.first` | s.john@example.com |

**Dedupe after generating, preserving first-seen order.** When the initials match
(`John Jones`), patterns 13/15 and 14/16 collapse and the person yields ~16 instead of 18.
That is correct — do not pad the list back to 18 with invented patterns.

## Usage

### Batch — a CSV of leads

```bash
npx tsx scripts/permute.ts \
  --in leads.csv \
  --out-wide candidates_wide.csv \
  --out-long candidates_long.csv
```

Column names are configurable, since lead-export tools disagree on headers:

```bash
npx tsx scripts/permute.ts --in leads.csv \
  --out-wide wide.csv --out-long long.csv \
  --first-col "First Name" --last-col "Last Name" \
  --company-domain-col "Company Domain" --email-domain-col "Sending Domain" \
  --max 18
```

Two files, both written every run:

- **long** — `first_name, last_name, domain, domain_source, rank, pattern, email`; one row
  per candidate. This is the source of truth. `domain_source` records whether the winning
  domain came from `email_domain` or `company_domain`, so any guess is traceable.
- **wide** — the original lead row plus fixed `email_1 … email_18` columns, for importing
  as custom fields. It is a *pivot* of the long table, not a second generation pass.

A summary goes to stderr: rows in, rows skipped (with reason), candidates out.

### Inline — a single person

No script needed. Apply the normalization rules, pick the winning domain per the fallback
rule, then walk the pattern table in order and dedupe. Present as a numbered ranked list
and state which domain was used and why.

## Rationalizations

| Thought | Reality |
|---|---|
| "Both domains were given, so permute both" | No. The email domain wins outright. Splitting the budget wastes guesses on a domain already known not to carry mail. |
| "`first_last@` is a common pattern, include it" | Dot-only is a hard rule. Underscore and hyphen variants are excluded by design. |
| "Only 16 candidates came out, pad it to 18" | Dedupe shrinking the list on matching initials is correct behavior. Never invent patterns to hit a number. |
| "Let me MX-check which ones resolve" | Out of scope. This skill never touches the network. |
| "The company domain looks wrong, let me find the real one" | Domain discovery is out of scope. Consume what is supplied; flag doubt to the user instead of guessing. |
| "I'll reorder the table for this country" | The ordering is market-agnostic on purpose. Reorder only against supplied evidence, never a hunch. |

## Verification

- [ ] Every non-skipped person yields 15–18 candidates
- [ ] No generated local-part contains `_` or `-`
- [ ] Rows with an email domain produce **zero** candidates on the company domain
- [ ] Rows with neither domain are skipped and counted in the stderr summary
- [ ] Accents, honorifics, apostrophes and hyphens are all resolved before generation
- [ ] `email_1` in the wide file equals the rank-1 row for that person in the long file
- [ ] Ranks are contiguous from 1 within each person, even after dedupe

## In the pipeline

`scripts/apply-permutation.ts` is the caller. It reads the master, decides who needs a
prediction, and writes `email_domain`, `mx_provider`, `best_email`, `best_email_basis`,
and `email_candidates`.

### How the two domain columns get filled

The strict-fallback rule above is the *whole* rule; the pipeline simply supplies its two
inputs from evidence:

- `email_domain` ← the **confirmed** mail domain: the domain of the company's published
  `business_email` if there is one, otherwise the MX-verified domain from stage 6.
- `company_domain` ← the website domain, used only when neither of those exists.

So the pipeline's stated priority — business-email domain > MX domain > website domain —
and this file's `domain = email_domain or company_domain` are the same rule stated at two
levels. There is no second policy.

When the website domain is the one used, the basis is suffixed `(unverified-domain)`,
because nothing has shown that domain receives mail.

### Who is skipped

Not everyone gets a guess. Skipped: anyone with a real scraped `email`; anyone with a
sourced `web_found_email`; anyone whose name is a single token; anyone with no domain at
all.

The single-token gate matters. `permute.ts` is called with both name columns pointed at
the one `name` field, so a lone token would satisfy its "first and last present" check and
generate `cher.cher@domain` — a fabricated address that would then be labelled
`default:first.last`. Those people get an empty `best_email` and basis `no-name` instead.

### Files written

`out/.work/team-master.csv` (updated in place), plus two derived files that split the result by
trustworthiness: `out/ready-to-send.csv` (basis `known` or `web-found:*`) and
`out/verify-before-sending.csv` (basis `learned:*` or `default:*`). People with no address
appear in neither. Always report the split and warn that the predicted file must go
through an email verifier before it is sent.

### Result priority

`known` (scraped) > `web-found` (sourced) > `learned:<pattern>` > `default:first.last`.
Real addresses always win; a learned company pattern is hoisted to rank 1 of
`email_candidates` when it applies. Full basis vocabulary in
`../../shared/PIPELINE-STATE.md`.

This stage reads `web_found_email` rather than overwriting it, so running it after open-web
discovery preserves sourced addresses.

## Interaction with Other Skills

- **Verification services** — downstream and out of scope here. This skill hands off a
  ranked candidate list; narrowing it to one real address is someone else's job.
- **Lead-list cleaning / CSV consolidation** — upstream. Clean, dedupe and normalize the
  list first, then permute.
- **Sending-platform APIs / MCP tools** — downstream. Uploading the resulting CSV is a
  separate step, not part of this skill.
