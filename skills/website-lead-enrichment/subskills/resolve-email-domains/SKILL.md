---
name: resolve-email-domains
description: Use when company domains need checking for whether they can receive mail at all, before any address is predicted against them, so predictions are never generated on parked or dead domains.
---

# Resolve Receiving Email Domains

## Purpose

Ask DNS whether each company domain has MX records, and if so which provider runs them.
Free, fast, no key, no vendor. This is what stops the prediction stage from generating
addresses on domains that cannot receive mail at all.

Do not scrape, do not probe SMTP, do not guess addresses.

## Required inputs

- `--input <csv>` — the company list. **Required**; there is no default.
- No credentials. See `../../shared/PROVIDERS.md`; this stage appears there with every
  provider column empty, deliberately.
- `out/team-master.csv` is optional — used only to report how many email-less companies
  became predictable.

## Read this before trusting the name

**This stage does not discover an alternate mail domain.** When MX records exist,
`emailDomain` is set to the domain that was checked. It is a yes/no deliverability check
on a domain you already have, not a resolver that finds the look-alike domain a company
sends from. Discovering that a company's site is on `gethuntd.com` while its mail is on
`tryhuntd.com` is **not** something this pipeline does — the business-email domain from
stages 3 and 4 is the only mechanism that surfaces such a domain.

## Workflow

1. Run over **every** company domain, not only the ones missing an email. DNS is free and
   it seeds the domain column for the whole list.
2. Normalize away scheme, path, port, `www.`, and trailing dot.
3. Query MX against `1.1.1.1`, `8.8.8.8`, `9.9.9.9`. `ENODATA` and `ENOTFOUND` are
   authoritative "no MX" and short-circuit immediately. Anything else — `SERVFAIL`,
   timeout — escalates to DNS-over-HTTPS via Cloudflare then Google, once each. There is
   no retry loop beyond that.
4. Classify the provider by matching MX hostnames against ~20 fingerprints (Google
   Workspace, Microsoft 365, Proofpoint, Mimecast, Zoho, Fastmail, …), falling back to
   `other/self-hosted`. The **first** matching host wins, and hosts are in priority order,
   so a Mimecast gateway in front of Google reports Mimecast.
5. Record the top 3 MX hosts by priority.

## Confidence values

Exactly five, and only two of them matter downstream:

| Value | Meaning |
|---|---|
| `high` | MX present and matched a known provider |
| `medium` | MX present, provider unrecognized |
| `none` | no MX — dead or parked; not usable as a confirmed domain |
| `invalid` | domain unparseable |
| `error` | DNS failed; retried on the next run |

`high` and `medium` are treated **identically** by every consumer — both mean "this domain
receives mail". The split is reporting decoration only; do not build logic on it.

`none` and `invalid` **suppress prediction**. A domain DNS says accepts no mail cannot
hold a mailbox, so stage 8 emits no guess for its people — they get an empty `best_email`
with basis `no-domain` instead of an address guaranteed to bounce.

A domain that was simply never checked is different: stage 8 still guesses against it and
marks the result `(unverified-domain)`. Treat that as the weakest tier that still ships.

## What this proves, and what it does not

MX records prove a **domain** accepts mail. They say nothing about whether a particular
mailbox exists. Never describe an address as verified or deliverable on the strength of an
MX record. Mailbox-level verification is downstream and out of scope; there are no SMTP
probes here.

## Output and handoff

Cache `email-domain-cache.jsonl`: `{domain, company, website, emailDomain, provider,
confidence, hasMx, mx}`. Report `email-domains.csv`:
`company,domain,website,email_domain,provider,confidence,has_mx,mx`.

**This stage never writes to the master.** Stage 8 reads the cache and writes
`email_domain` and `mx_provider`.

Resume: everything except `error` is cached permanently — including `none`. A company that
later adds MX records will not be re-checked without `--force`. Concurrency defaults to 40,
far higher than the scraping stages, because this is only DNS.
