import {
  filterCandidates,
  mapSite,
  normalizeWebsite,
  rankTeamPages,
  type RankedCandidate,
} from '../../../shared/lib/site.js';
import { clientsFromEnv, type TeamPagesClients } from '../../../shared/lib/llm.js';

/**
 * The module boundary: website in -> confident team-page shortlist out.
 *
 * No CSV, no files, no dotenv — callers own I/O and env loading. Hook it from
 * anything: `const result = await findTeamPages('qldxray.com.au')`.
 */


export interface FindTeamPagesOptions {
  /** Organization name; improves ranking context. Defaults to the domain. */
  company?: string;
  /** Reuse/override clients (tests, pooled keys). Default: clientsFromEnv(). */
  clients?: TeamPagesClients;
  /** Max candidates the model may return. Default 15. */
  topK?: number;
  /** Shortlist threshold: only pages scored >= this. Default 85. */
  minScore?: number;
  /** Shortlist length cap. Default 5. */
  maxPages?: number;
  /** Firecrawl map limit. Default 1000. */
  mapLimit?: number;
  /** Max URLs sent to the ranker. Default 800 (snp.com.au needed >500). */
  urlCap?: number;
  /** Firecrawl map timeout. Default 60s. */
  mapTimeoutMs?: number;
}

export interface TeamPage {
  url: string;
  score: number;
  kind: 'directory' | 'profile' | 'other';
  title?: string;
  reason: string;
}

export interface TeamPagesResult {
  /** Input website, normalized. */
  website: string;
  origin: string;
  /** Host without www — stable dedupe key. */
  domain: string;
  company: string;
  /** THE OUTPUT: confident pages to visit, best first. */
  pages: TeamPage[];
  /** Per-person bio pages enumerated from the model's URL prefixes. */
  profilePages: string[];
  profilePrefixes: string[];
  /** Full ranking (includes below-threshold pages) for debugging/tuning. */
  allCandidates: RankedCandidate[];
  mappedCount: number;
  rankedCount: number;
  mapMs: number;
  rankMs: number;
}

/** Filter a full ranking down to the confident visit list. */
export function shortlistPages(
  candidates: RankedCandidate[],
  minScore = 85,
  maxPages = 5,
): TeamPage[] {
  return candidates
    .filter((c) => c.score >= minScore && c.kind !== 'profile')
    .slice(0, maxPages);
}

/** Website in -> confident team-page shortlist out. Throws on invalid input or provider failure. */
export async function findTeamPages(
  website: string,
  opts: FindTeamPagesOptions = {},
): Promise<TeamPagesResult> {
  const target = normalizeWebsite(website, opts.company ?? '');
  if (!target) throw new Error(`not a usable website: "${website}"`);
  if (!target.company) target.company = target.key;
  const clients = opts.clients ?? clientsFromEnv();

  const t0 = Date.now();
  const links = await mapSite(clients.firecrawl, target, {
    limit: opts.mapLimit ?? 1000,
    timeoutMs: opts.mapTimeoutMs ?? 60_000,
  });
  const mapMs = Date.now() - t0;
  const { entries } = filterCandidates(links, target, opts.urlCap ?? 800);

  const t1 = Date.now();
  const ranked = await rankTeamPages(clients.openai, clients.model, target, entries, opts.topK ?? 15);
  const rankMs = Date.now() - t1;

  return {
    website: target.original,
    origin: target.origin,
    domain: target.key,
    company: target.company,
    pages: shortlistPages(ranked.candidates, opts.minScore, opts.maxPages),
    profilePages: ranked.profileUrls,
    profilePrefixes: ranked.profilePrefixes,
    allCandidates: ranked.candidates,
    mappedCount: links.length,
    rankedCount: entries.length,
    mapMs,
    rankMs,
  };
}
