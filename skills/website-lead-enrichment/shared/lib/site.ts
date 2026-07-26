import fs from 'node:fs';
import { z } from 'zod';
import type { Firecrawl } from 'firecrawl';
import type OpenAI from 'openai';

/**
 * Step 1 of the team-member scraper: website -> Firecrawl map -> LLM-ranked
 * list of pages likely to name the people working at the organization.
 *
 * Deliberately NOT keyword-only: every mapped URL (up to a cap) goes to the
 * model so unconventional paths ("/meet-marcus", "/our-radiologists",
 * "/locations/x#specialists") still surface.
 */

export interface SiteTarget {
  /** Dedupe key: apex-ish host, lowercase, no www. */
  key: string;
  company: string;
  /** Website exactly as it appeared in the CSV (may be a deep page). */
  original: string;
  /** Scheme+host root used for mapping. */
  origin: string;
}

export interface MapLink {
  url: string;
  title?: string;
  description?: string;
}

export interface RankedCandidate {
  url: string;
  title?: string;
  score: number;
  reason: string;
  kind: 'directory' | 'profile' | 'other';
}

export interface RankResult {
  candidates: RankedCandidate[];
  /** Path prefixes for per-person profile pages, e.g. "/doctors/". */
  profilePrefixes: string[];
  /** Every mapped URL matching a profile prefix — the exhaustive person list. */
  profileUrls: string[];
}

export interface SiteRankRecord {
  key: string;
  company: string;
  website: string;
  origin: string;
  mappedCount: number;
  candidateCount: number;
  candidates: RankedCandidate[];
  profilePrefixes: string[];
  profileUrls: string[];
  mapMs: number;
  rankMs: number;
  finishedAt: string;
  error?: string;
  /**
   * Set only when mapping failed AND a plain HTTP request could not reach the host.
   * Downstream stages skip these outright instead of spending an extraction budget on
   * a site that cannot answer. Absent means "not checked" or "host answered".
   */
  siteDown?: boolean;
}

/**
 * Is the host answering at all? Used only to decide whether a site is worth a scrape
 * budget after its URL map failed.
 *
 * This is a plain `fetch`, not a Zyte fetch, and that is deliberate rather than a
 * fallback: nothing here reads, parses or extracts from the response. It looks at
 * whether bytes came back at all. Any HTTP status counts as alive — a 403 or 503 means
 * a server is there, and Zyte may well get through where a bare request does not. Only
 * DNS failure, connection refused, or a timeout count as down.
 */
/**
 * Domains stage 1 proved unreachable, read from its ledger.
 *
 * A dead website is not a dead company — `scheart.com.au` serves nothing yet has live
 * Microsoft 365 MX records. So this gates only the stages that FETCH PAGES (2, 3, 4);
 * DNS and prediction still run, because mail routinely outlives a website.
 *
 * Sniffed rather than parsed: a rank record carries every ranked candidate URL, so
 * JSON.parse over a thousand of them costs far more memory than this needs.
 */
export function unreachableDomains(rankLedgerFile: string): Set<string> {
  const down = new Set<string>();
  if (!fs.existsSync(rankLedgerFile)) return down;
  for (const line of fs.readFileSync(rankLedgerFile, 'utf8').split('\n')) {
    if (!line.includes('"siteDown":true')) continue;
    const m = /"key"\s*:\s*"([^"]+)"/.exec(line);
    if (m) down.add(m[1]);
  }
  return down;
}

export async function isSiteReachable(url: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; website-lead-enrichment/1.0)' },
    });
    // Drain rather than parse — leaving the body open keeps the socket alive.
    await res.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF, BOM). */
export const parseCsv = (raw: string): { header: string[]; rows: string[][] } => {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  // Strip a UTF-8 BOM. Excel-exported lists routinely carry one, and it binds to the
  // FIRST header cell — so `header.indexOf('Name')` silently returned -1 and every
  // stage fell back to using the website string as the company name.
  const text = raw
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; }
    else if (c === ',') { record.push(field); field = ''; }
    else if (c === '\n') { record.push(field); records.push(record); record = []; field = ''; }
    else { field += c; }
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record); }

  const header = records.shift() || [];
  const rows = records.filter((r) => r.some((cell) => cell.trim() !== ''));
  return { header, rows };
};

/** Quote a CSV field when it needs it. The writer counterpart to parseCsv. */
export const csvCell = (v: string): string =>
  /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** Normalize a raw CSV website value into a mappable target. */
export function normalizeWebsite(raw: string, company: string): SiteTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes('.')) return null;
    const key = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    return { key, company, original: parsed.toString(), origin: `${parsed.protocol}//${parsed.host}/` };
  } catch {
    return null;
  }
}

// Files/paths that can never hold team info (mirrors huntd's map-step filter).
const NON_CONTENT_PATH =
  /(?:^|\/)(?:sitemap(?:[_-][^/]*)?\.xml(?:\.gz)?|robots\.txt)$|\.(?:css|js|mjs|map|json|xml|pdf|jpe?g|png|gif|webp|svg|ico|woff2?|ttf|eot|zip|gz|mp[34]|webm|avi|mov)$/i;

/**
 * Clean the mapped links: same site only, no assets, dedupe by host+path,
 * re-add the original CSV URL (it may be a deep location page), cap the list.
 */
