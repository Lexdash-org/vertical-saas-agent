---
name: website-lead-enrichment
description: >-
  Use when a list of company websites or domains must become the named people who work
  there and their email addresses - "scrape team members from these sites", "find staff
  emails for these clinics", "enrich this account list", "find the emails we're missing",
  "predict emails for the people we found". NOT for: checking whether an address actually
  delivers, scraping one already-known page, or lists that already contain the people.
license: MIT
metadata:
  author: Lexdash-org
  version: "1.0.0"
---

# Website → Team + Emails

The user is usually an SDR with a list of company websites and no contacts. Their people
aren't in any data vendor, but most companies name their staff on their own site. So
**extract what's published, then predict what isn't** — and never present one as the other.

You run this pipeline for them. They do not run commands; you invoke the tools and report
what came back.

This file routes. Each stage's process, limits and failure modes live in its own subskill —
read the subskill before running that stage.

## Before you start

1. Read `references/providers.md` — which credentials each stage needs, and the rule that a
   missing credential is reported rather than worked around with curl, your own browsing,
   Playwright, or a search engine.
2. Read `references/pipeline-state.md` — the master CSV schema, the basis vocabulary, ledgers
   and resume, and the rule that **no two master-writing stages run at once**.
3. Check the keys and report every missing one together, not one stage at a time.
4. Confirm you have the input CSV path and which column holds the website.

### Setup is a prerequisite, not an option

**Before anything else, check that this skill can actually run:**

```bash
[ -d node_modules ] || [ -d "$HOME/.claude/skills/website-lead-enrichment/node_modules" ] \
  || [ -d "$HOME/.agents/skills/website-lead-enrichment/node_modules" ] \
  && echo "deps: ok" || echo "deps: MISSING"
[ -f "$HOME/.leadgen/.env" ] && echo "config: ok" || echo "config: MISSING"
```

If either is MISSING, **stop and hand over to the `find-team-emails` skill.** It owns
installation and credentials; follow it, and come back here once it reports success.

Do not attempt a workaround. Do not run a stage to "see what happens" — every credentialed
stage will throw, and a raw `LEADGEN_ZYTE_API_KEY is not set` is correct for a developer
and a dead end for a salesperson who did not choose the variable name.

Say it as a next step, never as an error:

> You are not set up yet — I will get that sorted first. It takes a couple of minutes,
> then I will run this list.

## Confirm once, then run

Do not ask the user to approve each stage — they want a contact list, not eight prompts.
State the plan in one message and get one confirmation:

- how many companies, from which file
- which stages will run, and which are skipped and why
- which providers will be charged

Do not invent a completion time — no measured per-company rate exists. Say instead that
you will report progress as stages finish, and if pressed, run the first few companies and
extrapolate from what they actually took.

Then run stages 1–4 without stopping. Stop only for a genuine failure.

**Stage 5 sits between scraping and prediction, and it is the one place you stop.** Codex
should only ever search for people whose own website gave up no email, so it runs after
stage 4 has finished collecting and before stage 6 starts predicting. Once the user has
answered, run 6–8 without stopping.

## Stage 5 — ask twice, and let the user pick the number

**Never start stage 5 unprompted, and never choose the batch size yourself.** This is the
only stage that spends a quota the user cannot top up with money, and a large list will
exhaust it in one run.

First read the live usage — `npm run usage`, or
`scripts/discover-web-emails/codex-usage-check.ts`. Then ask **two** questions, in order:

```
Codex weekly usage: 34%  (throttle stops at 90%)
273 people have no email published on their own site.

1. Do you want to use Codex to search for them? It is optional.

2. If yes: how many should I search? Any number from 1 to 273.
   They are ranked by findability, so titled staff come first.

What one search costs depends on your ChatGPT plan ($20 / $100 / $200)
and OpenAI does not publish it. Start small and re-check usage before
going bigger.
```

Pass their number straight through as `--limit N`. The stage **refuses to run without it**,
so the quota cannot be spent by forgetting to ask — but reaching that error means you
already skipped the conversation. If they give no number, ask again or stop.

State the tier caveat every time. A user who assumes another tier's rate runs out mid-batch,
and no number here would help them — see `references/05-discover-web-emails.md`.

## Codex is optional

**Codex is not required.** If the Codex CLI isn't present, or the user declines at question
one, skip stage 5 and continue at stage 6. Do not ask them to install it, and do not
substitute your own web search for it — see `references/providers.md` for why.

Skipping costs only the off-domain addresses (a clinician's `@hospital.org.au` from a
paper or staff register). Everything the companies publish themselves, and every
prediction, is unaffected. Say in the summary that the stage was skipped.

## Stages

Run in this order. It is the order that preserves sourced addresses.

Paths are relative to this skill's directory. Invoke each with `npx tsx` from the project
root, passing the user's CSV — there is no default input list.

