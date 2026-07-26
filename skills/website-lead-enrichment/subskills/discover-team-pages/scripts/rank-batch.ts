import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { csvCell, isSiteReachable, normalizeWebsite, parseCsv, type SiteRankRecord, type SiteTarget } from '../../../shared/lib/site.js';
import { findTeamPages } from './teamPages.js';
import { clientsFromEnv } from '../../../shared/lib/llm.js';
import { ledgerPath, loadEnv, workPath } from '../../../shared/lib/paths.js';
import { argVal, hasFlag, requireInput, requireColumn } from '../../../shared/lib/cli.js';

/**
 * Team-scraper step 1: for every website in the input CSV, Firecrawl-map the
 * site and LLM-rank the discovered URLs by how likely they are to name the
 * organization's people (team/staff/doctors/leadership/...).
 *
 * Resumable: one JSONL record per site in out/team-page-rank.jsonl; a re-run
 * skips sites that already have a successful record (use --force to redo).
 * Failed sites are recorded with an error and retried on the next run.
 *
 * Usage:
 *   npx tsx scripts/rank-batch.ts [--input file.csv] [--col Website] [--name-col Name]
 *                             [--only "qldxray,advara"] [--limit N] [--top K]
 *                             [--map-limit N] [--map-timeout-ms N] [--concurrency K] [--force]
 */

loadEnv();

const INPUT_CSV = requireInput();
const WEBSITE_COL = argVal('--col') ?? 'Website';
const NAME_COL = argVal('--name-col') ?? 'Name';
const TOP_K = Number(argVal('--top') ?? 15);
const MAP_LIMIT = Number(argVal('--map-limit') ?? 1000);
// Big sites can exceed Firecrawl's default map window. Raising this (or lowering
// --map-limit) is the documented escape for "The map operation timed out".
const MAP_TIMEOUT_MS = Number(argVal('--map-timeout-ms') ?? 60_000);
const URL_CAP = Number(argVal('--url-cap') ?? 800);
const CONCURRENCY = Number(argVal('--concurrency') ?? 3);
const SITE_LIMIT = argVal('--limit') ? Number(argVal('--limit')) : Infinity;
const ONLY = (argVal('--only') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const FORCE = hasFlag('--force');

const JSONL = ledgerPath('team-page-rank.jsonl');
const OUT_CSV = workPath('team-page-candidates.csv');

function loadTargets(): SiteTarget[] {
  const { header, rows } = parseCsv(fs.readFileSync(INPUT_CSV, 'utf8'));
  const siteIdx = requireColumn(header, WEBSITE_COL);
  const nameIdx = header.indexOf(NAME_COL);
  const byKey = new Map<string, SiteTarget>();
  for (const row of rows) {
    const company = nameIdx >= 0 ? row[nameIdx]?.trim() || row[siteIdx] : row[siteIdx];
    const target = normalizeWebsite(row[siteIdx] ?? '', company ?? '');
    if (!target) continue;
    if (!byKey.has(target.key)) byKey.set(target.key, target);
  }
  let targets = [...byKey.values()];
  if (ONLY.length) {
    targets = targets.filter((t) =>
      ONLY.some((frag) => t.key.includes(frag) || t.company.toLowerCase().includes(frag)),
    );
  }
  return targets.slice(0, SITE_LIMIT);
}

function loadDone(): Map<string, SiteRankRecord> {
  const done = new Map<string, SiteRankRecord>();
  if (FORCE || !fs.existsSync(JSONL)) return done;
  for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as SiteRankRecord;
      if (!rec.error) done.set(rec.key, rec); // errored sites get retried
    } catch {
      // Skip corrupt lines (e.g. interrupted write).
    }
  }
  return done;
}