export function filterCandidates(
  links: MapLink[],
  target: SiteTarget,
  cap = 500,
): { entries: MapLink[]; dropped: number } {
  const seen = new Set<string>();
  const entries: MapLink[] = [];
  let dropped = 0;
  const push = (link: MapLink) => {
    try {
      const parsed = new URL(link.url);
      if (!/^https?:$/.test(parsed.protocol) || NON_CONTENT_PATH.test(parsed.pathname)) return;
      const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
      // Keep the site and its subdomains; drop external links.
      if (host !== target.key && !host.endsWith(`.${target.key}`) && !target.key.endsWith(`.${host}`)) return;
      parsed.hash = '';
      const dedupeKey = `${host}${parsed.pathname.replace(/\/+$/, '') || '/'}${parsed.search}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      if (entries.length >= cap) {
        dropped += 1;
        return;
      }
      entries.push({ ...link, url: parsed.toString() });
    } catch {
      // Ignore malformed URLs from the provider.
    }
  };
  push({ url: target.original });
  for (const link of links) push(link);
  return { entries, dropped };
}

/** Firecrawl map with small retry (map is cheap; transient 5xx/429 happen). */
export async function mapSite(
  firecrawl: Firecrawl,
  target: SiteTarget,
  opts: { limit: number; timeoutMs: number },
): Promise<MapLink[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await firecrawl.map(target.origin, {
        limit: opts.limit,
        sitemap: 'include',
        timeout: opts.timeoutMs,
      });
      return (data.links ?? []).map((l) => ({ url: l.url, title: l.title, description: l.description }));
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Payment/auth problems will not heal on retry.
      if (/402|401|payment|unauthorized/i.test(msg)) throw err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

const rankResponseSchema = z.object({
  candidates: z.array(
    z.object({
      index: z.number().int(),
      score: z.number().min(0).max(100),
      reason: z.string(),
      kind: z.enum(['directory', 'profile', 'other']).default('other'),
    }),
  ),
  profilePrefixes: z.array(z.string()).default([]),
});

const RANK_SYSTEM_PROMPT = `You rank pages of an organization's website by how likely each page is to contain the NAMES of people who work there (employees, doctors, practitioners, partners, leadership).

Each candidate has a kind:
- "directory": a page listing MANY people — team, our-people, staff, doctors, specialists, practitioners, providers, leadership, board, "meet the team", location/clinic pages that list their practitioners.
- "profile": a page about ONE person (an individual bio page).
- "other": anything else that still names people (about, history/founders, news naming staff).

Scoring: 85-100 dedicated people directories and clear person profiles; 55-84 pages that usually name at least some staff (about, location pages, service pages naming the treating specialists); 30-54 occasional mentions (news/blog hire announcements, awards, contact). Exclude entirely: careers/job listings (openings, not people), privacy/terms, product/pricing, generic service descriptions, patient info, search/tag/pagination pages.

Profile pages often share a common path prefix (e.g. many URLs under "/doctors/" or "/team/"). Report each such prefix in "profilePrefixes" instead of listing every profile page as a candidate — list at most 2 representative profile pages per prefix in "candidates". Only report a prefix when the pages under it are clearly per-person pages (person-name-like slugs), not services or locations.

Do not rely only on obvious path keywords: use page titles and any path hints; unconventional paths can still be people pages. When in doubt at medium confidence, include it with an honest score. Prefer directories first in the ranking.

Respond with strict JSON only: {"candidates":[{"index":<number from the list>,"score":<0-100>,"reason":"<short reason>","kind":"directory|profile|other"}],"profilePrefixes":["/doctors/"]}. Return at most the number of candidates requested, best first. Only use index values from the list.`;

/** Ask the model to pick the pages most likely to name employees. */
export async function rankTeamPages(
  client: OpenAI,
  model: string,
  target: SiteTarget,
  entries: MapLink[],
  topK: number,
): Promise<RankResult> {
  const lines = entries.map((e, i) => {
    const path = (() => {
      try {
        const u = new URL(e.url);
        return `${u.pathname}${u.search}` || '/';
      } catch {
        return e.url;
      }
    })();
    return `${i}. ${path}${e.title ? ` — ${e.title}` : ''}`;
  });
  const user = [
    `Organization: ${target.company}`,
    `Website: ${target.origin}`,
    `Return up to ${topK} candidates.`,
    'Pages:',
    ...lines,
  ].join('\n');

  const res = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: RANK_SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? '';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = rankResponseSchema.parse(JSON.parse(cleaned));

  const out: RankedCandidate[] = [];
  for (const c of parsed.candidates) {
    const entry = entries[c.index];
    if (!entry) continue; // model invented an index — drop it
    out.push({
      url: entry.url,
      title: entry.title,
      score: Math.round(c.score),
      reason: c.reason,
      kind: c.kind,
    });
    if (out.length >= topK) break;
  }
  // Directories are the crawl entry points — surface them above profiles.
  const kindOrder = { directory: 0, other: 1, profile: 2 } as const;
  out.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.score - a.score);

  const prefixes = [...new Set(parsed.profilePrefixes.map((p) => normalizePrefix(p)).filter(Boolean))];
  const profileUrls = entries
    .filter((e) => {
      try {
        const u = new URL(e.url);
        return prefixes.some((p) => u.pathname.toLowerCase().startsWith(p) && u.pathname.replace(/\/+$/, '').toLowerCase() !== p.replace(/\/+$/, ''));
      } catch {
        return false;
      }
    })
    .map((e) => e.url);
  return { candidates: out, profilePrefixes: prefixes, profileUrls };
}

/** "/doctors" | "doctors/" | full URL -> "/doctors/" (lowercase, trailing slash). */
function normalizePrefix(raw: string): string {
  let p = raw.trim().toLowerCase();
  if (!p) return '';
  try {
    if (/^https?:\/\//.test(p)) p = new URL(p).pathname;
  } catch {
    return '';
  }
  if (!p.startsWith('/')) p = `/${p}`;
  if (!p.endsWith('/')) p = `${p}/`;
  return p === '/' ? '' : p;
}
