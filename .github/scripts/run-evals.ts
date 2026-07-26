#!/usr/bin/env node
/**
 * Run the trigger cases in `evals/trigger-cases.json` against the published skill
 * descriptions, and fail when routing degrades.
 *
 *     npx tsx .github/scripts/run-evals.ts [--max-near-miss 40] [--min-positive 10] [--verbose]
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * An agent picks a skill by reading its `description` and nothing else. This scores each
 * case's request against every published description with a deterministic term-overlap
 * ranker, then asserts two things:
 *
 *   positives  (`expect: "<skill>"`) — that skill shows real signal
 *   near-misses (`expect: null`)     — NO skill looks confident enough to fire
 *
 * It therefore catches the two failure modes that actually bite: a description missing the
 * words users really say, and one so broad it swallows requests it should decline. It does
 * NOT simulate a real model's judgement — it is a lower bound on description quality, kept
 * deterministic so it runs in CI with no credentials and no network.
 *
 * Runs against the two skills that exist. Stages are reference documents, not skills,
 * so they are not discoverable and never compete for routing.
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const VERBOSE = process.argv.includes('--verbose');
/**
 * Two bars, because the two assertions test different things and a single number cannot
 * serve both — measured, positives span 10-83% and near-misses 0-33%, which overlap.
 *
 * The CEILING is the valuable one: it caught a near-miss scoring 86% against a description
 * whose own refusal clause was those exact words.
 *
 * The FLOOR is deliberately generous. A symptom-style request ("throws an error about
 * package.json") shares almost no vocabulary with any sensible description — a real model
 * resolves it, a term ranker cannot. The floor exists to catch a description that loses its
 * trigger words entirely, not to grade phrasing.
 */
const MAX_NEAR_MISS = Number(arg('--max-near-miss') ?? 40);
const MIN_POSITIVE = Number(arg('--min-positive') ?? 10);

/** Words carrying no routing signal. Kept small — over-filtering hides real mismatches. */
const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'for', 'to', 'in', 'on', 'at', 'by',
  'with', 'from', 'into', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'we', 'you', 'my', 'our', 'your', 'me', 'us', 'them',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'have', 'has', 'had',
  'so', 'than', 'then', 'there', 'here', 'just', 'get', 'got', 'need', 'want', 'please',
  'run', 'use', 'using', 'when', 'what', 'which', 'who', 'how', 'some', 'any', 'all',
]);

/** Lowercase alphanumeric terms, stopwords and 1-char tokens dropped. */
const terms = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

/**
 * How strongly a description invites this request, -100..100.
 *
 * A description has two halves and they pull in OPPOSITE directions. Everything before
 * "NOT for:" is an invitation; everything after is a refusal. Scoring the whole string as
 * one bag of words made a request that matches the refusal look like a perfect match — the
 * first version of this file rated "check whether these addresses deliver" at 86% against
 * a description whose refusal clause is exactly those words.
 *
 * So: coverage of the invitation, minus coverage of the refusal.
 */
function score(request: string, description: string): number {
  const cut = description.search(/\bNOT for\b/i);
  const invite = cut < 0 ? description : description.slice(0, cut);
  const refuse = cut < 0 ? '' : description.slice(cut);

  const want = [...new Set(terms(request))];
  if (!want.length) return 0;
  const stem = (t: string): string => t.slice(0, 5); // "emails"/"email", "clinics"/"clinic"
  const covered = (text: string): number => {
    const have = new Set(terms(text).map(stem));
    return want.filter((t) => have.has(stem(t))).length / want.length;
  };
  return Math.round((covered(invite) - covered(refuse)) * 100);
}

interface Case {
  id: string;
  request: string;
  expect: string | null;
  why: string;
}

const skills = fs
  .readdirSync('skills', { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const raw = fs.readFileSync(path.join('skills', e.name, 'SKILL.md'), 'utf8');
    const fm = raw.slice(0, raw.indexOf('\n---\n', 3));
    const m = /^description:\s*(.*?)^(?=[a-z_]+:)/ms.exec(fm.replace(/^---\n/, ''));
    return { name: e.name, description: (m?.[1] ?? '').replace('>-', '').replace(/\s+/g, ' ').trim() };
  });

const { cases } = JSON.parse(fs.readFileSync('evals/trigger-cases.json', 'utf8')) as { cases: Case[] };

let passed = 0;
const failures: string[] = [];

for (const c of cases) {
  const ranked = skills
    .map((s) => ({ name: s.name, score: score(c.request, s.description) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];

  let ok: boolean;
  let detail: string;
  if (c.expect === null) {
    // Near-miss: nothing may look confident enough to fire. Strict — a skill that fires on
    // work it cannot do is worse than one that stays quiet, because it spends real money.
    ok = top.score < MAX_NEAR_MISS;
    detail = `top ${top.name} ${top.score}% (ceiling ${MAX_NEAR_MISS}%)`;
  } else {
    // Positive: the named skill must clear the bar. Rank 1 is reported but NOT required —
    // the two published skills deliberately overlap, and find-team-emails triages then
    // hands over, so either firing is correct behaviour.
    const mine = ranked.find((r) => r.name === c.expect);
    ok = (mine?.score ?? -100) >= MIN_POSITIVE;
    detail = `${c.expect} ${mine?.score ?? 0}%${top.name === c.expect ? ' (rank 1)' : ` — rank 1 was ${top.name} ${top.score}%`}`;
  }

  if (ok) {
    passed += 1;
    if (VERBOSE) console.log(`  ok   ${c.id} — ${detail}`);
  } else {
    failures.push(`${c.id}: ${detail}\n       request: "${c.request.slice(0, 90)}"\n       why: ${c.why}`);
  }
}

console.log(
  `\n${passed}/${cases.length} trigger cases pass ` +
    `(near-miss ceiling ${MAX_NEAR_MISS}%, positive floor ${MIN_POSITIVE}%)`,
);
if (failures.length) {
  console.error('\nFAILED:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nA positive that ranks low means the description is missing words users actually say.\n' +
      'A near-miss that scores high means the description is too broad and will fire on\n' +
      'requests it should decline.',
  );
  process.exit(1);
}
console.log('routing holds');
