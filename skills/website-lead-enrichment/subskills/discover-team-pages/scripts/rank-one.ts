import { findTeamPages } from './teamPages.js';
import { loadEnv } from '../../../shared/lib/paths.js';
import { argVal } from '../../../shared/lib/cli.js';

/**
 * One website in -> shortlist out, on stdout.
 *
 *   npx tsx subskills/discover-team-pages/scripts/rank-one.ts qldxray.com.au
 *   npx tsx subskills/discover-team-pages/scripts/rank-one.ts https://advaraheartcare.com --company "Advara HeartCare" --json
 *
 * --json prints the full TeamPagesResult (machine-readable, pipe it anywhere);
 * default output is a human-readable shortlist. Exit 1 on failure.
 */

loadEnv();

const flags = new Set(process.argv.filter((a) => a.startsWith('--')));
const website = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== argVal('--company') && a !== argVal('--min-score') && a !== argVal('--max-pages'));

if (!website) {
  console.error('usage: npx tsx subskills/discover-team-pages/scripts/rank-one.ts <website> [--company "Name"] [--min-score 85] [--max-pages 5] [--json]');
  process.exit(1);
}

try {
  const result = await findTeamPages(website, {
    company: argVal('--company'),
    minScore: argVal('--min-score') ? Number(argVal('--min-score')) : undefined,
    maxPages: argVal('--max-pages') ? Number(argVal('--max-pages')) : undefined,
  });
  if (flags.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.company} — mapped ${result.mappedCount} urls in ${result.mapMs}ms, ranked in ${result.rankMs}ms\n`);
    for (const p of result.pages) console.log(`  ${p.score}  [${p.kind}]  ${p.url}${p.title ? `  — ${p.title}` : ''}`);
    if (!result.pages.length) console.log('  (no confident pages found)');
    if (result.profilePages.length) {
      console.log(`\n  +${result.profilePages.length} individual profile pages under: ${result.profilePrefixes.join(', ')}`);
    }
  }
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
