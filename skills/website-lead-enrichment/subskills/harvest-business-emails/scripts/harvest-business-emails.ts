import fs from 'node:fs';
import pLimit from 'p-limit';
import { csvCell, normalizeWebsite, parseCsv } from '../../../shared/lib/site.js';
import { EmailSources, fetchPage } from '../../../shared/lib/scrape.js';
import { MASTER_CSV, ledgerPath, loadEnv, workPath, writeAtomic } from '../../../shared/lib/paths.js';
import { argVal, requireInput, requireColumn } from '../../../shared/lib/cli.js';

/**
 * Harvest BUSINESS/CONTACT emails per domain (info@, reception@, admin@, …) and
 * merge them into the team master as new columns. This is company-level contact
 * data — not per-person leads — captured for EVERY domain in the source list,
 * including the ~150 that published no team page at all.
 *
 * Per domain: fetch homepage + up to 2 contact pages (Zyte static, with the new
 * Cloudflare data-cfemail decode), collect + classify emails, keep the ones that
 * belong to the business.
 *
 * Resumable: out/business-email-ledger.jsonl (one line/domain; errors retry).
 * Outputs: out/business-emails.csv (per domain) and, with --merge, rewrites the
 * master adding business_email + all_business_emails columns.
 *
 * Usage:
 *   npx tsx scripts/harvest-business-emails.ts [--input file.csv] [--col Website]
 *     [--name-col Name] [--only frag] [--limit N] [--concurrency K] [--force] [--merge]
 */

loadEnv();

const INPUT_CSV = requireInput();
const WEBSITE_COL = argVal('--col') ?? 'Website';
const NAME_COL = argVal('--name-col') ?? 'Name';
const ONLY = (argVal('--only') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const SITE_LIMIT = argVal('--limit') ? Number(argVal('--limit')) : Infinity;
const CONCURRENCY = Number(argVal('--concurrency') ?? 6);
const FORCE = process.argv.includes('--force');
const MERGE_ONLY = process.argv.includes('--merge');

const LEDGER = ledgerPath('business-email-ledger.jsonl');
const BIZ_CSV = workPath('business-emails.csv');

// Third-party vendors / SaaS whose addresses are NOT the clinic's own.
const VENDOR = /@(?:.*\.)?(?:myhealth1st|healthengine|hotdoc|automedsystems|cliniko|marketingsweet|wixpress|sentry|squarespace|godaddy|wordpress|shopify|mailchimp|hubspot|constantcontact|godaddy|example|schema|w3|sentry-next|mhtml|blink)\b/i;
const PLACEHOLDER = /^(?:user|test|name|email|yourname|firstname|your)@|@(?:domain|email|yourdomain|company|website)\.(?:com|net)$/i;
const ROLE = /^(?:info|reception|admin|contact|enquir(?:y|ies)|office|hello|mail|practice|booking(?:s)?|appointment(?:s)?|referral(?:s)?|account(?:s)?|hr|careers?|frontdesk|desk|clinic|rooms|secretary|pa|reception1|welcome|hello|team|support|general)@/i;
const FREEMAIL = /@(?:gmail|outlook|hotmail|yahoo|bigpond|live|icloud|me|optusnet|iinet|internode)\.[a-z.]+$/i;

interface Harvest {
  domain: string;
  company: string;
  website: string;
  businessEmails: string[]; // role/same-domain — the strong business signal
  otherEmails: string[]; // freemail contact addresses that look business-ish
  /** The page the leading business email was found on — proof, shipped beside it. */
  businessEmailSourceUrl?: string;
  pages: number;
  error?: string;
}

/** Keep emails that plausibly belong to THIS business; drop vendors/junk. */
function classify(emails: string[], domainKey: string): { business: string[]; other: string[] } {
  const business = new Set<string>();
  const other = new Set<string>();
  const bare = domainKey.replace(/^www\./, '');
  const root = bare.split('.').slice(-3).join('.'); // tolerate sub.domain.com.au
  for (const e of emails) {
    const lower = e.toLowerCase();
    if (VENDOR.test(lower) || PLACEHOLDER.test(lower)) continue;
    if (/^[0-9a-f]{16,}@/.test(lower)) continue;
    const at = lower.split('@')[1] ?? '';
    const sameDomain = at === bare || at.endsWith(`.${bare}`) || bare.endsWith(at) || at.endsWith(root);
    if (sameDomain) business.add(lower); // any address on the company's own domain
    else if (ROLE.test(lower) && FREEMAIL.test(lower)) other.add(lower); // e.g. clinicname@gmail.com
    else if (FREEMAIL.test(lower) && ROLE.test(lower)) other.add(lower);
  }
  // A role address (info@, reception@) ranks ahead of a personal one on the same domain.
  const sorted = [...business].sort((a, b) => Number(ROLE.test(b)) - Number(ROLE.test(a)));
  return { business: sorted, other: [...other] };
}

/** Fetch homepage + up to 2 contact pages, collect all emails. */
async function harvest(target: { key: string; company: string; original: string }): Promise<Harvest> {
  const out: Harvest = {
    domain: target.key,
    company: target.company,
    website: target.original,
    businessEmails: [],
    otherEmails: [],
    pages: 0,
  };
  try {
    const origin = new URL(target.original);
    const home = `${origin.protocol}//${origin.host}/`;
    const emails = new EmailSources();
    const homePage = await fetchPage(home);
    out.pages += 1;
    emails.add(homePage.emails, home);

    // Find contact-ish links on the homepage; else guess common paths.
    const contactLinks = homePage.links
      .filter((l) => /contact|reach|get-in-touch|enquir/i.test(l.url) || /contact|reach|enquir/i.test(l.text))
      .map((l) => l.url);
    const guesses = ['contact', 'contact-us', 'contactus'].map((p) => `${origin.protocol}//${origin.host}/${p}`);
    const toVisit = [...new Set([...contactLinks, ...guesses])].slice(0, 2);

    for (const url of toVisit) {
      try {
        const page = await fetchPage(url);
        out.pages += 1;
        emails.add(page.emails, url);
      } catch {
        /* contact-page guess may 404 — fine */
      }
    }
    const { business, other } = classify(emails.emails(), target.key);
    out.businessEmails = business;
    out.otherEmails = other;
    out.businessEmailSourceUrl = business[0] ? emails.sourceOf(business[0]) : '';
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

function loadDone(): Set<string> {
  const done = new Set<string>();
  if (FORCE || !fs.existsSync(LEDGER)) return done;
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Harvest;
      if (!r.error) done.add(r.domain);
    } catch {
      /* torn line */
    }
  }
  return done;
}

/** Load harvested emails from the ledger, keyed by domain (last wins). */
function loadHarvest(): Map<string, Harvest> {
  const map = new Map<string, Harvest>();
  if (!fs.existsSync(LEDGER)) return map;
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Harvest;
      if (!r.error) map.set(r.domain, r);
    } catch {
      /* skip */
    }
  }
  return map;
}

