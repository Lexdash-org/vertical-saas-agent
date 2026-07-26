import fs from 'node:fs';
import path from 'node:path';
import { permuteCsv } from './permute.js';
import { csvCell, parseCsv } from '../../../shared/lib/site.js';
import { basisToStatus } from '../../../shared/lib/basis.js';
import { buildEmail, displayName, firstLast, nameTokens } from '../../../shared/lib/patterns.js';
import {
  INBOX_CSV, MASTER_CSV, README_TXT, READY_CSV, SUMMARY_JSON, VERIFY_CSV,
  ledgerPath, loadEnv, workPath, writeAtomic,
} from '../../../shared/lib/paths.js';

/**
 * Run the email-permutation skill over everyone lacking a real personal email,
 * then merge the ranked candidates into the master — with each company's LEARNED
 * format (from learn-email-patterns.ts) promoted to the top pick.
 *
 * Columns written to the master (replacing the old single-guess ones):
 *   email_domain, mx_provider  (kept)
 *   best_email        - real email | learned-pattern email | permutation rank-1
 *   best_email_basis  - known | web-found:<conf> | learned:<pattern> | default:first.last
 *                       | no-domain | no-name
 *   email_candidates  - top-10 ranked guesses (learned pattern first), ';'-joined
 *
 * Also leaves the generator's full outputs in out/.work/: permute-wide.csv
 * (email_1..email_18) and permute-long.csv (source of truth).
 *
 * Usage: npx tsx scripts/apply-permutation.ts
 */

loadEnv();

const DOMAIN_CACHE = ledgerPath('email-domain-cache.jsonl');
const PATTERNS_JSON = workPath('company-email-patterns.json');
const BIZ_LEDGER = ledgerPath('business-email-ledger.jsonl');
const REL_LEDGER = ledgerPath('related-email-ledger.jsonl');
const IN_CSV = workPath('permute-input.csv');
const WIDE_CSV = workPath('permute-wide.csv');
const LONG_CSV = workPath('permute-long.csv');
const MAX = 18;
const EMBED = 10; // how many candidates to embed in the master

/**
 * The send-facing schema, identical for both person files so one saved column mapping in
 * a sequencer works for either, and so the two can be concatenated.
 *
 * `email` is the recommendation. It is deliberately NOT the master's `email` column —
 * that one holds only scraped addresses and is empty for most people, so anyone mapping
 * a column called "email" from the old files shipped an empty campaign.
 */
const PERSON_HEADER = [
  'first_name', 'last_name', 'email', 'title', 'company', 'domain', 'website',
  'status', 'source', 'proof',
  'business_email', 'all_business_emails', 'all_predicted_emails',
];

const INBOX_HEADER = [
  'company', 'domain', 'website', 'email', 'all_business_emails', 'related_email',
  'source', 'proof',
];

/**
 * Written into out/ on every run. Deliberately holds no counts — a stale number in a
 * file nobody regenerates is worse than no number. Counts live in run-summary.json.
 */
const README = `WHAT IS IN THIS FOLDER
======================

ready-to-send.csv
  Real email addresses. Someone published each one - either on the company's own
  website, or somewhere else on the web that we recorded. Safe to send.

company-inboxes.csv
  Real addresses too, but they belong to the business rather than to a named person
  (info@, reception@, and similar). Safe to send. On a list of small businesses this
  is usually the biggest file - most of them publish a front desk address and no
  personal ones.

verify-before-sending.csv
  PREDICTIONS. Nobody has confirmed these addresses exist or belong to anyone. They
  were assembled from a person's name and their employer's mail domain.

  Run this file through an email verification service before you send to it.
  Sending unverified guesses generates bounces and damages your sending domain.

THE COLUMNS THAT MATTER
=======================

  email    the address to send to. This is the one to map in your sequencer.
  status   "Ready to send" or "Needs verification".
  source   plain English: where this address came from.
  proof    a link, or the published address a format was copied from.
           Blank means there is nothing to show you - always blank for a
           prediction, and that is the honest answer rather than a missing value.

A confirmed mail domain means the domain accepts mail. It does NOT mean the specific
mailbox exists. Nothing here checks deliverability.

.work/ holds the pipeline's own state so a run can resume. You never need to open it.
`;

interface Inbox {
  company: string;
  domain: string;
  website: string;
  business: string[];
  related: string[];
  sources: Record<string, string>;
}

