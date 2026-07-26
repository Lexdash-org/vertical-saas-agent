---
name: harvest-business-emails
description: Use when company websites must be checked for published same-domain business or role inboxes after people extraction and before affiliated-domain recovery, open-web discovery, or email prediction.
license: MIT
metadata:
  author: Lexdash-org
---

# Harvest Business Emails

## Purpose

Find company-level contact addresses published on each company's own website. Run this
for every input domain, including companies where earlier stages found no team page or
people.

This stage does not extract people, search engines or affiliated domains, infer email
patterns, look up MX records, or generate staff addresses.

## Required inputs

- Company, website, and normalized domain from the original input list, via
  `--input <csv>`. **Required**; there is no default.
- `LEADGEN_ZYTE_API_KEY` for every page fetch. No LLM.

Credentials and the no-fallback rule are defined once in `../../shared/PROVIDERS.md`.

## Workflow

1. Fetch the website origin through Zyte. Collect addresses from `mailto:` links,
   plaintext, `data-cfemail`, and `/cdn-cgi/l/email-protection#...`. Cloudflare decoding
   is deterministic XOR over the encoded HTML and does not require rendering.
2. From homepage links, select contact-like URLs whose URL or anchor mentions contact,
   reach, get-in-touch, or enquiries. Add `/contact`, `/contact-us`, and `/contactus`
   as bounded fallbacks, then visit at most two unique contact candidates.
3. Use the normal Zyte static-first fetch. Do not force `browserHtml` merely to hunt for
   emails; rendering is allowed only when the shared fetcher detects a thin JavaScript
   shell.
4. Normalize emails to lowercase and deduplicate them. Drop malformed image/script
   matches, long hash-like locals, theme placeholders, fake example domains, and known
   third-party vendor/SaaS addresses.
5. Put any address on the company's own domain or its tolerated subdomain/root variant
   in `businessEmails`. Sort role inboxes such as `info@`, `reception@`, `admin@`,
   `contact@`, `office@`, `booking@`, or `support@` ahead of personal addresses.
6. Keep role-like Gmail/Outlook/other freemail contacts separately in `otherEmails`.
   Never promote them to the same-domain primary field in this stage.

Tool: `scripts/harvest-business-emails.ts`, using `extractEmails` from
`../../shared/lib/scrape.ts`. Default concurrency `6`; append one result per domain to
`business-email-ledger.jsonl`. Successful domains resume-skip, while errors retry.

Errors matter beyond this stage: a domain that errors here is **excluded permanently**
from cross-domain recovery, which only considers domains with a clean ledger record.
Re-run failures before moving on.

## Output and handoff

Return `domain`, `company`, `website`, `businessEmails`, `otherEmails`, `pages`, and an
optional `error`. Write one company row containing `business_email` (the first ranked
same-domain address), `all_business_emails` (all same-domain addresses), and
`other_contact_emails` (separate freemail contacts). Merge only the first two fields
into the people master using an atomic rewrite.

Pass domains without a strong same-domain address to the affiliated/cross-domain
recovery stage. An empty result is valid; never invent `info@domain`.
