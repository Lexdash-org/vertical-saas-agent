import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { csvCell, parseCsv } from '../../../shared/lib/site.js';
import { buildEmail, firstLast, nameTokens } from '../../../shared/lib/patterns.js';
import { OUT_DIR, loadEnv, MASTER_CSV } from '../../../shared/lib/paths.js';

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
 * Also leaves the skill's full outputs: out/permute-wide.csv (email_1..email_18)
 * and out/permute-long.csv (source of truth).
 *
 * Usage: npx tsx scripts/apply-permutation.ts
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv();

const DOMAIN_CACHE = path.join(OUT_DIR, 'email-domain-cache.jsonl');
const PATTERNS_JSON = path.join(OUT_DIR, 'company-email-patterns.json');
const PERMUTE_PY = path.join(HERE, 'permute.py');
const VERIFIED_CSV = path.join(OUT_DIR, 'verified-real.csv');
const PREDICTED_CSV = path.join(OUT_DIR, 'predicted-unverified.csv');
const INBOX_CSV = path.join(OUT_DIR, 'company-inboxes.csv');
const IN_CSV = path.join(OUT_DIR, 'permute-input.csv');
const WIDE_CSV = path.join(OUT_DIR, 'permute-wide.csv');
const LONG_CSV = path.join(OUT_DIR, 'permute-long.csv');
const MAX = 18;
const EMBED = 10; // how many candidates to embed in the master

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
  const learned: Record<string, { pattern: string; confidence: string }> = fs.existsSync(PATTERNS_JSON)
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
    // permute.py is called with both name columns pointing at the one `name` field, so
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

  // Run the skill's script.
  execFileSync(
    'python3',
    [PERMUTE_PY, '--in', IN_CSV, '--out-wide', WIDE_CSV, '--out-long', LONG_CSV,
      '--first-col', 'name', '--last-col', 'name',
      '--company-domain-col', 'company_domain', '--email-domain-col', 'email_domain', '--max', String(MAX)],
    { stdio: 'inherit' },
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
  const isReal = (basis: string): boolean => basis === 'known' || basis.startsWith('web-found:');
  const realRows: string[] = [outHeader.join(',')];
  const predictedRows: string[] = [outHeader.join(',')];
  // Published company inboxes, one row per domain — collected in this same pass.
  const bizCol = header.indexOf('business_email');
  const allBizCol = header.indexOf('all_business_emails');
  const relCol = header.indexOf('related_email');
  const compCol = header.indexOf('company');
  const siteCol = header.indexOf('website');
  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] || '').trim() : '');
  const inboxes = new Map<string, string[]>();

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
    if (best.trim()) (isReal(basis) ? realRows : predictedRows).push(line);

    // A company inbox belongs to the business, not to this person, so it cannot go in
    // verified-real.csv without implying otherwise — but without its own file it would
    // be invisible to anyone using the split, and for small businesses it is most of
    // the usable contacts. "Any email is a lead."
    const biz = cell(r, bizCol);
    const rel = cell(r, relCol);
    if (dom && !inboxes.has(dom) && (biz || rel)) {
      inboxes.set(dom, [cell(r, compCol), dom, cell(r, siteCol), biz, cell(r, allBizCol), rel]);
    }
  });

  const tmp = `${MASTER_CSV}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  fs.renameSync(tmp, MASTER_CSV);
  fs.writeFileSync(VERIFIED_CSV, realRows.join('\n') + '\n');
  fs.writeFileSync(PREDICTED_CSV, predictedRows.join('\n') + '\n');

  const inboxLines = ['company,domain,website,business_email,all_business_emails,related_email'];
  for (const row of inboxes.values()) inboxLines.push(row.map(csvCell).join(','));
  fs.writeFileSync(INBOX_CSV, inboxLines.join('\n') + '\n');

  console.log('\n=== best_email basis ===');
  console.log('known (real email):            ', known);
  console.log('web-found (sourced open web):  ', webN);
  console.log('learned company pattern:       ', learnedN, '(high confidence)');
  console.log('single-token name (first@):    ', mononym);
  console.log('default (confirmed: biz-email or MX):', defConfirmed);
  console.log('default first.last (unverified):', defUnverified, '(website domain, no MX)');
  console.log('no mail domain (dead/absent):  ', noDomain, '(no guess emitted — would bounce)');
  console.log('unusable name:                 ', noName);
  console.log(`\n=== files ===`);
  console.log(`${path.basename(MASTER_CSV)}          everyone, every column (${lines.length - 1} rows)`);
  console.log(`${path.basename(VERIFIED_CSV)}         ${realRows.length - 1} REAL addresses — safe to send`);
  console.log(`${path.basename(PREDICTED_CSV)}  ${predictedRows.length - 1} PREDICTIONS — verify before sending`);
  console.log(`${path.basename(INBOX_CSV)}       ${inboxes.size} companies with a published inbox — real, safe to send`);
  console.log('\nThe predicted file is guesses, not verified addresses. Sending it without');
  console.log('running it through an email verification service first will generate bounces');
  console.log('and damage your sending domain.');
  console.log(`\npredicted for ${needsPredict} people · learned patterns cover ${Object.keys(learned).length} companies`);
  console.log(`master columns: ${outHeader.slice(-5).join(', ')}`);
}

main();
