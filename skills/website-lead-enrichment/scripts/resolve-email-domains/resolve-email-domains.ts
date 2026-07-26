import fs from 'node:fs';
import pLimit from 'p-limit';
import { csvCell, normalizeWebsite, parseCsv } from '../lib/site.js';
import { MASTER_CSV, ensureDirs, ledgerPath, workPath } from '../lib/paths.js';
import { argVal, requireInput, requireColumn } from '../lib/cli.js';
import { resolveEmailDomain } from './mxEmailDomain.js';

/**
 * Step: resolve the real EMAIL DOMAIN of every company via MX records (the
 * cost-free mxEmailDomain module). A domain that has MX at a real provider
 * receives mail, so `first.last@domain` is a deliverable pattern — the basis
 * for the next step (personal-email prediction). Dead/parked domains (no MX)
 * are dropped so we never predict undeliverable addresses.
 *
 * Runs over ALL domains in the source list (DNS is free/fast); reports the
 * breakdown and flags which STILL-empty companies are now predictable.
 *
 * Resumable via out/email-domain-cache.jsonl. Output: out/email-domains.csv.
 *
 * Usage: npx tsx scripts/resolve-email-domains.ts [--input file.csv]
 *          [--concurrency K] [--only frag] [--force]
 */



const INPUT_CSV = requireInput();
const WEBSITE_COL = argVal('--col') ?? 'Website';
const NAME_COL = argVal('--name-col') ?? 'Name';
const CONCURRENCY = Number(argVal('--concurrency') ?? 40);
const ONLY = (argVal('--only') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const FORCE = process.argv.includes('--force');

const CACHE = ledgerPath('email-domain-cache.jsonl');
const OUT_CSV = workPath('email-domains.csv');

interface Resolved {
  domain: string;
  company: string;
  website: string;
  emailDomain: string;
  provider: string;
  confidence: string;
  hasMx: boolean;
  mx: string;
}

/** Domains that STILL have no email of any kind (from the master). */
function emailLessDomains(): Set<string> {
  const empty = new Set<string>();
  if (!fs.existsSync(MASTER_CSV)) return empty;
  const { header: head, rows } = parseCsv(fs.readFileSync(MASTER_CSV, 'utf8'));
  const pe = head.indexOf('email'), be = head.indexOf('business_email'), ri = head.indexOf('related_email'), di = head.indexOf('domain');
  const has = new Map<string, boolean>();
  for (const r of rows) {
    const d = r[di];
    if (!has.has(d)) has.set(d, false);
    if (r[pe] || r[be] || (ri >= 0 && r[ri])) has.set(d, true);
  }
  for (const [d, v] of has) if (!v) empty.add(d);
  return empty;
}

function loadCache(): Map<string, Resolved> {
  const m = new Map<string, Resolved>();
  if (FORCE || !fs.existsSync(CACHE)) return m;
  for (const line of fs.readFileSync(CACHE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Resolved & { confidence?: string };
      // re-resolve transient DNS errors on the next run
      if (r.confidence !== 'error') m.set(r.domain, r);
    } catch {
      /* skip */
    }
  }
  return m;
}

async function main(): Promise<void> {
  ensureDirs();
  const { header, rows } = parseCsv(fs.readFileSync(INPUT_CSV, 'utf8'));
  const siteIdx = requireColumn(header, WEBSITE_COL);
  const nameIdx = header.indexOf(NAME_COL);
  const byKey = new Map<string, { key: string; company: string; original: string }>();
  for (const row of rows) {
    const company = (nameIdx >= 0 && row[nameIdx]?.trim()) || row[siteIdx] || '';
    const t = normalizeWebsite(row[siteIdx] ?? '', company);
    if (t && !byKey.has(t.key)) byKey.set(t.key, { key: t.key, company: t.company, original: t.original });
  }
  let targets = [...byKey.values()];
  if (ONLY.length) targets = targets.filter((t) => ONLY.some((f) => t.key.includes(f)));

  const cache = loadCache();
  const pending = targets.filter((t) => !cache.has(t.key));
  console.log(`${targets.length} domains · ${cache.size} cached · ${pending.length} to resolve (concurrency ${CONCURRENCY})`);

  const limit = pLimit(CONCURRENCY);
  let done = 0;
  await Promise.all(
    pending.map((t) =>
      limit(async () => {
        const r = await resolveEmailDomain(t.original || t.key);
        const rec: Resolved = {
          domain: t.key,
          company: t.company,
          website: t.original,
          emailDomain: r.emailDomain ?? '',
          provider: r.provider ?? '',
          confidence: r.confidence,
          hasMx: r.hasMx === true,
          mx: (r.mx ?? []).slice(0, 3).join(' | '),
        };
        fs.appendFileSync(CACHE, JSON.stringify(rec) + '\n');
        cache.set(t.key, rec);
        done += 1;
        if (done % 200 === 0) console.log(`  resolved ${done}/${pending.length}`);
      }),
    ),
  );

  // Write the full email-domain table.
  const all = targets.map((t) => cache.get(t.key)).filter((r): r is Resolved => Boolean(r));
  const lines = ['company,domain,website,email_domain,provider,confidence,has_mx,mx'];
  for (const r of all.sort((a, b) => a.company.localeCompare(b.company))) {
    lines.push([r.company, r.domain, r.website, r.emailDomain, r.provider, r.confidence, String(r.hasMx), r.mx].map(csvCell).join(','));
  }
  fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n');

  // Breakdown + the money question: how many EMAIL-LESS companies are predictable.
  const empty = emailLessDomains();
  const byConf: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  let emptyPredictable = 0, emptyDead = 0;
  for (const r of all) {
    byConf[r.confidence] = (byConf[r.confidence] ?? 0) + 1;
    if (r.confidence === 'high' || r.confidence === 'medium') byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
    if (empty.has(r.domain)) {
      if (r.confidence === 'high' || r.confidence === 'medium') emptyPredictable += 1;
      else emptyDead += 1;
    }
  }
  console.log(`\n=== email-domain resolution (${all.length} companies) ===`);
  console.log('confidence:', JSON.stringify(byConf));
  console.log('\nof the', empty.size, 'companies with NO email so far:');
  console.log('  have a live email domain (predictable):', emptyPredictable);
  console.log('  no MX / dead (cannot predict):', emptyDead);
  console.log('\ntop providers (predictable domains):');
  for (const [p, n] of Object.entries(byProvider).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log('  ' + String(n).padStart(4) + '  ' + p);
  console.log(`\nWrote ${OUT_CSV}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
