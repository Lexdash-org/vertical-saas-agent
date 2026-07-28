import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { resolveCodex, describeCodex } from '../lib/codex.js';
import { brief } from '../lib/redact.js';

/**
 * Report the Codex weekly rate-limit and usage figures the stage-5 throttle depends on.
 *
 * Doubles as the preflight check for Codex: it uses the SAME resolver as the runner, so
 * it can never report a binary that enrich-web-search then fails to spawn.
 *
 * Usage: npx tsx scripts/codex-usage-check.ts
 */

const codex = resolveCodex();
if (codex.warning) console.error(`warning: ${codex.warning}`);

if (!codex.bin) {
  // Not an error: Codex is optional and stage 5 is skippable.
  console.log(JSON.stringify({ codex: null, status: 'not-installed', stage5: 'skipped' }, null, 2));
  console.error(describeCodex(codex));
  process.exit(0);
}

console.error(describeCodex(codex));

// Same environment surgery as the runner: with OPENAI_API_KEY set, Codex authenticates as
// an API user instead of using the ChatGPT subscription — so this would report the rate
// limits of an account the actual run never touches. This was the one Codex spawn that
// inherited the variable, and it is the one preflight calls.
const codexEnv = { ...process.env };
delete codexEnv.OPENAI_API_KEY;

const proc = spawn(codex.bin, ['app-server', '--stdio'], {
  env: codexEnv,
  stdio: ['pipe', 'pipe', 'inherit'],
});
const lines = readline.createInterface({ input: proc.stdout });
const replies = new Map<number, { error?: unknown; result?: unknown }>();

function send(message: unknown): void {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

lines.on('line', (line) => {
  let message: { id?: number; error?: unknown; result?: unknown };
  try {
    message = JSON.parse(line);
  } catch {
    return; // app-server also emits non-JSON chatter
  }

  if (message.id === 0) {
    send({ method: 'initialized', params: {} });
    send({ method: 'account/rateLimits/read', id: 1, params: null });
    send({ method: 'account/usage/read', id: 2, params: null });
    return;
  }

  if (message.id === 1 || message.id === 2) replies.set(message.id, message);

  if (replies.size === 2) {
    const rateLimits = replies.get(1)!;
    const usage = replies.get(2)!;
    if (rateLimits.error || usage.error) {
      console.error(JSON.stringify({ rateLimits, usage }, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ rateLimits: rateLimits.result, usage: usage.result }, null, 2));
    }
    lines.close();
    proc.stdin.end();
  }
});

proc.on('error', (error: Error) => {
  console.error(`could not run ${codex.bin}: ${brief(error)}`);
  process.exitCode = 1;
});

send({
  method: 'initialize',
  id: 0,
  params: { clientInfo: { name: 'usage_check', title: 'Codex Usage Check', version: '0.1.0' } },
});
