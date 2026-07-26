import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { csvCell, normalizeWebsite, parseCsv } from '../lib/site.js';
import {
  findTeamPages,
  shortlistPages,
  type TeamPagesResult,
} from '../discover-team-pages/teamPages.js';
import { clientsFromEnv } from '../lib/llm.js';
import type { SiteRankRecord } from '../lib/site.js';
import { buildTeamExtractor, lunaClient, organizePeople } from './agent.js';
import { extractPeopleFromPage, fetchPage, type Person } from '../lib/scrape.js';
import { extractionModel } from '../lib/llm.js';
import { COMPANIES_DIR, MASTER_CSV, ledgerPath, loadEnv, workPath, writeAtomic } from '../lib/paths.js';
import { argVal, requireInput, requireColumn } from '../lib/cli.js';

/**
 * Full pipeline over a CSV of websites:
 *   team-pages (map + sol ranking) -> confident shortlist
 *   -> team-extract mastra agent (seeded with the shortlist, visits + extracts)
 *   -> ONE master CSV, upserted: new person = new row, known person (same
 *      domain + name) = update title/email in place.
 *
 * Master: out/.work/team-master.csv. Per-site debug JSON: out/.work/companies/<host>.json.
 * Resumable: sites already in the master are skipped unless --force.
 *
 * Usage:
 *   npx tsx scripts/run-batch.ts [--input file.csv] [--col Website] [--name-col Name]
 *                                     [--only frag,frag] [--limit N] [--concurrency K] [--force]
 */

// ~/.leadgen/.env is authoritative: it is loaded with override:true, so a stale key
// exported in ~/.zshrc cannot shadow the valid one. See scripts/lib/paths.ts.
loadEnv();

const INPUT_CSV = requireInput();
const WEBSITE_COL = argVal('--col') ?? 'Website';
const NAME_COL = argVal('--name-col') ?? 'Name';
const ONLY = (argVal('--only') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const SITE_LIMIT = argVal('--limit') ? Number(argVal('--limit')) : Infinity;
/**
 * Sites extracted in parallel. Each one is mostly waiting on network — Zyte fetches and
 * LLM calls — so the ceiling is provider rate limits, not local CPU. Measured median was
 * 27s per site; at 3 the lanes sat idle. Lower it if a provider starts 429ing.
 */
const CONCURRENCY = Number(argVal('--concurrency') ?? 6);
const FORCE = process.argv.includes('--force');

const LEDGER = ledgerPath('extract-ledger.jsonl');
const LOCK = workPath('.batch.lock');
const RANK_LEDGER = ledgerPath('team-page-rank.jsonl');
/** Re-map even when stage 1 already ranked the site. */
const REMAP = process.argv.includes('--remap');

/**
 * Reuse stage 1's ranking instead of re-running it.
 *
 * This stage used to call findTeamPages() for every company regardless, which repeated
 * the Firecrawl map AND the LLM ranking that stage 1 had just done and written to
 * team-page-rank.jsonl — double the credits and double the wall-clock on the discovery
 * half of every run. Sites absent from the ledger (or recorded with an error) still get
 * mapped here, so running stage 2 alone behaves exactly as before.
 */
function loadRankLedger(): Map<string, string> {
  const byKey = new Map<string, string>();
  if (REMAP || !fs.existsSync(RANK_LEDGER)) return byKey;
  for (const line of fs.readFileSync(RANK_LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    // Cheap key sniff — the full parse happens only for sites we actually process.
    const m = /"key"\s*:\s*"([^"]+)"/.exec(line);
    if (m) byKey.set(m[1], line);
  }
  return byKey;
}

const rankLedger = loadRankLedger();

/**
 * Hydrate one site's ranking on demand. Parsing the whole ledger up front meant
 * `--only one-clinic` paid for ~1,000 records, and every skipped site's ranked
 * candidates stayed resident for the hours a batch runs.
 */
/**
 * What stage 1 concluded about a site, when it failed.
 *
 * `null` means stage 1 never got to it, so re-mapping here is worth a try. A record
 * that carries an error means mapping has ALREADY been attempted and failed — repeating
 * it just pays the same timeout twice, which is where roughly 200s per failed site went.
 */
function rankFailure(key: string): { siteDown: boolean; reason: string } | null {
  const line = rankLedger.get(key);
  if (!line) return null;
  try {
    const rec = JSON.parse(line) as SiteRankRecord;
    if (!rec.error) return null;
    return { siteDown: rec.siteDown === true, reason: rec.error };
  } catch {
    return null;
  }
}

