import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pLimit from 'p-limit';
import { csvCell, normalizeWebsite, parseCsv } from '../lib/site.js';
import { MASTER_CSV, ledgerPath, loadEnv, readMaster, workPath, writeAtomic } from '../lib/paths.js';
import { argVal, die, requireInput } from '../lib/cli.js';
import { resolveCodex } from '../lib/codex.js';
import { readEnv } from '../lib/env.js';

/**
 * Final-stage enrichment: for people with NO scraped email, web-search the open
 * web via Codex (`codex exec`, headless) to surface a REAL, sourced address —
 * hospital / university / personal emails our scrape + prediction can't reach.
 *
 * Guardrails (both mandatory, see web-email-search-prompt.md):
 *  - identity guard: email only counts if specialty+location+employer match this
 *    exact person (kills same-name false positives). identity_match=mismatch => drop.
 *  - budget cap: <=6 searches, then not_found (no context-window spirals).
 *
 * Real, confirmed hits merge as basis `web-found` — above predictions — and (when
 * run BEFORE Phase B) become evidence the pattern-learner reuses.
 *
 * Resumable (out/web-search-ledger.jsonl), rate-limit-aware (backoff, then stop
 * cleanly so a later re-run resumes), and calls codex with OPENAI_API_KEY UNSET so
 * it uses the ChatGPT subscription, not a stray API key.
 *
 * Usage:
 *   npx tsx scripts/enrich-web-search.ts --source-csv <csv> [--limit N] [--only frag]
 *     [--concurrency K] [--source-csv file.csv] [--merge]
 */

loadEnv();

const LIMIT = argVal('--limit') ? Number(argVal('--limit')) : Infinity;
const ONLY = (argVal('--only') ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Number(argVal('--concurrency') ?? 5);
const SOURCE_CSV = requireInput('--source-csv');
const WEBSITE_COL = argVal('--col') ?? 'Website';
const SPECIALTY_COL = argVal('--specialty-col') ?? 'Specialty';
const SUBURB_COL = argVal('--suburb-col') ?? 'Suburb';
const STATE_COL = argVal('--state-col') ?? 'State';
const MERGE_ONLY = process.argv.includes('--merge');
const MODEL = readEnv('codexModel') ?? 'gpt-5.6-sol';

/**
 * Auto-detected: LEADGEN_CODEX_BIN if it actually exists, else PATH, else the usual install
 * locations. A stale pinned path is reported and stepped over rather than trusted.
 *
 * Resolved inside main() rather than at import, so `--merge` — which only folds an
 * existing ledger into the master — still works on a machine without Codex.
 */
function requireCodex(): string {
  const codex = resolveCodex();
  if (codex.warning) console.warn(`warning: ${codex.warning}`);
  if (!codex.bin) {
    die(
      'Codex CLI not found, so open-web discovery cannot run.\n' +
        '  This stage is OPTIONAL — skip it and continue with stage 6; you lose only the\n' +
        '  off-domain sourced addresses. To enable it: install Codex and run `codex login`.',
    );
  }
  return codex.bin;
}
let codexBin = '';
const PER_CALL_TIMEOUT_MS = Number(argVal('--timeout-ms') ?? 240_000);

const LEDGER = ledgerPath('web-search-ledger.jsonl');
const TMP_DIR = workPath('.web-tmp');

interface Ctx { specialty: string; suburb: string; state: string }
interface Hit {
  rowId: number; domain: string; name: string;
  email: string; source_url: string; identity_match: string; confidence: string; notes: string;
  error?: string;
}

/** domain -> {specialty, suburb, state} from the source CSV. */
function loadContext(): Map<string, Ctx> {
  const map = new Map<string, Ctx>();
  if (!fs.existsSync(SOURCE_CSV)) return map;
  const { header, rows } = parseCsv(fs.readFileSync(SOURCE_CSV, 'utf8'));
  const si = header.indexOf(WEBSITE_COL);
  const spi = header.indexOf(SPECIALTY_COL);
  const sub = header.indexOf(SUBURB_COL);
  const st = header.indexOf(STATE_COL);
  // Context drives the identity guard. Silently searching with a blank specialty and
  // location is the failure mode this stage is least able to recover from, so say so
  // rather than quietly degrading every match.
  if (si < 0) {
    die(`--source-csv has no "${WEBSITE_COL}" column. Header: ${header.join(', ')}. Pass --col <name>.`);
  }
  for (const missing of [
    [spi, '--specialty-col', SPECIALTY_COL],
    [sub, '--suburb-col', SUBURB_COL],
    [st, '--state-col', STATE_COL],
  ] as Array<[number, string, string]>) {
    const [idx, flag, label] = missing;
    if (idx < 0) {
      console.warn(
        `warning: no "${label}" column in --source-csv (pass ${flag} <name>). ` +
          'Identity matching will be weaker and more people will come back not_found.',
      );
    }
  }
  for (const r of rows) {
    const t = normalizeWebsite(r[si] ?? '', '');
    if (!t) continue;
    if (!map.has(t.key)) map.set(t.key, { specialty: r[spi] ?? '', suburb: r[sub] ?? '', state: r[st] ?? '' });
  }
  return map;
}

/** The guarded + bounded prompt (mirrors web-email-search-prompt.md). */
function buildPrompt(p: { name: string; title: string; company: string; website: string; ctx: Ctx }): string {
  const loc = [p.ctx.suburb, p.ctx.state, 'Australia'].filter(Boolean).join(', ');
  return [
    'WEB RESEARCH (not coding). Find a real, publicly-published email for THIS SPECIFIC person via web search.',
    '',
    'PERSON (the ONLY person whose email counts):',
    `- Name:      ${p.name}`,
    `- Specialty: ${p.title || p.ctx.specialty || 'clinician'}`,
    `- Employer:  ${p.company}`,
    `- Location:  ${loc}`,
    `- Website:   ${p.website}`,
    '',
    'IDENTITY CHECK (before accepting any email — the most important rule): this name may be common.',
    'An email only counts if the source page is about a person whose SPECIALTY and LOCATION and EMPLOYER',
    'match the block above. A same-named person in a different city/country, specialty, or institution is a',
    'DIFFERENT PERSON — discard that email. If unsure it is THIS person, do not report it as confirmed.',
    '',
    'BUDGET: at most 6 web searches, open at most 8 pages, then STOP. Check: (1) the clinic/practice contact',
    'page, (2) 1-2 hospital staff pages or medical directories, (3) one publication/university profile if academic.',
    'If no identity-matched email surfaces within budget, return not_found — do NOT keep searching.',
    '',
    'RULES: only report an email you literally SAW on a real page (give the source URL). Never guess or pattern-generate.',
    '',
    'Return STRICT JSON only:',
    `{"email":"<or empty>","source_url":"<or empty>","identity_match":"confirmed|uncertain|mismatch","confidence":"high|medium|low|not_found","notes":"<one line>"}`,
    'Rule: identity_match=mismatch => email empty and confidence=not_found; identity_match=uncertain => at most low.',
  ].join('\n');
}

class RateLimit extends Error {}

/** Spawn codex exec with stdin CLOSED (stdio 'ignore') — otherwise codex waits on
 *  stdin ("Reading additional input from stdin...") and never uses the prompt arg. */
function runCodex(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('codex timeout')); }, PER_CALL_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }); });
  });
}

