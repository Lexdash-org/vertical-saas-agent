import fs from 'node:fs';
import pLimit from 'p-limit';
import { parseCsv } from '../../../shared/lib/site.js';
import { llmClient, reasoningModel } from '../../../shared/lib/llm.js';
import { firstLast, buildEmail, isValidTemplate, PATTERNS } from '../../../shared/lib/patterns.js';
import { MASTER_CSV, ledgerPath, loadEnv, workPath } from '../../../shared/lib/paths.js';
import { argVal } from '../../../shared/lib/cli.js';

/**
 * Learn each company's email FORMAT from the real emails we already have on that
 * company's domain, so the permutation step can pin the right pattern to rank 1
 * instead of guessing first.last for everyone.
 *
 * Deterministic first: match each known same-domain email's local-part against
 * the 18 canonical patterns for each person on that domain. Where that fails
 * (nicknames, initials, compound surnames, off-table formats), an Azure GPT
 * (gpt-5.6-sol) judges the pattern from (people names + the real email).
 *
 * Output: out/company-email-patterns.json  { domain: { pattern, confidence,
 * source, evidence[] } }.  --no-ai skips the GPT pass.
 *
 * Usage: npx tsx scripts/learn-email-patterns.ts [--no-ai] [--concurrency K]
 */

loadEnv();

const NO_AI = process.argv.includes('--no-ai');
const CONCURRENCY = Number(argVal('--concurrency') ?? 8);

const DOMAIN_CACHE = ledgerPath('email-domain-cache.jsonl');
const OUT_JSON = workPath('company-email-patterns.json');

const ROLE =/^(info|reception|admin|contact|enquir|office|hello|mail|practice|booking|appointment|referral|account|hr|careers?|frontdesk|desk|clinic|rooms|secretary|welcome|team|support|general|no-?reply|feedback|sales|marketing|patients?|appts|webmaster|manager|education|doctor|nurse)/i;

interface LearnedPattern { pattern: string; confidence: 'deterministic' | 'ai'; source: string; evidence: string[] }

