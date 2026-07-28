import fs from 'node:fs';
import pLimit from 'p-limit';
import { PLACEHOLDER, ROLE, VENDOR } from '../lib/emails.js';
import { normalizeWebsite, parseCsv, csvCell } from '../lib/site.js';
import { EmailSources, fetchPage } from '../lib/scrape.js';
import { MASTER_CSV, appendLedger, ledgerPath, loadEnv, readMaster, writeAtomic } from '../lib/paths.js';
import { argVal, reportFatal, requireColumn, requireInput } from '../lib/cli.js';
import { brief } from '../lib/redact.js';

/**
 * Third-pass recovery for domains that still have NO email: static re-scrape of
 * homepage + contact pages, then TIER every email found on this business's site:
 *   - OWN  -> business_email : same domain, same-name different-TLD (.com/.com.au),
 *            or a short/variant of the same domain stem. High confidence.
 *   - RELATED -> related_email : any other real contact address on the page —
 *            an affiliated group practice, the hospital they work at, a
 *            business-name freemail. A real lead, just not provably their own.
 *
 * Vendors (booking platforms, web agencies) and placeholders are still dropped.
 * Render added 0% here, so this pass is STATIC — cheap. Separate ledger; --merge
 * fills empty business_email cells and adds a related_email column.
 *
 * Usage: npx tsx scripts/harvest-related.ts --input <csv> [--sample N] [--only frag]
 *          [--concurrency K] [--force] [--merge]
 */

loadEnv();

const INPUT_CSV = requireInput();
const WEBSITE_COL = argVal('--col') ?? 'Website';
const NAME_COL = argVal('--name-col') ?? 'Name';
const SAMPLE = argVal('--sample') ? Number(argVal('--sample')) : Infinity;
const ONLY = (argVal('--only') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Number(argVal('--concurrency') ?? 8);
const FORCE = process.argv.includes('--force');
const MERGE_ONLY = process.argv.includes('--merge');

const STATIC_LEDGER = ledgerPath('business-email-ledger.jsonl');
const REL_LEDGER = ledgerPath('related-email-ledger.jsonl');


interface Rec {
  domain: string;
  company: string;
  website: string;
  ownEmails: string[];
  relatedEmails: string[];
  /** email -> the page it was found on. Optional: ledger lines written before this
   *  existed simply yield blank proof rather than breaking a re-read. */
  sources?: Record<string, string>;
  pages: number;
  error?: string;
}

/** First DNS label of a host, lowercased, www-stripped. */
const stem = (host: string): string => host.replace(/^www\./, '').split('.')[0] ?? '';
/** Two domain stems refer to the same brand (equal, or one is a ≥6-char prefix). */
const sameStem = (a: string, b: string): boolean =>
  a === b || (a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a)));

function tier(emails: string[], domainKey: string): { own: string[]; related: string[] } {
  const own = new Set<string>();
  const related = new Set<string>();
  const bare = domainKey.replace(/^www\./, '');
  const siteStem = stem(bare);
  for (const raw of emails) {
    const e = raw.toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) continue;
    if (VENDOR.test(e) || PLACEHOLDER.test(e) || /^[0-9a-f]{16,}@/.test(e)) continue;
    const at = e.split('@')[1] ?? '';
    const isOwn = at === bare || at.endsWith(`.${bare}`) || sameStem(stem(at), siteStem);
    if (isOwn) own.add(e);
    else related.add(e);
  }
  // role addresses first within each tier
  const bySalience = (arr: Set<string>) => [...arr].sort((a, b) => Number(ROLE.test(b)) - Number(ROLE.test(a)));
  return { own: bySalience(own), related: bySalience(related) };
}

async function harvest(t: { key: string; company: string; original: string }): Promise<Rec> {
  const out: Rec = { domain: t.key, company: t.company, website: t.original, ownEmails: [], relatedEmails: [], pages: 0 };
  try {
    const o = new URL(t.original);
    const emails = new EmailSources();
    const homeUrl = `${o.protocol}//${o.host}/`;
    const home = await fetchPage(homeUrl);
    out.pages += 1;
    emails.add(home.emails, homeUrl);
    const contact = home.links
      .filter((l) => /contact|reach|get-in-touch|enquir/i.test(l.url) || /contact|reach|enquir/i.test(l.text))
      .map((l) => l.url);
    const guesses = ['contact', 'contact-us', 'contactus'].map((p) => `${o.protocol}//${o.host}/${p}`);
    for (const url of [...new Set([...contact, ...guesses])].slice(0, 2)) {
      try {
        const p = await fetchPage(url);
        out.pages += 1;
        emails.add(p.emails, url);
      } catch {
        /* 404 guess */
      }
    }
    const { own, related } = tier(emails.emails(), t.key);
    out.ownEmails = own;
    out.relatedEmails = related;
    out.sources = emails.sourceMap([...own, ...related]);
  } catch (err) {
    out.error = brief(err); // this record is appended to the ledger
  }
  return out;
}

