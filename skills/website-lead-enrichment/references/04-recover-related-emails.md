---
name: recover-related-emails
description: Use when companies still have no published inbox after same-domain harvesting, and addresses on a variant domain, a parent group, or a business-name freemail account are the remaining source of a real contact.
license: MIT
metadata:
  author: Lexdash-org
---

# Recover Related and Cross-Domain Emails

## Purpose

Second pass over companies that stage 3 left without a same-domain inbox. Re-scrape the
company's own pages with the same-domain filter relaxed, then **tier** what comes back:
the company's own address on a variant domain, versus a genuinely affiliated address that
belongs to someone else.

Do not extract people, search the open web, look up MX records, learn patterns, or
generate candidate addresses.

## Required inputs

- `LEADGEN_ZYTE_API_KEY`. See `./providers.md` for the credential and no-fallback rules.
- `--input <csv>` — the company list. **Required**; there is no default.
- `out/.work/team-master.csv` and `out/.work/ledgers/business-email-ledger.jsonl` must already exist. This
  stage cannot run before stage 3.

No LLM. Pure fetch and regex.

## Which companies it targets

Narrower than "everything still empty". A domain is a target only when **all** hold:

1. it appears in `business-email-ledger.jsonl`, and
2. that ledger record has no `error`, and
3. the master shows no `email` and no `business_email` for it.

Consequence worth knowing: **a domain that errored during stage 3 is excluded here
permanently.** Re-run stage 3 for those domains first if you want them covered.

## Workflow

1. Fetch the homepage through Zyte, then at most two contact-like pages — three pages per
   domain, hard cap. Candidates come from homepage links mentioning contact/reach/
   get-in-touch/enquiries, plus `/contact`, `/contact-us`, `/contactus` as fallbacks.
2. Collect addresses from plaintext, `mailto:`, `data-cfemail`, and Cloudflare
   `/cdn-cgi/l/email-protection#…` links. Cloudflare decoding is deterministic XOR and
   needs no rendering.
3. Drop malformed addresses, vendor/SaaS senders (booking platforms, site builders,
   analytics), theme placeholders, and hash-like local parts.
4. Tier each surviving address:
   - **OWN** → the company's own contact on a variant domain. Promote to `business_email`.
   - **RELATED** → a group practice, hospital, parent company, or business-name freemail
     address. Put it in `related_email`. **Never promote it to `business_email`.**
5. Within each tier, sort role inboxes (`info@`, `reception@`, `admin@`, …) ahead of
   personal addresses, so the promoted address is the company's front door.

### The OWN test is fuzzy, and that matters

An address counts as OWN when its domain equals the site domain, is a subdomain of it, or
shares a **≥6-character first-label prefix** with it. That is looser than "same name,
different TLD": it ignores the TLD entirely and matches on prefix, so
`melbourneclinic.com.au` and `melbourne.com.au` read as the same brand.

This is deliberate — it is what recovers `.com`↔`.com.au` mail domains — but it can merge
two genuinely different businesses whose names share a long prefix. A wrong promotion
here is expensive downstream: stage 8 trusts the `business_email` domain absolutely and
will predict **every person at that company** on the affiliate's domain, labelled as
confirmed. Spot-check promotions on a sample before trusting a large batch.

### No freemail filter

Unlike stage 3, this stage does not discard freemail. A `clinicname@gmail.com` is a real
lead for a small practice, so it lands in `related_email` rather than being dropped. It is
tiered as RELATED, never promoted.

## Constants

Concurrency 8 (`--concurrency`). Three pages per domain. Static fetch, 20s timeout, two
retries on transient failures. `--sample N` takes a **stride** across the pending list,
not the first N.

Rendering is not the answer here: measured 0% lift on a real dataset, because sites do not
JS-inject emails. The shared fetcher will still escalate to a render if a page returns
under 600 characters of text — that is a thin-shell guard, not an email hunt.

## Output and handoff

Appends `related-email-ledger.jsonl`: `{domain, company, website, ownEmails[],
relatedEmails[], pages, error?}`.

The run merges into the master automatically when it finishes, like stages 3 and 5.
`--merge` re-merges from the ledger without re-scraping. The merge fills `business_email`
from `ownEmails[0]` and `related_email` from `relatedEmails`, both **only when the field is
currently empty** — it never overwrites an existing value.

Errored domains retry on the next run; successful ones resume-skip.

Hand off to open-web discovery for people still missing a personal address. An empty
result is valid; never invent `info@domain`.
