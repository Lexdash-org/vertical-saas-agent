import fs from 'node:fs';
import pLimit from 'p-limit';
import { FREEMAIL, PLACEHOLDER, ROLE, VENDOR } from '../lib/emails.js';
import { normalizeWebsite, parseCsv, csvCell } from '../lib/site.js';
import { fetchPage } from '../lib/scrape.js';
import { MASTER_CSV, appendLedger, ledgerPath, loadEnv, readMaster, writeAtomic } from '../lib/paths.js';
import { argVal, reportFatal, requireColumn, requireInput } from '../lib/cli.js';
import { brief } from '../lib/redact.js';

/**
 * Second-pass email recovery: for domains that STILL have no email after the
 * static harvest, re-fetch homepage + contact pages with Zyte browserHtml
 * (forceRender) so JS-injected addresses (SPA contact widgets, some Cloudflare
 * setups) surface. Static-first already handled the easy cases; this is the
 * expensive lane, run ONLY on the still-empty, still-reachable domains.
 *
 * Separate ledger (out/render-email-ledger.jsonl) so the good static harvest is
 * never clobbered. --merge folds any newly-found business emails into the
 * master (only filling empty cells) + business-emails.csv.
 *
 * Usage:
 *   npx tsx scripts/harvest-render.ts [--input file.csv] [--sample N]
 *     [--only frag] [--concurrency K] [--force] [--merge]
 */

loadEnv();

const INPUT_CSV = requireInput();
const WEBSITE_COL = argVal('--col') ?? 'Website';
const NAME_COL = argVal('--name-col') ?? 'Name';
const SAMPLE = argVal('--sample') ? Number(argVal('--sample')) : Infinity;
const ONLY = (argVal('--only') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Number(argVal('--concurrency') ?? 6);
const FORCE = process.argv.includes('--force');
const MERGE_ONLY = process.argv.includes('--merge');

const STATIC_LEDGER = ledgerPath('business-email-ledger.jsonl');
const RENDER_LEDGER = ledgerPath('render-email-ledger.jsonl');


interface Harvest {
  domain: string;
  company: string;
  website: string;
  businessEmails: string[];
  otherEmails: string[];
  pages: number;
  rendered: true;
  error?: string;
}

function classify(emails: string[], domainKey: string): { business: string[]; other: string[] } {
  const business = new Set<string>();
  const other = new Set<string>();
  const bare = domainKey.replace(/^www\./, '');
  const root = bare.split('.').slice(-3).join('.');
  for (const e of emails) {
    const lower = e.toLowerCase();
    if (VENDOR.test(lower) || PLACEHOLDER.test(lower) || /^[0-9a-f]{16,}@/.test(lower)) continue;
    const at = lower.split('@')[1] ?? '';
    if (at === bare || at.endsWith(`.${bare}`) || bare.endsWith(at) || at.endsWith(root)) business.add(lower);
    else if (ROLE.test(lower) && FREEMAIL.test(lower)) other.add(lower);
  }
  return { business: [...business].sort((a, b) => Number(ROLE.test(b)) - Number(ROLE.test(a))), other: [...other] };
}

/** Domains that still have NO email at all (from master + static ledger). */
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
      const rec = JSON.parse(line) as Harvest & { error?: string };
      const has = hasEmail.has(rec.domain) ? hasEmail.get(rec.domain) : rec.businessEmails?.length > 0;
      if (!has && !rec.error) empty.add(rec.domain); // reachable + empty; dead domains excluded
    } catch {
      /* skip */
    }
  }
  return empty;
}

async function harvest(target: { key: string; company: string; original: string }): Promise<Harvest> {
  const out: Harvest = { domain: target.key, company: target.company, website: target.original, businessEmails: [], otherEmails: [], pages: 0, rendered: true };
  try {
    const origin = new URL(target.original);
    const home = `${origin.protocol}//${origin.host}/`;
    const emails = new Set<string>();
    const homePage = await fetchPage(home, { forceRender: true });
    out.pages += 1;
    homePage.emails.forEach((e) => emails.add(e));
    const contactLinks = homePage.links
      .filter((l) => /contact|reach|get-in-touch|enquir/i.test(l.url) || /contact|reach|enquir/i.test(l.text))
      .map((l) => l.url);
    const guesses = ['contact', 'contact-us', 'contactus'].map((p) => `${origin.protocol}//${origin.host}/${p}`);
    for (const url of [...new Set([...contactLinks, ...guesses])].slice(0, 2)) {
      try {
        const page = await fetchPage(url, { forceRender: true });
        out.pages += 1;
        page.emails.forEach((e) => emails.add(e));
      } catch {
        /* 404 guess — fine */
      }
    }
    const { business, other } = classify([...emails], target.key);
    out.businessEmails = business;
    out.otherEmails = other;
  } catch (err) {
    out.error = brief(err); // this record is appended to the ledger
  }
  return out;
}

function loadDone(): Set<string> {
  const done = new Set<string>();
  if (FORCE || !fs.existsSync(RENDER_LEDGER)) return done;
  for (const line of fs.readFileSync(RENDER_LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Harvest;
      if (!r.error) done.add(r.domain);
    } catch {
      /* skip */
    }
  }
  return done;
}

/** Fold render-found business emails into the master, filling ONLY empty cells. */
function merge(): { filled: number; domains: number } {
  const found = new Map<string, Harvest>();
  if (fs.existsSync(RENDER_LEDGER)) {
    for (const line of fs.readFileSync(RENDER_LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Harvest;
        if (!r.error && r.businessEmails.length) found.set(r.domain, r);
      } catch {
        /* skip */
      }
    }
  }
  const { header, rows } = readMaster();
  const di = header.indexOf('domain');
  const bi = header.indexOf('business_email');
  const ai = header.indexOf('all_business_emails');
  let filled = 0;
  const lines = [header.join(',')];
  for (const r of rows) {
    const dom = r[di] ?? '';
    const h = found.get(dom);
    if (h && !(r[bi] ?? '')) {
      r[bi] = h.businessEmails[0];
      r[ai] = h.businessEmails.join('; ');
      filled += 1;
    }
    lines.push(header.map((_, i) => csvCell(r[i] ?? '')).join(','));
  }
  writeAtomic(MASTER_CSV, lines.join('\n') + '\n');
  return { filled, domains: found.size };
}

async function main(): Promise<void> {
  // --merge means "re-fold the existing ledger into the master, don't re-render".
  // The render path always merges when it finishes, so the merge call is shared.
  if (!MERGE_ONLY) await render();
  const { filled, domains } = merge();
  console.log(`merged into master: ${filled} business_email cells across ${domains} domains`);
}

async function render(): Promise<void> {
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
  console.log(`${targets.length} still-empty reachable domains · ${pending.length} to render this run (concurrency ${CONCURRENCY})`);

  const limit = pLimit(CONCURRENCY);
  let done2 = 0, recovered = 0;
  await Promise.all(
    pending.map((t) =>
      limit(async () => {
        const h = await harvest(t);
        appendLedger(RENDER_LEDGER, h);
        done2 += 1;
        if (h.businessEmails.length) recovered += 1;
        if (h.businessEmails.length || done2 % 25 === 0) {
          console.log(`  ${done2}/${pending.length} · ${h.domain} -> ${h.businessEmails[0] ?? (h.error ? 'ERR ' + h.error.slice(0, 36) : 'still none')}`);
        }
      }),
    ),
  );
  console.log(`\nrendered ${pending.length} domains · recovered a business email on ${recovered} (${(recovered / pending.length * 100).toFixed(0)}% lift)`);
}

main().catch(reportFatal);