function writeBizCsv(map: Map<string, Harvest>): void {
  const lines = ['company,domain,website,business_email,all_business_emails,other_contact_emails'];
  for (const h of [...map.values()].sort((a, b) => a.company.localeCompare(b.company))) {
    lines.push(
      [
        h.company,
        h.domain,
        h.website,
        h.businessEmails[0] ?? '',
        h.businessEmails.join('; '),
        h.otherEmails.join('; '),
      ].map(csvCell).join(','),
    );
  }
  fs.writeFileSync(BIZ_CSV, lines.join('\n') + '\n');
}

/** Add business_email + all_business_emails columns to the person-level master. */
function mergeIntoMaster(map: Map<string, Harvest>): number {
  if (!fs.existsSync(MASTER_CSV)) return 0;
  const { header, rows } = parseCsv(fs.readFileSync(MASTER_CSV, 'utf8'));
  const domIdx = header.indexOf('domain');
  const derived = new Set(['business_email', 'all_business_emails', 'business_email_source_url']);
  const keep = header.filter((h) => !derived.has(h));
  const keepIdx = keep.map((h) => header.indexOf(h));
  const outHeader = [...keep, 'business_email', 'all_business_emails', 'business_email_source_url'];
  const lines = [outHeader.join(',')];
  let filled = 0;
  for (const r of rows) {
    const dom = r[domIdx] ?? '';
    const h = map.get(dom);
    const biz = h?.businessEmails[0] ?? '';
    const all = h?.businessEmails.join('; ') ?? '';
    const src = biz ? h?.businessEmailSourceUrl ?? '' : '';
    if (biz) filled += 1;
    lines.push([...keepIdx.map((i) => r[i] ?? ''), biz, all, src].map(csvCell).join(','));
  }
  writeAtomic(MASTER_CSV, lines.join('\n') + '\n');
  return filled;
}

async function main(): Promise<void> {

  if (MERGE_ONLY) {
    const map = loadHarvest();
    writeBizCsv(map);
    const filled = mergeIntoMaster(map);
    console.log(`merge only: ${map.size} domains harvested, master rows with a business email: ${filled}`);
    return;
  }

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
  if (ONLY.length) targets = targets.filter((t) => ONLY.some((f) => t.key.includes(f) || t.company.toLowerCase().includes(f)));
  targets = targets.slice(0, SITE_LIMIT);

  const done = loadDone();
  const pending = targets.filter((t) => !done.has(t.key));
  console.log(`${targets.length} domain(s) — ${targets.length - pending.length} already harvested, ${pending.length} to go (concurrency ${CONCURRENCY})`);

  const limit = pLimit(CONCURRENCY);
  let completed = 0;
  let withBiz = 0;
  await Promise.all(
    pending.map((t) =>
      limit(async () => {
        const h = await harvest(t);
        fs.appendFileSync(LEDGER, JSON.stringify(h) + '\n');
        completed += 1;
        if (h.businessEmails.length) withBiz += 1;
        if (completed % 25 === 0 || h.businessEmails.length) {
          console.log(
            `  ${completed}/${pending.length} · ${h.domain} -> ${h.businessEmails[0] ?? (h.error ? 'ERR ' + h.error.slice(0, 40) : 'none')}`,
          );
        }
      }),
    ),
  );

  const map = loadHarvest();
  writeBizCsv(map);
  const filled = mergeIntoMaster(map);
  console.log(`\nHarvested ${map.size} domains · ${withBiz} new with a business email this run`);
  console.log(`business-emails.csv written · master rows now carrying a business email: ${filled}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
