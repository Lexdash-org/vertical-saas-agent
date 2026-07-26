---
name: discover-team-pages
description: Use when a company website must be reduced to the real directory and profile URLs most likely to name its employees, staff, clinicians, partners, leaders, or other team members before any page scraping begins.
---

# Discover Team Pages

## Purpose

Turn one company website into a bounded scrape plan: a short ranked list of directory
pages plus every observed individual-profile URL belonging to confidently detected
profile families.

This is discovery and ranking only. Do not scrape page bodies, extract people, search
the open web, find emails, or generate email candidates.

## Required inputs

- Website or domain; company name is optional ranking context.
- `FIRECRAWL_API_KEY` for URL mapping, and the LLM reasoning role for ranking.

Credentials and the no-fallback rule are defined once in `../../shared/PROVIDERS.md`.
Batch runs additionally require `--input <csv>`; there is no default list.

## Workflow

1. Normalize the input to its HTTP(S) origin and stable domain.
2. Use Firecrawl `map` with sitemap discovery, limit `1000`, and timeout `60s`.
3. Keep only observed same-site HTTP(S) URLs. Remove assets, documents, malformed URLs,
   fragments, and duplicates. Re-add the supplied URL because it may be a useful deep
   page. Send at most `800` candidates to the ranker.
4. Give the model indexed paths and titles—not arbitrary URL-generation freedom. Ask it
   for at most `15` results with `index`, `score`, `reason`, `kind`, and detected
   per-person path prefixes. Drop out-of-range indices.
5. Classify pages as `directory`, `profile`, or `other`. Exclude careers, legal pages,
   assets, generic services, patient/customer content, tags, search, and pagination.
6. Return at most five non-profile pages scoring at least `85`, best first. Expand each
   confirmed profile prefix against the observed map so large teams are not truncated.

**When Firecrawl reports "the map operation timed out"** the site is too large for the
default 60s window. Retrying unchanged will fail identically — raise `--map-timeout-ms`
or lower `--map-limit` for that domain. If it still times out, record it as a discovery
miss and move on: the company can still yield a business inbox at stage 3. Never
substitute your own browsing to guess its team page.

Tools in `scripts/`: `teamPages.ts` is the module boundary (`findTeamPages`),
`rank-batch.ts` runs a resumable CSV batch, `rank-one.ts` handles a single site, and
`shortlist.ts` re-filters an existing ranking without re-mapping. Callers own file I/O.
Retry transient Firecrawl failures up to three times, but fail immediately on
authentication or payment errors.

## Output contract

Return `website`, `origin`, `domain`, `company`, `pages`, `profilePages`,
`profilePrefixes`, `allCandidates`, `mappedCount`, `rankedCount`, `mapMs`, and `rankMs`.
Every returned URL must originate from Firecrawl's map or the supplied website. An empty
shortlist is valid; never invent a conventional `/team` URL.

## Handoff

Pass `pages` and `profilePages` to the people-extraction stage. Directory pages are the
first scrape targets; profile pages are the exhaustive fallback/sweep set.
