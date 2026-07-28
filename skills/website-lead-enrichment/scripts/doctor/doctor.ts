import fs from 'node:fs';
import { CONFIG_ENV, ENV, readEnv, type EnvKey } from '../lib/env.js';
import { explainLlmError, extractionModel, firecrawlClient, llmClient } from '../lib/llm.js';
import { brief, redact, statusOf } from '../lib/redact.js';
import { reportFatal } from '../lib/cli.js';
import { zyteFetch } from '../lib/scrape.js';
import { describeCodex, resolveCodex } from '../lib/codex.js';

/**
 * One cheap call per configured provider, so a broken credential is a ten-second answer
 * instead of a mid-run failure three stages deep.
 *
 * This exists because the install path proved itself with the two credential-free stages
 * and then stopped — a user could finish setup, see two green checks, and still have a key
 * that 401s or an Azure deployment name that does not exist. Diagnosing that by hand took
 * a real tester twenty minutes.
 *
 * Every check calls the provider **through the same helper the pipeline uses**, so it
 * cannot keep reporting green after the real call shape changes.
 *
 * Rules it inherits from the rest of the project:
 *   - A key is never printed, echoed or included in an error message (`lib/redact.ts`).
 *   - An unconfigured provider is SKIP, not FAIL. Codex is optional by design, and a user
 *     who has deliberately not set up Firecrawl should not be told their install is broken.
 *   - No fallbacks. Each check calls the provider it is checking, or reports that it
 *     cannot, and never substitutes a different route that would look the same.
 *
 * Usage: npx tsx scripts/doctor/doctor.ts
 * Exit code is 1 if any *configured* provider failed, so it works as a CI gate too.
 */

type State = 'PASS' | 'FAIL' | 'SKIP';
interface Result {
  name: string;
  state: State;
  detail: string;
  /** Extra lines printed under the result — how to fix it. */
  hints?: string[];
}

const results: Result[] = [];
/**
 * Every line printed goes through `redact`, hints included.
 *
 * `detail` already arrives redacted via `brief`, but hints interpolate the configured base
 * URL — and an OpenAI-compatible gateway can carry its credential in the URL itself. One
 * choke point is the only way that guarantee holds for text added later.
 */
const add = (r: Result): void => {
  results.push(r);
  console.log(redact(`${r.state}  ${r.name.padEnd(22)} ${r.detail}`));
  for (const h of r.hints ?? []) console.log(redact(`      ${h}`));
};

const rejected = (key: EnvKey, where: string): string => `the key in ${ENV[key]} was rejected — ${where}`;

// --- config -----------------------------------------------------------------------

/**
 * Report what the checks below will actually see, which is not the same as what is in the
 * file: `readEnv` also picks up a variable exported in the shell. Counting by regex over
 * the file text called a working setup unconfigured, and counted a misspelled name as set —
 * both are the wrong-diagnosis-during-onboarding failure `lib/env.ts` exists to prevent.
 */
function checkConfig(): void {
  // `envFile` points AT the config rather than living in it — counting it would report a
  // machine with nothing configured as having one variable set.
  const configured = Object.keys(ENV).filter((k) => k !== 'envFile' && readEnv(k as EnvKey)).length;
  const onDisk = fs.existsSync(CONFIG_ENV);
  if (!onDisk && !configured) {
    add({
      name: 'config',
      state: 'FAIL',
      detail: `no ${CONFIG_ENV}, and nothing set in the environment`,
      hints: ['every provider below will be skipped — create the file and add your keys'],
    });
    return;
  }
  add({
    name: 'config',
    state: 'PASS',
    detail: `${configured} variable(s) visible${onDisk ? ` — ${CONFIG_ENV}` : ' — from the environment'}`,
  });
}

// --- providers --------------------------------------------------------------------

async function checkFirecrawl(): Promise<void> {
  if (!readEnv('firecrawlKey')) {
    add({ name: 'Firecrawl', state: 'SKIP', detail: `${ENV.firecrawlKey} not set — stage 1 will stop` });
    return;
  }
  try {
    // The call stage 1 makes, at the smallest size it accepts.
    await firecrawlClient().map('https://example.com', { limit: 1, timeout: 15_000 });
    add({ name: 'Firecrawl', state: 'PASS', detail: 'site mapping answered' });
  } catch (err) {
    const status = statusOf(err);
    add({
      name: 'Firecrawl',
      state: 'FAIL',
      detail: brief(err),
      hints: [
        status === 401 || status === 403
          ? rejected('firecrawlKey', 'reissue it at firecrawl.dev')
          : status === 402
            ? 'the key is valid but the account is out of credits'
            : 'stage 1 cannot run until this call succeeds',
      ],
    });
  }
}