| # | Stage | Subskill — read before running | Tool |
|---|---|---|---|
| 1 | Discover and rank team pages | `references/01-discover-team-pages.md` | `scripts/rank-batch.ts --input <csv>` |
| 2 | Scrape and extract people | `references/02-extract-team-members.md` | `scripts/run-batch.ts --input <csv>` |
| 3 | Harvest business emails | `references/03-harvest-business-emails.md` | `scripts/harvest-business-emails.ts --input <csv>` |
| 4 | Recover related / cross-domain | `references/04-recover-related-emails.md` | `scripts/harvest-related.ts --input <csv>` |
| 5 | Discover on the open web *(optional)* | `references/05-discover-web-emails.md` | `scripts/enrich-web-search.ts --source-csv <csv>` |
| 6 | Resolve receiving mail domains | `references/06-resolve-email-domains.md` | `scripts/resolve-email-domains.ts --input <csv>` |
| 7 | Learn each company's format | `references/07-learn-email-patterns.md` | `scripts/learn-email-patterns.ts` |
| 8 | Permute and pick best_email | `references/08-email-permutation.md` | `scripts/apply-permutation.ts` |

Each tool lives under its own subskill, e.g.
`scripts/harvest-business-emails/harvest-business-emails.ts`.

Stages 1–5 collect **real** addresses. Stages 6–8 **predict** the remainder; they need no
API keys and are cheap, so re-run them freely.

Every stage is resumable — re-running one picks up where it stopped rather than starting
over. A single company failing never fails the batch.

### Boundaries

- **1 → 2** — stage 1 produces a closed scrape plan. Stage 2 visits that plan and nothing
  else; it does not rediscover URLs or guess `/team`.
- **2 → 3** — stage 2 keeps only emails attributable to a named person. Shared inboxes
  (`info@`, `reception@`) belong to stage 3.
- **3 → 4** — stage 3 runs for every company, including those with no people. Stage 4 only
  sees companies stage 3 left empty **without erroring**, so re-run stage 3 failures first
  or those companies are skipped permanently.
- **4** — a variant-domain address may be promoted to `business_email`; an affiliated one
  (group practice, hospital, business-name freemail) goes to `related_email` and is never
  promoted. Stage 8 trusts the `business_email` domain absolutely.
- **5** — only identity-confirmed, source-URL-backed addresses are accepted. `uncertain`
  is discarded, not downgraded.
- **6** — MX proves a *domain* receives mail. It never proves a mailbox exists, and it does
  not discover alternate mail domains.
- **7** — learn only from real personal addresses on the company's own domain, never from
  a role inbox.
- **8** — runs only for people with no real address, and preserves stage 5's results
  rather than overwriting them.

### If stage 5 ran

Re-run 6 → 7 → 8 afterwards. New sourced addresses become evidence for pattern learning,
which sharpens predictions for everyone else at that company. Prediction is cheap, so
close the loop: discover → re-learn → re-predict.

## Recovery

- A stage died partway → re-run it. Ledgers resume; the master is rewritten atomically.
- Nothing found → check the stage's credential before concluding the sites are empty. A
  missing key looks exactly like an empty site.
- Stage 4 skipping companies you expected → look for `error` records in
  `.work/ledgers/business-email-ledger.jsonl` and re-run stage 3 for those.
- Two stages accidentally run at once → the master may be clobbered. Re-run them in order.
- A company was skipped at stage 2 as unreachable → that is deliberate, not a failure.
  Stage 1 confirmed the host answers nothing. Report it as skipped; it can still yield a
  business inbox at stage 3.

## What you hand back

Three files. `out/` deliberately contains nothing else except the `README.txt` stage 8
writes, so you can name these as "the output" without qualification. Everything the
pipeline needs to resume — including the master — lives in `out/.work/`, which the user
never opens:

- `out/ready-to-send.csv` — people with a real address (`known`, `web-found`).
  **Safe to send.**
- `out/company-inboxes.csv` — one row per company with a published inbox (`info@`,
  `reception@`) or a related-domain contact. Real addresses, **safe to send**, but they
  reach the business rather than a named person.
- `out/verify-before-sending.csv` — basis `learned:` or `default:`. **Must go through an
  email verifier before sending.**

Both person files use the same columns, and `email` is the address to send to.

**Report from `out/.work/run-summary.json`.** Stage 8 writes it with every count you need
— per tier, per basis, how many carry a checkable `proof` link, and how many people ended
with no address at all. Read that file rather than counting rows or re-reading the console.

For a list of small businesses, `company-inboxes.csv` is usually far larger than
`ready-to-send.csv` — most clinics publish a front-desk address and no personal ones.
Never report only the personal-email count: that understates what was actually found, and
those inboxes are the bulk of the usable contacts. "Any email is a lead."

Report the counts per tier, not one total. Then say this plainly, every time:

> The predicted file is guesses, not verified addresses. Sending it without running it
> through a verification service first will generate bounces and damage your sending
> domain.

**Never present a prediction as a fact.** Scraped and sourced addresses are real; anything
with a `learned:` or `default:` basis is a guess until an SMTP/catch-all pass confirms it.
Deliverability is `not_checked` for every row this pipeline produces. The full basis
vocabulary is in `references/pipeline-state.md`.

Expect from a real run: roughly 16% of any scraped list is dead domains no tool can help,
and many live businesses publish only a generic inbox or a web form. Capture the inbox
rather than discarding it — any email is a lead.
