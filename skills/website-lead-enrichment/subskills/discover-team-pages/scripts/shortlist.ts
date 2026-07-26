import fs from 'node:fs';
import { csvCell, type SiteRankRecord } from '../../../shared/lib/site.js';
import { shortlistPages } from './teamPages.js';
import { ledgerPath, workPath } from '../../../shared/lib/paths.js';
import { argVal } from '../../../shared/lib/cli.js';

/**
 * Turn the full ranking into the VISIT LIST: only the pages Sol is confident
 * about (score >= --min-score, default 85). These are the URLs the scrape+
 * extract step will actually fetch — individual profile pages stay in the
 * JSONL and are enumerated separately via profilePrefixes.
 *
 * Usage: npx tsx subskills/discover-team-pages/scripts/shortlist.ts [--min-score 85] [--max-pages 5]
 */

const MIN_SCORE = Number(argVal('--min-score') ?? 85);
const MAX_PAGES = Number(argVal('--max-pages') ?? 5);
// Both are working state: this is a diagnostic view of stage 1, not a deliverable.
const JSONL = ledgerPath('team-page-rank.jsonl');
const OUT_CSV = workPath('team-page-shortlist.csv');

// Last record per site wins (reruns/--force append newer records).
const byKey = new Map<string, SiteRankRecord>();
for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line) as SiteRankRecord;
  if (!rec.error) byKey.set(rec.key, rec);
}

const lines = ['company,website,score,kind,url,title'];
for (const rec of byKey.values()) {
  const confident = shortlistPages(rec.candidates, MIN_SCORE, MAX_PAGES);
  console.log(`\n${rec.company} (${rec.key})`);
  for (const c of confident) {
    console.log(`  ${c.score}  ${c.url}`);
    lines.push([rec.company, rec.website, String(c.score), c.kind, c.url, c.title ?? ''].map(csvCell).join(','));
  }
  if (rec.profileUrls.length) {
    console.log(`  (+${rec.profileUrls.length} individual profile pages under ${rec.profilePrefixes.join(', ')})`);
  }
  if (!confident.length) console.log(`  !! nothing above score ${MIN_SCORE}`);
}
fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n');
console.log(`\nWrote ${OUT_CSV}`);