function cachedRanking(key: string): TeamPagesResult | null {
  const line = rankLedger.get(key);
  if (!line) return null;
  try {
    const rec = JSON.parse(line) as SiteRankRecord;
    if (rec.error) return null;
    return {
      website: rec.website,
      origin: rec.origin,
      domain: rec.key,
      company: rec.company,
      pages: shortlistPages(rec.candidates ?? []),
      profilePages: rec.profileUrls ?? [],
      profilePrefixes: rec.profilePrefixes ?? [],
      // Only pages/profilePages/profilePrefixes are read downstream; the rest of the
      // record is not retained.
      allCandidates: [],
      mappedCount: 0,
      rankedCount: 0,
      mapMs: 0,
      rankMs: 0,
    };
  } catch {
    return null; // corrupt line — fall through to a fresh map
  }
}

/** Wall-clock cap per site — a dead/slow host must not hold a slot forever. */
/**
 * Hard cap on the agent loop for one site. Whatever was extracted before the cap is
 * kept, so this trades a long tail for a little completeness on very large sites. The
 * slowest site that actually returned people in a 25-clinic run took 82s.
 */
const SITE_TIMEOUT_MS = Number(argVal('--site-timeout-ms') ?? 240_000);

/**
 * Single-writer lock. Two batch processes both doing load->upsert->write on the
 * master would silently clobber each other's people; stale locks (dead PID) are
 * reclaimed automatically.
 */
function acquireLock(): void {
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      console.error(
        `another batch is already running (pid ${pid}) and owns ${path.basename(MASTER_CSV)}.\n` +
          'Wait for it, or stop it first — concurrent runs corrupt the master.',
      );
      process.exit(1);
    }
    console.log(`reclaiming stale lock from dead pid ${pid}`);
  }
  fs.writeFileSync(LOCK, String(process.pid));
  const release = () => {
    try {
      if (fs.existsSync(LOCK) && Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) {
        fs.unlinkSync(LOCK);
      }
    } catch {
      // best effort
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }
}
const MASTER_HEADER = ['company', 'domain', 'website', 'name', 'title', 'email', 'email_source_url', 'updated_at'];

// ---------------------------------------------------------------------------
// Master CSV: load -> upsert -> write (single writer; person key = domain+name)
// ---------------------------------------------------------------------------

interface MasterRow {
  company: string;
  domain: string;
  website: string;
  name: string;
  title: string;
  email: string;
  /** The page `email` was read from — proof that ships beside the address. */
  emailSourceUrl: string;
  updatedAt: string;
}