/** One Codex web search. Returns parsed hit fields or throws RateLimit / Error. */
async function codexSearch(rowId: number, prompt: string): Promise<Omit<Hit, 'rowId' | 'domain' | 'name'>> {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outFile = path.join(TMP_DIR, `${rowId}.json`);
  const env = { ...process.env };
  delete env.OPENAI_API_KEY; // force the ChatGPT subscription, not the stale key
  const { stdout, stderr } = await runCodex(
    ['exec', '-m', MODEL, '--skip-git-repo-check', '-o', outFile, prompt],
    env,
  );
  // Rate-limit detection reads Codex's OWN error channel only. It used to scan stdout
  // too, which carries the model's answer and quoted page text — so a source page that
  // merely contained the word "quota" or "429" aborted the entire batch.
  if (/usage limit|rate limit|rate_limit|\b429\b|too many requests|limit reached|quota exceeded/i.test(stderr)) {
    throw new RateLimit(stderr.trim().slice(-200));
  }

  // The -o file holds ONLY the model's final message — parse it directly. Fall
  // back to extracting a flat {...} (no nested braces) from file/stdout if needed.
  const fileRaw = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
  let j: Record<string, string>;
  try {
    j = JSON.parse(fileRaw);
  } catch {
    const src = fileRaw || stdout;
    const m = src.match(/\{[^{}]*"identity_match"[^{}]*\}/);
    if (!m) throw new Error(`no JSON | stderr: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 140)}`);
    j = JSON.parse(m[0]);
  }
  try { fs.unlinkSync(outFile); } catch { /* best effort cleanup */ }
  return {
    email: (j.email || '').trim().toLowerCase(),
    source_url: (j.source_url || '').trim(),
    identity_match: j.identity_match || 'uncertain',
    confidence: j.confidence || 'low',
    notes: j.notes || '',
  };
}