async function main(): Promise<void> {
  // email domain per company (MX)
  const emailDomain = new Map<string, string>();
  if (fs.existsSync(DOMAIN_CACHE)) {
    for (const line of fs.readFileSync(DOMAIN_CACHE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.emailDomain) emailDomain.set(r.domain, r.emailDomain); } catch { /* skip */ }
    }
  }

  const { header, rows } = parseCsv(fs.readFileSync(MASTER_CSV, 'utf8'));
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  const di = ix.domain, ni = ix.name, pe = ix.email, be = ix.business_email, abe = ix.all_business_emails, ri = ix.related_email;
  // Sourced open-web emails are real name->address pairs too. Off-domain ones are
  // dropped by the same-domain evidence filter below; same-domain ones sharpen the
  // learned pattern, which is the whole point of re-running this stage after discovery.
  const wfe = ix.web_found_email;

  // Per domain: people names + known same-domain emails (evidence).
  interface Dom { names: string[]; emails: Set<string> }
  const byDom = new Map<string, Dom>();
  for (const r of rows) {
    const d = r[di];
    if (!byDom.has(d)) byDom.set(d, { names: [], emails: new Set() });
    const g = byDom.get(d)!;
    if (r[ni]) g.names.push(r[ni]);
    for (const cell of [r[pe], r[be], r[abe], ri >= 0 ? r[ri] : '', wfe >= 0 ? r[wfe] : '']) {
      for (const e of (cell || '').split(/[;,]/).map((s) => s.trim().toLowerCase()).filter(Boolean)) g.emails.add(e);
    }
  }

  const learned = new Map<string, LearnedPattern>();
  const aiQueue: Array<{ domain: string; names: string[]; emails: string[] }> = [];

  for (const [dom, g] of byDom) {
    const bare = dom.replace(/^www\./, '');
    const edom = (emailDomain.get(dom) || bare).toLowerCase();
    // Everything published on this company's own/mail domain.
    const onOwnDomain = [...g.emails].filter((e) => {
      const at = e.split('@')[1];
      return !!at && (at === edom || at === bare || at.split('.')[0] === bare.split('.')[0]);
    });
    // Deterministic matching only makes sense on addresses built from a person's name, so
    // pure role inboxes stay out of it. The model, by contrast, gets everything: a house
    // style like {last}.admin@ is only visible if you show it the admin addresses.
    const evidence = onOwnDomain.filter((e) => !ROLE.test(e.split('@')[0]));
    if (!onOwnDomain.length) continue;

    // deterministic: which pattern produces each evidence local-part for some person?
    const votes = new Map<string, number>();
    const matchedEvidence: string[] = [];
    for (const email of evidence) {
      const local = email.split('@')[0];
      let hit = false;
      for (const nm of g.names) {
        const fl = firstLast(nm);
        if (!fl || !fl.first || !fl.last) continue;
        for (const [pname, build] of PATTERNS) {
          if (build(fl.first, fl.last) === local) { votes.set(pname, (votes.get(pname) ?? 0) + 1); hit = true; }
        }
      }
      if (hit) matchedEvidence.push(email);
    }
    if (votes.size) {
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      learned.set(dom, { pattern: best, confidence: 'deterministic', source: matchedEvidence[0] ?? evidence[0], evidence: matchedEvidence });
    } else if (!NO_AI) {
      // Send every same-domain address, not just the non-role subset — the role-looking
      // ones are frequently where the house style is legible.
      aiQueue.push({ domain: dom, names: g.names.slice(0, 25), emails: onOwnDomain.slice(0, 12) });
    }
  }

  // --- AI pass: judge the format for domains with evidence but no det. match ---
  let aiResolved = 0;
  const rejected: string[] = [];
  if (aiQueue.length && !NO_AI) {
    // Chat client only — this stage never scrapes, so it must not demand LEADGEN_FIRECRAWL_API_KEY.
    const openai = llmClient();
    const model = reasoningModel();
    const limit = pLimit(CONCURRENCY);
    // Derived from the canonical table, not retyped — a hand-written list here was the
    // third copy of the 18 patterns and the one most likely to drift unnoticed.
    const allowed = [...PATTERNS.keys()].join(', ');
    const sys = `You infer a company's email LOCAL-PART format from its real published addresses and its staff names.

Return strict JSON: {"pattern":"<canonical name OR template OR 'unknown'>"}.

Two kinds of answer are accepted.

1. A canonical pattern name, when the format is one of these:
${allowed}
   ("filast" = first-initial then surname, etc. Dot or nothing as the separator.)

2. A TEMPLATE, when the company's real addresses show a house style the names above cannot
   express. Use the placeholders {first} {last} {fi} {li} plus any literal text:
     {last}.admin     for kondogiannis.admin@, li.admin@, stoney.admin@
     {first}_{last}   for anna_eastman@, allan_lim@      (underscore separator)
     dr{last}         for drlennox@, drsharma@
     {fi}{last}.admin for kgrellman.admin@

RULES
- Your answer must REPRODUCE the example addresses. Mentally substitute a staff member's
  name into your pattern and check it yields one of the examples exactly. If it does not,
  the pattern is wrong.
- Prefer a canonical name when one fits; only use a template when none does.
- One or two examples that disagree with the majority are exceptions, not the format.
- Generic inboxes with no name in them (info@, reception@, accounts@) tell you nothing
  about the staff format — ignore them when inferring, they are context only.
- If the addresses are nicknames, unrelated to the names, or you cannot reproduce them,
  answer "unknown". A wrong pattern is worse than none: it is applied to every colleague.

Only output JSON.`;
    await Promise.all(
      aiQueue.map((q) =>
        limit(async () => {
          const user = `Staff names: ${q.names.join(', ')}\nExample company emails: ${q.emails.join(', ')}\nWhat is the local-part format pattern?`;
          try {
            const res = await openai.chat.completions.create({
              model,
              response_format: { type: 'json_object' },
              messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
            });
            const raw = res.choices[0]?.message?.content ?? '{}';
            const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')) as { pattern?: string };
            const p = (parsed.pattern ?? '').trim();
            if (!p || p === 'unknown') return;
            if (!PATTERNS.has(p) && !isValidTemplate(p)) return; // unparseable answer

            // The model must REPRODUCE an observed address, not merely sound plausible.
            // Without this a confident-but-wrong template is applied to every colleague
            // at the company and labelled as learned.
            const proof = q.emails.find((known) =>
              q.names.some((nm) => buildEmail(p, nm, known.split('@')[1]) === known),
            );
            if (!proof) {
              rejected.push(`${q.domain}: "${p}" reproduced none of its own addresses`);
              return;
            }
            learned.set(q.domain, { pattern: p, confidence: 'ai', source: proof, evidence: q.emails });
            aiResolved += 1;
          } catch {
            /* leave unlearned */
          }
        }),
      ),
    );
  }

  // Merge over what was learned before instead of replacing it. This file used to be
  // rewritten wholesale, so a re-run with --no-ai silently deleted every pattern the
  // model had previously worked out. Now a run can only add or refresh; --no-ai is safe.
  let prior: Record<string, LearnedPattern> = {};
  if (fs.existsSync(OUT_JSON)) {
    try { prior = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8')); } catch { prior = {}; }
  }
  const kept = Object.keys(prior).filter((d) => !learned.has(d)).length;
  const obj = { ...prior, ...Object.fromEntries(learned) };
  fs.writeFileSync(OUT_JSON, JSON.stringify(obj, null, 2) + '\n');

  const byPat: Record<string, number> = {};
  let det = 0, ai = 0;
  for (const v of learned.values()) { byPat[v.pattern] = (byPat[v.pattern] ?? 0) + 1; if (v.confidence === 'deterministic') det++; else ai++; }
  console.log('=== learned company email patterns ===');
  console.log(`companies with same-domain email evidence -> pattern learned: ${learned.size}`);
  console.log(`  deterministic: ${det} · AI-judged: ${ai} (of ${aiQueue.length} sent to AI)`);
  console.log('\npattern distribution:');
  for (const [p, n] of Object.entries(byPat).sort((a, b) => b[1] - a[1])) console.log('  ' + String(n).padStart(4) + '  ' + p);
  console.log('\nsample learned:');
  for (const [d, v] of [...learned.entries()].slice(0, 12)) console.log(`  ${d.padEnd(30)} ${v.pattern.padEnd(12)} [${v.confidence}] e.g. ${v.source}`);
  if (rejected.length) {
    console.log(`\nrejected ${rejected.length} model answer(s) that could not reproduce the company's own addresses:`);
    for (const r of rejected.slice(0, 8)) console.log(`  ${r}`);
  }
  if (kept) console.log(`\nkept ${kept} pattern(s) learned on earlier runs (not re-derived this run)`);
  console.log(`\nWrote ${OUT_JSON} — ${Object.keys(obj).length} companies total`);
}

main().catch((e) => { console.error(e); process.exit(1); });