const personKey = (domain: string, name: string): string =>
  `${domain}::${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;

function loadMaster(): Map<string, MasterRow> {
  const rows = new Map<string, MasterRow>();
  if (!fs.existsSync(MASTER_CSV)) return rows;
  const { header, rows: raw } = parseCsv(fs.readFileSync(MASTER_CSV, 'utf8'));
  const idx = Object.fromEntries(MASTER_HEADER.map((h) => [h, header.indexOf(h)]));
  for (const r of raw) {
    const row: MasterRow = {
      company: r[idx.company] ?? '',
      domain: r[idx.domain] ?? '',
      website: r[idx.website] ?? '',
      name: r[idx.name] ?? '',
      title: r[idx.title] ?? '',
      email: r[idx.email] ?? '',
      emailSourceUrl: r[idx.email_source_url] ?? '',
      updatedAt: r[idx.updated_at] ?? '',
    };
    if (row.domain && row.name) rows.set(personKey(row.domain, row.name), row);
  }
  return rows;
}

/** Atomic write (tmp + rename) — a crash mid-write must never corrupt the master. */
function writeMaster(rows: Map<string, MasterRow>): void {
  const sorted = [...rows.values()].sort(
    (a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name),
  );
  const lines = [MASTER_HEADER.join(',')];
  for (const r of sorted) {
    lines.push(
      [r.company, r.domain, r.website, r.name, r.title, r.email, r.emailSourceUrl, r.updatedAt]
        .map(csvCell)
        .join(','),
    );
  }
  writeAtomic(MASTER_CSV, lines.join('\n') + '\n');
}

/** Domains with a successful ledger entry — includes legitimate 0-people sites. */
function loadLedgerDone(): Set<string> {
  const ok = new Set<string>();
  if (!fs.existsSync(LEDGER)) return ok;
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { domain: string; error?: string };
      if (!rec.error) ok.add(rec.domain); // errored sites retry on resume
    } catch {
      // ignore a torn line from a crash mid-append
    }
  }
  return ok;
}

/** New person -> new row; existing (domain+name) -> fill/refresh title+email. */
function upsertPeople(
  master: Map<string, MasterRow>,
  site: { company: string; domain: string; website: string },
  people: Person[],
): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  for (const p of people) {
    if (!p.name.trim()) continue;
    const key = personKey(site.domain, p.name);
    const existing = master.get(key);
    if (!existing) {
      master.set(key, {
        company: site.company,
        domain: site.domain,
        website: site.website,
        name: p.name.trim(),
        title: p.title ?? '',
        email: p.email ?? '',
        // Only meaningful next to an address; a page with no email proves nothing.
        emailSourceUrl: p.email ? p.sourceUrl ?? '' : '',
        updatedAt: now,
      });
      added += 1;
      continue;
    }
    const nextTitle = p.title ?? existing.title;
    const nextEmail = p.email ?? existing.email;
    if (nextTitle !== existing.title || nextEmail !== existing.email) {
      existing.title = nextTitle || existing.title;
      // The proof URL moves with the address it proves — never left pointing at the page
      // a previous, different address came from.
      if (nextEmail && nextEmail !== existing.email) existing.emailSourceUrl = p.sourceUrl ?? '';
      existing.email = nextEmail || existing.email;
      existing.updatedAt = now;
      updated += 1;
    }
  }
  return { added, updated };
}

// ---------------------------------------------------------------------------
// Per-site: shortlist -> seeded agent -> organized people
// ---------------------------------------------------------------------------

function seedPrompt(website: string, company: string, ranked: TeamPagesResult): string {
  const lines = [
    `Extract the team members of the organization "${company}" at ${website}.`,
    '',
    'These pages of the site were pre-ranked as the most likely to list team members — extract_people on these FIRST instead of exploring from the homepage:',
    ...ranked.pages.map((p) => `- ${p.url} (${p.kind}, confidence ${p.score})`),
  ];
  if (ranked.profilePages.length) {
    lines.push(
      '',
      `The site also has ${ranked.profilePages.length} individual profile pages under ${ranked.profilePrefixes.join(', ')} — the directory pages above usually cover the same people; only open a few profiles if the directories lack titles/emails.`,
    );
  }
  lines.push('', 'If a pre-ranked page 404s or names nobody, fall back to exploring from the homepage.');
  return lines.join('\n');
}

interface SiteOutcome {
  company: string;
  domain: string;
  website: string;
  people: Person[];
  pagesRanked: number;
  visits: number;
  ms: number;
  error?: string;
}

async function processSite(
  target: { key: string; company: string; original: string },
  clients: ReturnType<typeof clientsFromEnv>,
): Promise<SiteOutcome> {
  const t0 = Date.now();
  const outcome: SiteOutcome = {
    company: target.company,
    domain: target.key,
    website: target.original,
    people: [],
    pagesRanked: 0,
    visits: 0,
    ms: 0,
  };
  try {
    // The shortlist is an accelerator, not a hard dependency: Firecrawl map
    // times out on some sites, and the agent's own playbook can still explore
    // from the homepage. Never fail a site just because ranking failed.
    let ranked: TeamPagesResult | null = cachedRanking(target.key);
    const reused = ranked !== null;
    const failure = reused ? null : rankFailure(target.key);

    // A host that answered nothing in stage 1 will answer nothing here either. Skipping
    // costs one ledger row; not skipping costs a full site timeout of dead fetches, and
    // was 47% of the wall time on a 25-company run.
    if (failure?.siteDown) {
      outcome.error = `site unreachable (${failure.reason.slice(0, 80)})`;
      outcome.ms = Date.now() - t0;
      console.log(`  [${target.key}] skipped — host did not respond in stage 1`);
      return outcome;
    }

    try {
      if (failure) {
        // Mapping already failed once. Re-running it pays the same timeout again for
        // the same answer; go straight to unseeded exploration.
        console.log(
          `  [${target.key}] stage 1 could not map this site (${failure.reason.slice(0, 60)}) — exploring unseeded, not re-mapping`,
        );
      } else {
        ranked ??= await findTeamPages(target.original, { company: target.company, clients });
        outcome.pagesRanked = ranked.pages.length;
        console.log(
          `  [${target.key}] shortlist ${reused ? 'reused from stage 1' : 'ready'} — ` +
            `${ranked.pages.length} pages, ${ranked.profilePages.length} profiles`,
        );
      }
    } catch (err) {
      console.log(
        `  [${target.key}] shortlist unavailable (${err instanceof Error ? err.message.slice(0, 60) : err}) — agent will explore unseeded`,
      );
    }

    const { agent, session } = buildTeamExtractor();
    const prompt = ranked
      ? seedPrompt(target.original, target.company, ranked)
      : `Extract the team members of the organization "${target.company}" at ${target.original}. Start from the homepage and follow its links to the team/about/our-doctors pages.`;
    // An unreachable host can keep the agent retrying for 20+ minutes and hold a
    // concurrency slot. Cap it: whatever was extracted so far still gets kept.
    const result = await Promise.race([
      agent.generate(prompt, { maxSteps: 16 }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SITE_TIMEOUT_MS)),
    ]);
    if (result === null) {
      console.log(`  [${target.key}] agent hit the ${SITE_TIMEOUT_MS / 1000}s cap — keeping ${session.rawPeople.length} raw people`);
    }
    outcome.visits = session.visits;

    const luna = extractionModel();

    // Profile sweep: when the agent's haul is far below the number of known
    // per-person pages (JS-lazy directories, fetch budget), extract the known
    // profile URLs directly — team-pages already enumerated them from the map.
    if (ranked && ranked.profilePages.length > session.rawPeople.length * 1.3) {
      const visited = new Set(
        [...session.pages.keys()].map((u) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '')),
      );
      const toSweep = ranked.profilePages
        .filter((u) => !visited.has(u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '')))
        .slice(0, 150);
      console.log(
        `  [${target.key}] profile sweep — ${toSweep.length} pages (agent got ${session.rawPeople.length} raw vs ${ranked.profilePages.length} known profiles)`,
      );
      const sweep = pLimit(8);
      await Promise.all(
        toSweep.map((url) =>
          sweep(async () => {
            try {
              const page = await fetchPage(url);
              outcome.visits += 1;
              session.rawPeople.push(...(await extractPeopleFromPage(lunaClient(), luna, page)));
            } catch {
              // one bad profile page shouldn't sink the site
            }
          }),
        ),
      );
    }

    outcome.people = await organizePeople(lunaClient(), luna, session.rawPeople);
    outcome.ms = Date.now() - t0;

    fs.writeFileSync(
      path.join(COMPANIES_DIR, `${target.key}.json`),
      JSON.stringify({ agentSummary: result?.text?.trim() ?? '(timed out)', ...outcome }, null, 2) + '\n',
    );
    console.log(
      `✓ ${target.key} — ${outcome.people.length} people · ${outcome.visits} fetch(es) · ${(outcome.ms / 1000).toFixed(0)}s`,
    );
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
    outcome.ms = Date.now() - t0;
    console.error(`✗ ${target.key} — ${outcome.error}`);
  }
  return outcome;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { header, rows } = parseCsv(fs.readFileSync(INPUT_CSV, 'utf8'));
  const siteIdx = requireColumn(header, WEBSITE_COL);
  if (siteIdx < 0) throw new Error(`column "${WEBSITE_COL}" not found in: ${header.join(', ')}`);
  const nameIdx = header.indexOf(NAME_COL);

  const byKey = new Map<string, { key: string; company: string; original: string }>();
  for (const row of rows) {
    const company = (nameIdx >= 0 && row[nameIdx]?.trim()) || row[siteIdx] || '';
    const t = normalizeWebsite(row[siteIdx] ?? '', company);
    if (t && !byKey.has(t.key)) byKey.set(t.key, { key: t.key, company: t.company, original: t.original });
  }
  let targets = [...byKey.values()];
  if (ONLY.length) {
    targets = targets.filter((t) => ONLY.some((f) => t.key.includes(f) || t.company.toLowerCase().includes(f)));
  }
  targets = targets.slice(0, SITE_LIMIT);
  acquireLock();
  const master = loadMaster();
  const doneDomains = new Set([...master.values()].map((r) => r.domain));
  const ledgerDone = loadLedgerDone();
  const pending = FORCE
    ? targets
    : targets.filter((t) => !ledgerDone.has(t.key) && !doneDomains.has(t.key));
  console.log(
    `${targets.length} site(s) — ${targets.length - pending.length} already done, ${pending.length} to extract (concurrency ${CONCURRENCY})`,
  );

  const clients = clientsFromEnv();
  const limit = pLimit(CONCURRENCY);
  let added = 0;
  let updated = 0;
  let completed = 0;
  let failedCount = 0;

  // Stream: each finished site immediately upserts + rewrites the master
  // (atomic) and appends its ledger line — kill/crash at any point loses at
  // most the sites currently in flight, and those retry on the next run.
  const outcomes = await Promise.all(
    pending.map((t) =>
      limit(async () => {
        const o = await processSite(t, clients);
        completed += 1;
        if (!o.error) {
          const delta = upsertPeople(master, o, o.people);
          added += delta.added;
          updated += delta.updated;
          writeMaster(master);
        } else {
          failedCount += 1;
        }
        fs.appendFileSync(
          LEDGER,
          JSON.stringify({
            domain: o.domain,
            company: o.company,
            people: o.people.length,
            visits: o.visits,
            ms: o.ms,
            ...(o.error ? { error: o.error } : {}),
            finishedAt: new Date().toISOString(),
          }) + '\n',
        );
        console.log(
          `  progress ${completed}/${pending.length} · master ${master.size} people (+${added}/~${updated}) · ${failedCount} failed`,
        );
        return o;
      }),
    ),
  );

  const failed = outcomes.filter((o) => o.error);
  console.log(`\nMaster: +${added} new, ~${updated} updated -> ${MASTER_CSV} (${master.size} people total)`);
  if (failed.length) {
    console.log(`${failed.length} site(s) failed (re-run to retry): ${failed.map((f) => f.domain).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