const readJsonl = <T,>(file: string): T[] => {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* torn line from an interrupted append */
    }
  }
  return out;
};

/**
 * Company inboxes, built from the stage 3 and 4 LEDGERS rather than from master rows.
 *
 * This is the whole point: the master only ever gets a row when a PERSON is found, so a
 * clinic that publishes `info@` and names no staff has no master row at all. Building
 * this file from master rows silently dropped every such company — on a 1,097-company
 * run, 955 domains reached the master and the rest vanished, taking their published
 * inboxes with them. On a small-business list those are most of the usable contacts.
 *
 * Later ledger lines win, matching the append-only last-write-wins rule everywhere else.
 */
function buildInboxes(): Map<string, Inbox> {
  const byDomain = new Map<string, Inbox>();
  const slot = (domain: string, company: string, website: string): Inbox => {
    const found = byDomain.get(domain);
    if (found) {
      found.company ||= company;
      found.website ||= website;
      return found;
    }
    const made: Inbox = { company, domain, website, business: [], related: [], sources: {} };
    byDomain.set(domain, made);
    return made;
  };

  type BizRec = {
    domain: string; company: string; website: string;
    businessEmails?: string[]; businessEmailSourceUrl?: string; error?: string;
  };
  for (const rec of readJsonl<BizRec>(BIZ_LEDGER)) {
    if (rec.error || !rec.domain || !rec.businessEmails?.length) continue;
    const inbox = slot(rec.domain, rec.company ?? '', rec.website ?? '');
    inbox.business = rec.businessEmails;
    if (rec.businessEmailSourceUrl) inbox.sources[rec.businessEmails[0]] = rec.businessEmailSourceUrl;
  }

  type RelRec = {
    domain: string; company: string; website: string;
    ownEmails?: string[]; relatedEmails?: string[]; sources?: Record<string, string>; error?: string;
  };
  for (const rec of readJsonl<RelRec>(REL_LEDGER)) {
    if (rec.error || !rec.domain) continue;
    const own = rec.ownEmails ?? [];
    const related = rec.relatedEmails ?? [];
    if (!own.length && !related.length) continue;
    const inbox = slot(rec.domain, rec.company ?? '', rec.website ?? '');
    // Stage 4 only runs for companies stage 3 left empty, so this adds rather than replaces.
    for (const e of own) if (!inbox.business.includes(e)) inbox.business.push(e);
    inbox.related = related;
    Object.assign(inbox.sources, rec.sources ?? {});
  }

  return byDomain;
}