function loadDone(): Set<number> {
  const done = new Set<number>();
  if (!fs.existsSync(LEDGER)) return done;
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as Hit; if (!r.error) done.add(r.rowId); } catch { /* skip */ }
  }
  return done;
}

/** A found email is usable only if identity-confirmed, real, and sourced. */
const usable = (h: Hit): boolean =>
  !!h.email && /@/.test(h.email) && !!h.source_url && h.identity_match === 'confirmed' && h.confidence !== 'not_found';

/** Merge web-found emails into the master: new web_found_* cols + upgrade best_email. */
function merge(): { added: number } {
  const found = new Map<number, Hit>();
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line) as Hit; if (usable(r)) found.set(r.rowId, r); } catch { /* skip */ }
    }
  }
  const { header, rows } = readMaster();
  const newCols = ['web_found_email', 'web_found_source', 'web_found_confidence'];
  const keep = header.filter((h) => !newCols.includes(h));
  // best_email/_basis only exist once permutation has run. Create them if absent —
  // writing to index -1 silently discarded the value while still counting it as added.
  for (const c of ['best_email', 'best_email_basis']) if (!keep.includes(c)) keep.push(c);
  const out = [...keep, ...newCols];
  const bi = keep.indexOf('best_email'), bb = keep.indexOf('best_email_basis'), pe = keep.indexOf('email');
  const keepIdx = keep.map((h) => header.indexOf(h)); // hoisted out of the per-row map
  const lines = [out.join(',')];
  let added = 0;
  rows.forEach((r, i) => {
    const row = keepIdx.map((j) => (j >= 0 ? (r[j] ?? '') : ''));
    const h = found.get(i);
    let wf = '', ws = '', wc = '';
    if (h) {
      wf = h.email; ws = h.source_url; wc = h.confidence;
      // web-found is a REAL email: it outranks any prediction (but not a scraped personal email).
      const scraped = pe >= 0 ? (row[pe] || '').trim() : '';
      if (!scraped) { row[bi] = h.email; row[bb] = `web-found:${h.confidence}`; added++; }
    }
    lines.push([...row, wf, ws, wc].map(csvCell).join(','));
  });
  writeAtomic(MASTER_CSV, lines.join('\n') + '\n');
  return { added };
}

// Stop before the weekly Codex limit is hit; resume next window from the ledger.
const STOP_AT = Number(argVal('--stop-at-percent') ?? 90);

/** Current weekly rate-limit % via the Codex app-server (same read as codex-usage-check.mjs). */
function weeklyUsedPercent(): Promise<number | null> {
  return new Promise((resolve) => {
    const env = { ...process.env }; delete env.OPENAI_API_KEY;
    const child = spawn(codexBin, ['app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', done = false;
    const finish = (v: number | null) => { if (done) return; done = true; try { child.kill('SIGKILL'); } catch { /* */ } resolve(v); };
    const timer = setTimeout(() => finish(null), 20_000);
    const send = (m: object): boolean => child.stdin.write(JSON.stringify(m) + '\n');
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { rateLimits?: { primary?: { usedPercent?: number } } } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 0) { send({ method: 'initialized', params: {} }); send({ method: 'account/rateLimits/read', id: 1, params: null }); }
        if (msg.id === 1) { clearTimeout(timer); const p = msg.result?.rateLimits?.primary; finish(typeof p?.usedPercent === 'number' ? p.usedPercent : null); }
      }
    });
    child.on('error', () => finish(null));
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'enrich-throttle', version: '0.1' } } });
  });
}

