import fs from 'node:fs';
import path from 'node:path';
import { buildTeamExtractor, lunaClient, organizePeople } from './agent.js';
import { extractionModel } from '../../../shared/lib/llm.js';
import { readEnv } from '../../../shared/lib/env.js';
import { COMPANIES_DIR, ensureDirs, loadEnv } from '../../../shared/lib/paths.js';

/**
 * Website in -> [{name, title, email}] out.
 *
 * Usage:
 *   npx tsx scripts/run-one.ts https://example.com
 *   npx tsx subskills/extract-team-members/scripts/run-one.ts example.com [--json]   (--json = print ONLY the array)
 *
 * Writes the array to out/.work/companies/<host>.json as well.
 */

// ~/.leadgen/.env is authoritative: it is loaded with override:true, so a stale key
// exported in ~/.zshrc cannot shadow the valid one. See shared/lib/paths.ts.
loadEnv();

const args = process.argv.slice(2).filter((a) => a !== '--json');
const jsonOnly = process.argv.includes('--json');
const input = args[0];
if (!input) {
  console.error('usage: npx tsx subskills/extract-team-members/scripts/run-one.ts <website> [--json]');
  process.exit(1);
}
const website = /^https?:\/\//i.test(input) ? input : `https://${input}`;

async function main(): Promise<void> {
  const t0 = Date.now();
  const { agent, session } = buildTeamExtractor();

  const result = await agent.generate(
    `Extract the team members of the organization at ${website}`,
    { maxSteps: 16 },
  );
  if (readEnv('debug')) {
    for (const [i, step] of (result.steps ?? []).entries()) {
      const calls = (step.toolCalls ?? [])
        .map((c: { payload?: { toolName?: string; args?: unknown } }) =>
          `${c.payload?.toolName}(${JSON.stringify(c.payload?.args ?? {}).slice(0, 120)})`)
        .join(' ');
      console.error(`  step ${i}: ${calls || JSON.stringify((step.text ?? '').slice(0, 100))}`);
    }
    console.error(`  finishReason=${result.finishReason} totalTokens=${JSON.stringify(result.usage ?? {})}`);
  }

  const luna = extractionModel();
  const people = await organizePeople(lunaClient(), luna, session.rawPeople);

  const host = new URL(website).hostname.replace(/^www\./i, '');
  ensureDirs();
  const outFile = path.join(COMPANIES_DIR, `${host}.json`);
  fs.writeFileSync(outFile, JSON.stringify(people, null, 2) + '\n');

  if (jsonOnly) {
    console.log(JSON.stringify(people, null, 2));
    return;
  }
  console.log(`\nagent: ${result.text?.trim() ?? '(no summary)'}`);
  console.log(
    `${people.length} people · ${session.visits} page fetch(es) · ${((Date.now() - t0) / 1000).toFixed(1)}s · saved ${path.relative(process.cwd(), outFile)}\n`,
  );
  console.log(JSON.stringify(people, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