function main(): void {
  // MX email domain + provider per company
  const emailDomain = new Map<string, string>();
  const provider = new Map<string, string>();
  // Domains DNS proved cannot receive mail. Guessing an address at one of these is
  // a guaranteed bounce, so they are excluded from prediction entirely rather than
  // being emitted with an (unverified-domain) label.
  const deadDomains = new Set<string>();
  if (fs.existsSync(DOMAIN_CACHE)) {
    for (const line of fs.readFileSync(DOMAIN_CACHE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.confidence === 'high' || r.confidence === 'medium') {
          if (r.emailDomain) emailDomain.set(r.domain, r.emailDomain);
          provider.set(r.domain, r.provider ?? '');
        } else if (r.confidence === 'none' || r.confidence === 'invalid') {
          deadDomains.add(r.domain);
        }
      } catch { /* skip */ }
    }
  }
  /** The domain we would send to, or '' when there is nothing worth guessing against. */
  const winningDomain = (confirmed: string, dom: string): string => {
    if (confirmed) return confirmed; // proven to receive mail
    if (!dom || deadDomains.has(dom)) return ''; // no domain, or DNS says it takes no mail
    return dom; // website domain — a guess, flagged (unverified-domain) downstream
  };
  // `source` is the real published address the pattern was derived from — stage 7's own
  // proof, which becomes this stage's `proof` column for every learned prediction.
  const learned: Record<string, { pattern: string; confidence: string; source?: string }> = fs.existsSync(PATTERNS_JSON)
    ? JSON.parse(fs.readFileSync(PATTERNS_JSON, 'utf8'))
    : {};

  const { header, rows } = parseCsv(fs.readFileSync(MASTER_CSV, 'utf8'));
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  const di = ix.domain, ni = ix.name, pe = ix.email, be = ix.business_email;
  // Sourced open-web emails (stage 5). Real addresses, so they outrank every prediction.
  // Reading them here is what stops this stage from erasing web-found results when it
  // runs after the discovery stage, as the documented pipeline order requires.
  const wfe = ix.web_found_email, wfc = ix.web_found_confidence;
  const webFound = (r: string[]): string =>
    wfe === undefined ? '' : (r[wfe] || '').trim();

  /** Domain of the company's business email (info@…) — a CONFIRMED mail domain
   *  since a real address demonstrably lives there. Beats MX-on-website and the
   *  raw website domain, and is correct when mail runs on a different TLD. */
  const bizMailDomain = (r: string[]): string => {
    const first = (r[be] || '').split(/[;,]/)[0].trim().toLowerCase();
    const at = first.split('@')[1];
    return at ? at.trim() : '';
  };
  /** The best confirmed mail domain we have: a real business-email domain, else MX. */
  const confirmedDomain = (r: string[]): string => bizMailDomain(r) || emailDomain.get(r[di] || '') || '';

  // Build permute input for every person WITHOUT a real personal email. Domain
  // priority: business-email domain > MX email_domain > website domain. The first
  // two are confirmed to receive mail; the website domain is the last-resort guess
  // (marked unverified in the basis). Verification is the downstream filter.
  const inLines = ['row_id,name,company_domain,email_domain'];
  let needsPredict = 0;
  rows.forEach((r, i) => {
    if ((r[pe] || '').trim()) return; // already has a real scraped email
    if (webFound(r)) return; // already has a real sourced email — no need to guess
    // Single-token names ("Cher") are handled separately below, not permuted here.
    // permute.ts is called with both name columns pointing at the one `name` field, so
    // a lone token would satisfy its "first and last are present" check and produce
    // cher.cher@domain — a fabricated surname labelled default:first.last.
    if (!firstLast(r[ni] || '')) return;
    const dom = r[di] || '';
    const confirmed = confirmedDomain(r);
    if (!winningDomain(confirmed, dom)) return; // no domain, or DNS says it takes no mail
    // email_domain = confirmed mail domain (wins in permute); company_domain = website fallback.
    inLines.push([String(i), r[ni] || '', dom, confirmed].map(csvCell).join(','));
    needsPredict += 1;
  });
  fs.writeFileSync(IN_CSV, inLines.join('\n') + '\n');

  // Run the generator in-process. Both name columns point at the single `name` field —
  // permuteCsv takes the first token as `first` and the last as `last`.
  const summary = permuteCsv({
    input: IN_CSV,
    outWide: WIDE_CSV,
    outLong: LONG_CSV,
    firstCol: 'name',
    lastCol: 'name',
    companyDomainCol: 'company_domain',
    emailDomainCol: 'email_domain',
    max: MAX,
  });
  console.error(
    `permute: ${summary.rowsIn} rows in, ${summary.candidatesOut} candidates out ` +
    `(skipped ${summary.skippedDomain} no-domain, ${summary.skippedName} no-name)`,
  );

  // Read wide output: row_id -> [candidate emails]
  const wide = parseCsv(fs.readFileSync(WIDE_CSV, 'utf8'));
  const wIx = Object.fromEntries(wide.header.map((h, i) => [h, i]));
  const candById = new Map<string, string[]>();
  for (const wr of wide.rows) {
    const id = wr[wIx.row_id];
    const cands: string[] = [];
    for (let i = 1; i <= MAX; i++) { const e = wr[wIx[`email_${i}`]]; if (e) cands.push(e); }
    candById.set(id, cands);
  }

  // Rebuild master with the new columns.
  const drop = new Set(['predicted_email', 'prediction_basis', 'best_email', 'best_email_basis', 'email_candidates']);
  const keep = header.filter((h) => !drop.has(h) && h !== 'email_domain' && h !== 'mx_provider');
  const outHeader = [...keep, 'email_domain', 'mx_provider', 'best_email', 'best_email_basis', 'email_candidates'];
  const lines = [outHeader.join(',')];
  let known = 0, webN = 0, learnedN = 0, defConfirmed = 0, defUnverified = 0, noDomain = 0, noName = 0, mononym = 0;

  // Hoisted: header.indexOf() per column per row was an O(header) scan 250k times.
  const keepIdx = keep.map((h) => header.indexOf(h));
  // Split by trustworthiness as each row is built. `known`/`web-found` are addresses
  // that demonstrably exist; learned:/default: are guesses that have never been checked.
  const readyRows: string[] = [PERSON_HEADER.join(',')];
  const verifyRows: string[] = [PERSON_HEADER.join(',')];
  const bizCol = header.indexOf('business_email');
  const allBizCol = header.indexOf('all_business_emails');
  const compCol = header.indexOf('company');
  const siteCol = header.indexOf('website');
  const titleCol = header.indexOf('title');
  const emailSrcCol = header.indexOf('email_source_url');
  const wfsCol = header.indexOf('web_found_source');
  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] || '').trim() : '');
  const inboxes = buildInboxes();
  let withProof = 0;

  /**
   * The evidence a buyer can check. Only ever a real artefact — a page that carries the
   * address, or the published address a format was learned from. A prediction has none,
   * and saying so is the honest answer.
   */
  const proofFor = (r: string[], basis: string, dom: string): string => {
    if (basis === 'known') return cell(r, emailSrcCol);
    if (basis.startsWith('web-found:')) return cell(r, wfsCol);
    if (basis.startsWith('learned:')) return learned[dom]?.source ?? '';
    return '';
  };

  /** Project a master row into the send-facing schema. */
  const personRow = (r: string[], dom: string, best: string, basis: string, cands: string[]): string => {
    const { status, source } = basisToStatus(basis);
    const { first, last } = displayName(r[ni] || '');
    const proof = proofFor(r, basis, dom);
    return [
      first, last, best, cell(r, titleCol), cell(r, compCol), dom, cell(r, siteCol),
      status, source, proof,
      cell(r, bizCol), cell(r, allBizCol), cands.slice(0, EMBED).join('; '),
    ].map(csvCell).join(',');
  };

  rows.forEach((r, i) => {
    const base = keepIdx.map((j) => (j >= 0 ? r[j] ?? '' : ''));
    const dom = r[di] || '';
    const confirmed = confirmedDomain(r); // business-email domain, else MX — receives mail
    const prov = provider.get(dom) || '';
    const winDomain = winningDomain(confirmed, dom); // '' when dead or absent
    const real = (r[pe] || '').trim();
    const sourced = webFound(r);
    let best = '', basis = '', candidates: string[] = [];

    if (real) {
      best = real; basis = 'known'; known++;
    } else if (sourced) {
      // A real address someone published elsewhere. Preserve it and its basis rather
      // than overwriting with a guess.
      best = sourced;
      const conf = wfc === undefined ? '' : (r[wfc] || '').trim();
      basis = `web-found:${conf || 'low'}`;
      webN++;
    } else if (!winDomain) {
      basis = 'no-domain'; noDomain++;
    } else if (!firstLast(r[ni] || '')) {
      // Single-token name ("Cher"). Treat the lone token as the given name and use the
      // `first` pattern, rather than inventing a surname. The basis names the pattern
      // actually used, so it stays true.
      const tok = nameTokens(r[ni] || '')[0];
      if (tok) {
        best = `${tok}@${winDomain}`;
        basis = `default:first${confirmed ? '' : '(unverified-domain)'}`;
        candidates = [best];
        mononym++;
      } else {
        basis = 'no-name'; noName++;
      }
    } else {
      candidates = candById.get(String(i)) ?? [];
      const lp = learned[dom];
      if (lp) {
        const learnedEmail = buildEmail(lp.pattern, r[ni] || '', winDomain);
        if (learnedEmail) {
          best = learnedEmail;
          basis = `learned:${lp.pattern}${lp.confidence === 'ai' ? '(ai)' : ''}${confirmed ? '' : '(unverified-domain)'}`;
          learnedN++;
          candidates = [learnedEmail, ...candidates.filter((c) => c !== learnedEmail)];
        }
      }
      if (!best && candidates.length) {
        best = candidates[0];
        // Confirmed = domain proven to receive mail (business email or MX); else a website-domain guess.
        if (confirmed) { basis = 'default:first.last'; defConfirmed++; }
        else { basis = 'default:first.last(unverified-domain)'; defUnverified++; }
      }
      if (!best) { basis = 'no-name'; noName++; } // domain present but name is a single token
    }
    // email_domain column shows the CONFIRMED mail domain we used (empty when only the website domain was available).
    const line = [...base, confirmed, prov, best, basis, candidates.slice(0, EMBED).join('; ')]
      .map(csvCell)
      .join(',');
    lines.push(line);

    // Route while `best` and `basis` are still in hand. This used to re-parse every
    // serialized row to recover two values it had right here.
    if (best.trim()) {
      const { sendable } = basisToStatus(basis);
      (sendable ? readyRows : verifyRows).push(personRow(r, dom, best, basis, candidates));
      // Counted only for real addresses: a learned prediction also carries evidence, but
      // "N of the addresses you can send carry a checkable link" is the claim being made.
      if (sendable && proofFor(r, basis, dom)) withProof += 1;
    }
  });

  writeAtomic(MASTER_CSV, lines.join('\n') + '\n');
  writeAtomic(READY_CSV, readyRows.join('\n') + '\n');
  writeAtomic(VERIFY_CSV, verifyRows.join('\n') + '\n');

  const inboxLines = [INBOX_HEADER.join(',')];
  for (const inbox of inboxes.values()) {
    // One column to upload, like the person files: the company's own address when it has
    // one, otherwise the affiliated one.
    const email = inbox.business[0] ?? inbox.related[0] ?? '';
    if (!email) continue;
    const onOwnDomain = Boolean(inbox.business[0]);
    inboxLines.push([
      inbox.company, inbox.domain, inbox.website, email,
      inbox.business.join('; '), inbox.related[0] ?? '',
      onOwnDomain ? 'Published on their website' : 'Published on an affiliated domain',
      inbox.sources[email] ?? '',
    ].map(csvCell).join(','));
  }
  writeAtomic(INBOX_CSV, inboxLines.join('\n') + '\n');

  const readyCount = readyRows.length - 1;
  const verifyCount = verifyRows.length - 1;
  const inboxCount = inboxLines.length - 1;

  writeAtomic(README_TXT, README);
  writeAtomic(SUMMARY_JSON, JSON.stringify({
    schema: 1,
    generatedAt: new Date().toISOString(),
    files: {
      'ready-to-send.csv': readyCount,
      'verify-before-sending.csv': verifyCount,
      'company-inboxes.csv': inboxCount,
    },
    people: {
      total: lines.length - 1,
      readyToSend: readyCount,
      needsVerification: verifyCount,
      noAddress: noDomain + noName,
    },
    readyToSend: { known, webFound: webN, withProof },
    needsVerification: {
      learnedPattern: learnedN,
      singleTokenName: mononym,
      confirmedDomain: defConfirmed,
      unverifiedDomain: defUnverified,
    },
    noAddress: { noMailDomain: noDomain, unusableName: noName },
    companies: {
      withInbox: inboxCount,
      withLearnedPattern: Object.keys(learned).length,
    },
    warning:
      'verify-before-sending.csv holds predictions, not verified addresses. Run them ' +
      'through an email verification service before sending or you will generate ' +
      'bounces and damage your sending domain.',
  }, null, 2) + '\n');

  const name = (p: string): string => path.basename(p);
  console.log('\n=== what you can send ===');
  console.log(`${name(READY_CSV)}              ${readyCount} real addresses (${known} published, ${webN} sourced) — ${withProof} carry a link you can check`);
  console.log(`${name(INBOX_CSV)}            ${inboxCount} company inboxes — real, but they reach the business not a person`);
  console.log('\n=== what needs checking first ===');
  console.log(`${name(VERIFY_CSV)}    ${verifyCount} predictions — ${learnedN} from a company's own format, ${defConfirmed + defUnverified + mononym} from a standard pattern`);
  console.log(`\nNo address for ${noDomain + noName} people (${noDomain} had no mail domain, ${noName} an unusable name).`);
  console.log('\nThe predictions are guesses, not verified addresses. Sending them without');
  console.log('running them through an email verification service first will generate bounces');
  console.log('and damage your sending domain.');
  // Relative only when it is actually shorter — LEADGEN_OUT_DIR often points elsewhere,
  // where a relative path is a wall of "../".
  const rel = path.relative(process.cwd(), SUMMARY_JSON);
  console.log(`\nFull counts: ${rel.startsWith('..') ? SUMMARY_JSON : rel}`);
}

main();