function stillEmptyDomains(): Set<string> {
  const { header: head, rows } = readMaster();
  const pe = head.indexOf('email'), be = head.indexOf('business_email'), di = head.indexOf('domain');
  const hasEmail = new Map<string, boolean>();
  for (const r of rows) {
    const d = r[di];
    if (!hasEmail.has(d)) hasEmail.set(d, false);
    if (r[pe] || r[be]) hasEmail.set(d, true);
  }
  const empty = new Set<string>();
  for (const line of fs.readFileSync(STATIC_LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { domain: string; businessEmails?: string[]; error?: string };
      const has = hasEmail.has(rec.domain) ? hasEmail.get(rec.domain) : (rec.businessEmails?.length ?? 0) > 0;
      if (!has && !rec.error) empty.add(rec.domain);
    } catch {
      /* skip */
    }
  }
  return empty;
}

function loadDone(): Set<string> {
  const done = new Set<string>();
  if (FORCE || !fs.existsSync(REL_LEDGER)) return done;
  for (const line of fs.readFileSync(REL_LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Rec;
      if (!r.error) done.add(r.domain);
    } catch {
      /* skip */
    }
  }
  return done;
}

/** Fill empty business_email with OWN finds; add a related_email column. */
function merge(): { own: number; related: number } {
  const recs = new Map<string, Rec>();
  if (fs.existsSync(REL_LEDGER)) {
    for (const line of fs.readFileSync(REL_LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Rec;
        if (!r.error) recs.set(r.domain, r);
      } catch {
        /* skip */
      }
    }
  }
  const { header, rows } = readMaster();
  const di = header.indexOf('domain');
  const bi = header.indexOf('business_email');
  const ai = header.indexOf('all_business_emails');
  let ri = header.indexOf('related_email');
  const out = [...header];
  if (ri < 0) { out.push('related_email'); ri = out.length - 1; }
  let ownFilled = 0, relFilled = 0;
  const lines = [out.join(',')];
  for (const r of rows) {
    const row = [...r];
    while (row.length < out.length) row.push('');
    const rec = recs.get(row[di] ?? '');
    if (rec) {
      if (rec.ownEmails.length && !(row[bi] ?? '')) {
        row[bi] = rec.ownEmails[0];
        row[ai] = rec.ownEmails.join('; ');
        ownFilled += 1;
      }
      if (rec.relatedEmails.length && !(row[ri] ?? '')) {
        row[ri] = rec.relatedEmails.join('; ');
        relFilled += 1;
      }
    }
    lines.push(out.map((_, i) => csvCell(row[i] ?? '')).join(','));
  }
  writeAtomic(MASTER_CSV, lines.join('\n') + '\n');
  return { own: ownFilled, related: relFilled };
}

async function main(): Promise<void> {
  // --merge means "re-fold the existing ledger into the master, don't re-scrape".
  // The scrape path always merges when it finishes, so the merge call is shared.
  if (!MERGE_ONLY) await scrape();
  const { own, related } = merge();
  console.log(`merged into master: ${own} business_email cells (own) + ${related} related_email cells`);
}

async function scrape(): Promise<void> {
  const empty = stillEmptyDomains();
  const { header, rows } = parseCsv(fs.readFileSync(INPUT_CSV, 'utf8'));
  const siteIdx = requireColumn(header, WEBSITE_COL);
  const nameIdx = header.indexOf(NAME_COL);
  const byKey = new Map<string, { key: string; company: string; original: string }>();
  for (const row of rows) {
    const company = (nameIdx >= 0 && row[nameIdx]?.trim()) || row[siteIdx] || '';
    const t = normalizeWebsite(row[siteIdx] ?? '', company);
    if (t && empty.has(t.key) && !byKey.has(t.key)) byKey.set(t.key, { key: t.key, company: t.company, original: t.original });
  }
  let targets = [...byKey.values()];
  if (ONLY.length) targets = targets.filter((t) => ONLY.some((f) => t.key.includes(f) || t.company.toLowerCase().includes(f)));
  const done = loadDone();
  let pending = targets.filter((t) => !done.has(t.key));
  if (SAMPLE !== Infinity) pending = pending.filter((_, i) => i % Math.max(1, Math.floor(pending.length / SAMPLE)) === 0).slice(0, SAMPLE);
  console.log(`${targets.length} still-empty domains · ${pending.length} to re-scrape (static, concurrency ${CONCURRENCY})`);

  const limit = pLimit(CONCURRENCY);
  let done2 = 0, ownHits = 0, relHits = 0;
  await Promise.all(
    pending.map((t) =>
      limit(async () => {
        const r = await harvest(t);
        appendLedger(REL_LEDGER, r);
        done2 += 1;
        if (r.ownEmails.length) ownHits += 1;
        if (r.relatedEmails.length) relHits += 1;
        if (r.ownEmails.length || r.relatedEmails.length || done2 % 50 === 0) {
          console.log(`  ${done2}/${pending.length} · ${r.domain} -> own:${r.ownEmails[0] ?? '-'} related:${r.relatedEmails[0] ?? '-'}`);
        }
      }),
    ),
  );
  console.log(`\nre-scraped ${pending.length} · ${ownHits} gained an OWN business email, ${relHits} a RELATED email`);
}

main().catch(reportFatal);