function writeSummaryCsv(records: SiteRankRecord[]): void {
  const lines = ['company,website,rank,kind,score,url,title,reason,error'];
  for (const rec of records) {
    if (rec.error) {
      lines.push([rec.company, rec.website, '', '', '', '', '', '', rec.error].map(csvCell).join(','));
      continue;
    }
    if (!rec.candidates.length && !rec.profileUrls.length) {
      lines.push([rec.company, rec.website, '', '', '', '', '', 'no candidate pages found', ''].map(csvCell).join(','));
      continue;
    }
    rec.candidates.forEach((c, i) => {
      lines.push(
        [rec.company, rec.website, String(i + 1), c.kind, String(c.score), c.url, c.title ?? '', c.reason, '']
          .map(csvCell)
          .join(','),
      );
    });
    // Exhaustive per-person pages expanded from the model's profile prefixes.
    const listed = new Set(rec.candidates.map((c) => c.url));
    for (const url of rec.profileUrls) {
      if (listed.has(url)) continue;
      lines.push([rec.company, rec.website, '', 'profile', '', url, '', 'expanded from profile prefix', ''].map(csvCell).join(','));
    }
  }
  fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const clients = clientsFromEnv();
  const targets = loadTargets();
  const done = loadDone();
  const pending = targets.filter((t) => !done.has(t.key));
  console.log(
    `${targets.length} unique site(s) from ${path.basename(INPUT_CSV)} — ${done.size} already ranked, ${pending.length} to run (model ${clients.model})`,
  );

  const limit = pLimit(CONCURRENCY);
  await Promise.all(
    pending.map((target) =>
      limit(async () => {
        const rec: SiteRankRecord = {
          key: target.key,
          company: target.company,
          website: target.original,
          origin: target.origin,
          mappedCount: 0,
          candidateCount: 0,
          candidates: [],
          profilePrefixes: [],
          profileUrls: [],
          mapMs: 0,
          rankMs: 0,
          finishedAt: '',
        };
        try {
          const result = await findTeamPages(target.original, {
            company: target.company,
            clients,
            topK: TOP_K,
            mapLimit: MAP_LIMIT,
            urlCap: URL_CAP,
            mapTimeoutMs: MAP_TIMEOUT_MS,
          });
          rec.mapMs = result.mapMs;
          rec.rankMs = result.rankMs;
          rec.mappedCount = result.mappedCount;
          rec.candidates = result.allCandidates;
          rec.profilePrefixes = result.profilePrefixes;
          rec.profileUrls = result.profilePages;
          rec.candidateCount = rec.candidates.length;
          if (result.mappedCount > result.rankedCount + 50) {
            console.log(`  [${target.key}] url cap — ranked ${result.rankedCount}/${result.mappedCount} mapped urls`);
          }
          const top = rec.candidates[0];
          console.log(
            `✓ ${target.key} — mapped ${rec.mappedCount} (${result.rankedCount} kept), ${rec.candidateCount} candidates` +
              (rec.profileUrls.length ? `, ${rec.profileUrls.length} profile pages via ${rec.profilePrefixes.join(' ')}` : '') +
              (top ? `, top: ${top.url} (${top.score})` : ''),
          );
        } catch (err) {
          rec.error = err instanceof Error ? err.message : String(err);
          // Mapping failing can mean two very different things: a big or slow site that
          // Firecrawl gave up on, or a host that is simply gone. One plain request tells
          // them apart for free, and stage 2 skips the dead ones instead of spending its
          // whole per-site budget discovering the same thing the expensive way.
          rec.siteDown = !(await isSiteReachable(target.origin));
          console.error(`✗ ${target.key} — ${rec.error}${rec.siteDown ? ' [host unreachable — will be skipped]' : ''}`);
        }
        rec.finishedAt = new Date().toISOString();
        fs.appendFileSync(JSONL, JSON.stringify(rec) + '\n');
        done.set(target.key, rec);
      }),
    ),
  );

  // Summary CSV covers every target in input order, including prior-run records.
  const all = targets
    .map((t) => done.get(t.key))
    .filter((r): r is SiteRankRecord => Boolean(r));
  writeSummaryCsv(all);
  const failed = all.filter((r) => r.error).length;
  console.log(`\nWrote ${OUT_CSV} (${all.length} sites, ${failed} failed)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