async function main(): Promise<void> {
  if (MERGE_ONLY) { const { added } = merge(); console.log(`merge: ${added} best_email upgraded to web-found`); return; }
  codexBin = requireCodex();

  const ctxMap = loadContext();
  const { header, rows } = readMaster();
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  const di = ix.domain, ni = ix.name, ti = ix.title, co = ix.company, we = ix.website, pe = ix.email;

  // Target: people with NO scraped email + a findable (2-token) name. Order by
  // findability (has title/specialty), so the high-value personals come first.
  const done = loadDone();
  const targets: Array<{ rowId: number; domain: string; name: string; title: string; company: string; website: string; ctx: Ctx; score: number }> = [];
  rows.forEach((r, i) => {
    if ((r[pe] || '').trim()) return;           // already has a real scraped email
    if (done.has(i)) return;                     // already searched
    const name = (r[ni] || '').trim();
    if (name.split(/\s+/).length < 2) return;    // single-token name — not searchable
    const dom = r[di] || '';
    const ctx = ctxMap.get(dom) || { specialty: '', suburb: '', state: '' };
    if (ONLY.length && !ONLY.some((f) => dom.includes(f) || name.toLowerCase().includes(f))) return;
    const title = r[ti] || '';
    const score = (title ? 2 : 0) + (ctx.specialty ? 1 : 0) + (/dr|prof|surgeon|specialist|director|founder|consultant/i.test(title) ? 2 : 0);
    targets.push({ rowId: i, domain: dom, name, title, company: r[co] || '', website: r[we] || '', ctx, score });
  });
  targets.sort((a, b) => b.score - a.score);

  // How many to search is the user's decision, never a default. Every other stage may
  // safely default to "all" — time is the only thing they spend. This is the one whose
  // budget cannot be bought back, so an unbounded run is refused rather than sized for
  // them. Reporting the count here is the point: it is the number they need to choose.
  if (LIMIT === Infinity) {
    die(
      `--limit is required. ${targets.length} ${targets.length === 1 ? 'person has' : 'people have'} ` +
      'no email published on their own site.\n' +
      '  Decide how many of them to search and pass --limit N. They are ranked by\n' +
      '  findability, so titled staff come first and a small N is not a random sample.\n' +
      "  A search's share of the weekly quota depends on your ChatGPT plan and is not\n" +
      '  published, so start small and re-check codex-usage-check.ts before going bigger.',
    );
  }
  const batch = targets.slice(0, LIMIT);
  console.log(`${targets.length} people without a scraped email · running ${batch.length} this pass (concurrency ${CONCURRENCY}, model ${MODEL})`);

  // Gate on the weekly limit before spending anything. Fail CLOSED: how much of the weekly
  // quota one search costs differs per plan tier and is not published, so a run we cannot
  // meter is a run against an unknown rate. Stopping costs a rerun; guessing costs the week.
  const startPct = await weeklyUsedPercent();
  if (startPct === null) {
    die(
      'cannot read Codex weekly usage — refusing to run unmetered.\n' +
      "  A search's share of the weekly limit depends on your ChatGPT plan and is not\n" +
      '  published, so running without the meter risks exhausting the window in one pass.\n' +
      '  Check Codex is working:  npx tsx scripts/discover-web-emails/codex-usage-check.ts',
    );
  }
  console.log(`Codex weekly usage: ${startPct}% (throttle stops at ${STOP_AT}%)`);
  if (startPct >= STOP_AT) { console.error(`already ≥ ${STOP_AT}% this window — nothing to run, resume after the weekly reset.`); return; }

  const limit = pLimit(CONCURRENCY);
  let done2 = 0, hits = 0, stopped = false, lastUsageAt = 0;
  await Promise.all(
    batch.map((t) =>
      limit(async () => {
        if (stopped) return;
        try {
          const res = await codexSearch(t.rowId, buildPrompt(t));
          const h: Hit = { rowId: t.rowId, domain: t.domain, name: t.name, ...res };
          fs.appendFileSync(LEDGER, JSON.stringify(h) + '\n');
          done2++;
          if (usable(h)) { hits++; console.log(`  ✓ ${t.name} -> ${h.email} [${h.confidence}] ${h.source_url}`); }
          else if (done2 % 20 === 0) console.log(`  ${done2}/${batch.length} · ${t.name} -> ${h.identity_match}/${h.confidence}`);
          // Periodic throttle check (guard reentry via lastUsageAt) — stop before the cap.
          if (!stopped && done2 - lastUsageAt >= 40) {
            lastUsageAt = done2;
            const u = await weeklyUsedPercent();
            // Losing the meter mid-run fails closed too — the rest is ledgered, so a resume
            // costs nothing, while continuing blind could burn the remaining week.
            if (u === null) { stopped = true; console.error(`\n⏸ lost the Codex usage meter at ${done2} done, ${hits} found — stopping rather than running unmetered. Re-run to resume.`); }
            else if (u >= STOP_AT) { stopped = true; console.error(`\n⏸ weekly usage ${u}% ≥ ${STOP_AT}% — stopping cleanly at ${done2} done, ${hits} found. Resume after reset.`); }
          }
        } catch (err) {
          if (err instanceof RateLimit) {
            if (!stopped) { stopped = true; console.error(`\n⏸ RATE LIMIT reached — stopping cleanly. ${done2} done this pass, ${hits} found. Re-run later to resume.\n   signal: ${err.message}`); }
            return;
          }
          fs.appendFileSync(LEDGER, JSON.stringify({ rowId: t.rowId, domain: t.domain, name: t.name, error: err instanceof Error ? err.message.slice(0, 120) : String(err) }) + '\n');
          done2++;
        }
      }),
    ),
  );

  const { added } = merge();
  console.log(`\nweb-search pass: ${done2} searched · ${hits} usable emails found · master best_email upgraded on ${added} rows${stopped ? ' (stopped on rate limit — resume later)' : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
