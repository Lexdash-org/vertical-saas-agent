---
name: extract-team-members
description: Use when verified team-directory and individual-profile URLs must be scraped to extract the organization's people, job titles, and publicly displayed personal emails before company-email harvesting or prediction.
license: MIT
metadata:
  author: Lexdash-org
---

# Extract Team Members

## Purpose

Consume the scrape plan from **discover-team-pages** and return the people actually
published by the organization. This stage owns page retrieval, structured extraction,
profile coverage, and person deduplication.

Do not rediscover team URLs, collect generic company inboxes, search the open web, look
up MX records, or generate email candidates.

## Required inputs

- `website`, `company`, `pages`, `profilePages`, and `profilePrefixes` from Stage 1.
- `LEADGEN_ZYTE_API_KEY` for every page fetch, plus the LLM reasoning and extraction roles.

Credentials and the no-fallback rule are defined once in `../../shared/PROVIDERS.md`.
Batch runs additionally require `--input <csv>`; there is no default list.

## Reuses stage 1 — do not re-map

When `out/.work/ledgers/team-page-rank.jsonl` holds a clean record for a domain, this stage
loads the shortlist from it instead of calling Firecrawl and the ranking model again. Only
domains **missing** from that ledger get mapped here.

That matters for cost: without it, running stage 1 then stage 2 pays for the same
Firecrawl map and the same LLM ranking twice on every company. `--remap` forces a fresh
map when a site has genuinely changed.

### A domain stage 1 already failed on is not re-mapped

A record carrying an `error` means mapping has been attempted and failed. Repeating it
here just pays the same timeout for the same answer — roughly 200s per failed site. Those
domains skip straight to unseeded exploration from the homepage.

When stage 1 also recorded `siteDown: true`, the host answered nothing at all and this
stage **skips the company outright**, in milliseconds and with no network calls. This is
the single biggest time sink the pipeline had: one unreachable clinic burned 617s — 47% of
a 25-company run — re-mapping and then thrashing against the site cap to extract nothing.
The company still reaches the master via stage 3, and `--remap` re-tests a site that may
have come back.

## Workflow

1. Fetch the ranked directory `pages` first. Use Zyte `httpResponseBody` for the fast
   static attempt. Escalate to `browserHtml` only when the result is a JavaScript shell
   with less than `600` characters of usable text.
2. Keep full fetched content outside the reasoning loop. Give the extraction model the
   page URL, discovered source emails, and page text; require strict
   `{people:[{name,title,email}]}` JSON.
3. Include employees, leaders, founders, practitioners, partners, board members, and
   staff listed as part of the organization. Exclude patients, testimonials, clients,
   unrelated article authors, departments, and locations.
4. Keep an email only when it is publicly present and clearly attributable to that
   person. `info@`, `reception@`, `admin@`, and other shared inboxes belong to Stage 3.
5. Use render/scroll/click interaction only after a normal fetch proves incomplete.
   Follow pagination or captured people-data APIs when the directory exposes them.
6. When known `profilePages` exceed the raw people count by more than `30%`, sweep
   unvisited profiles as the completeness fallback; cap the sweep at `150` pages and
   concurrency `8`. One failed profile must not fail the company.
7. Chunk oversized page content at `50,000` characters, up to `24` chunks, and merge
   duplicates case/punctuation-insensitively. Keep the fullest name, most specific
   title, and any attributable personal email. For more than `250` deduped people, skip
   the lossy final LLM organization pass and sort deterministically.

Tools in `scripts/`: `agent.ts` builds the extractor, `run-batch.ts` runs a resumable CSV
batch, `run-one.ts` handles a single site. Cap one company at `240s` (`--site-timeout-ms`)
and preserve any people extracted before the cap; run `6` companies at a time
(`--concurrency`), since each is mostly waiting on network. This is the only stage that
takes `out/.work/.batch.lock` — see `../../shared/PIPELINE-STATE.md` for why no two
master-writing stages may run at once.

## Output and handoff

Return `company`, `domain`, `website`, `people`, `pagesRanked`, `visits`, `ms`, and an
optional `error`. Each person is `{name, title, email}`, where `title` and `email` may be
null. Upsert people by normalized `domain + name`, then pass the master rows to the
business-email harvesting stage.