async function checkZyte(): Promise<void> {
  const key = readEnv('zyteKey');
  if (!key) {
    add({ name: 'Zyte', state: 'SKIP', detail: `${ENV.zyteKey} not set — stages 2-4 will stop` });
    return;
  }
  try {
    // Static mode only: the render path costs far more and proves nothing extra about
    // the credential. Retries on transient errors come with the shared helper, so a
    // flaky 503 no longer reports a working key as broken.
    await zyteFetch('https://example.com', key, 'static');
    add({ name: 'Zyte', state: 'PASS', detail: 'fetched a page' });
  } catch (err) {
    const status = statusOf(err);
    add({
      name: 'Zyte',
      state: 'FAIL',
      detail: brief(err),
      hints: [
        status === 401 || status === 403
          ? rejected('zyteKey', 'check it at zyte.com')
          : 'stages 2-4 cannot run until this call succeeds',
      ],
    });
  }
}

async function checkLlmModel(role: string, model: string): Promise<void> {
  try {
    const res = await llmClient().chat.completions.create(
      {
        model,
        // No token cap: `max_tokens` and `max_completion_tokens` are accepted by different
        // subsets of OpenAI-compatible servers, and a doctor that fails on the parameter
        // rather than the credential is worse than useless. The prompt keeps it to a word.
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      },
      // The SDK defaults to a 10-minute timeout and retries twice, so a base URL that
      // accepts the connection and then stalls — a misconfigured gateway, an endpoint
      // behind a firewall — would hang this script for half an hour with no output. The
      // other two providers are already capped; this one has to be too.
      { timeout: 20_000, maxRetries: 0 },
    );
    const reply = res.choices[0]?.message?.content?.trim().slice(0, 20) ?? '';
    add({ name: `LLM (${role})`, state: 'PASS', detail: `${model} answered ${JSON.stringify(reply)}` });
  } catch (err) {
    // A quota wall is not a bad credential: the request was authenticated to be refused.
    if (statusOf(err) === 429) {
      add({ name: `LLM (${role})`, state: 'PASS', detail: `${model} — rate limited, but the key was accepted` });
      return;
    }
    add({
      name: `LLM (${role})`,
      state: 'FAIL',
      detail: brief(err),
      hints: explainLlmError(err, model, readEnv('llmBaseUrl')),
    });
  }
}

async function checkLlm(): Promise<void> {
  if (!readEnv('llmKey')) {
    // Stage 7 is not in this list on purpose: it runs without an LLM under `--no-ai`,
    // learning patterns deterministically. Saying it "will stop" overstates the damage.
    add({ name: 'LLM', state: 'SKIP', detail: `${ENV.llmKey} not set — stages 1 and 2 will stop` });
    return;
  }
  // Read rather than `reasoningModel()`, which throws: an unset model is a diagnosis to
  // report, not an exception to crash the diagnostic tool with.
  const reasoning = readEnv('llmModelReasoning');
  if (!reasoning) {
    add({
      name: 'LLM',
      state: 'FAIL',
      detail: `${ENV.llmKey} is set but ${ENV.llmModelReasoning} is empty`,
      hints: ['on Azure this must be your deployment name, not the model id'],
    });
    return;
  }
  await checkLlmModel('reasoning', reasoning);

  // `extractionModel()` owns the "falls back to reasoning" rule; re-deriving it here would
  // be a second copy that could validate a model no stage actually uses. Equal means the
  // fallback applied, so the call above already covered it.
  const extraction = extractionModel();
  if (extraction !== reasoning) await checkLlmModel('extraction', extraction);
}

/** Never a failure: stage 5 is skippable by design, and saying otherwise sends users off
 * to install something they were told they did not need. */
function checkCodex(): void {
  const r = resolveCodex();
  add({
    name: 'Codex (optional)',
    state: r.bin ? 'PASS' : 'SKIP',
    detail: describeCodex(r),
    hints: r.warning ? [r.warning] : undefined,
  });
}

// --- main -------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== provider health check ===\n');
  checkConfig();
  // Sequential so each line lands as its provider answers. Buffering and rendering after
  // `Promise.all` would give identical output faster, but the degenerate case here is
  // ~96s — 15s of Firecrawl, then Zyte's three 20s attempts (its timeout error matches
  // RETRYABLE, so the shared helper retries it), then a capped 20s LLM call. Watching it
  // tick is worth more the longer it takes, which is the opposite of the usual trade.
  await checkFirecrawl();
  await checkZyte();
  await checkLlm();
  checkCodex();

  const count = (s: State): number => results.filter((r) => r.state === s).length;
  console.log(`\n${count('PASS')} passed · ${count('FAIL')} failed · ${count('SKIP')} not configured`);
  if (count('FAIL')) {
    const names = results.filter((r) => r.state === 'FAIL').map((r) => r.name);
    console.log(`\nFix: ${names.join(', ')}. Credentials live in ${CONFIG_ENV}.`);
    process.exit(1);
  }
}

main().catch(reportFatal);
