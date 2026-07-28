import { Firecrawl } from 'firecrawl';
import OpenAI from 'openai';
import { ENV, readEnv, requireEnv } from './env.js';
import { messageOf, statusOf } from './redact.js';

/**
 * Provider clients, split by role so a stage only demands what it actually uses.
 *
 * **One provider path: any OpenAI-compatible endpoint.** OpenAI, Azure OpenAI, OpenRouter,
 * Together, Groq, vLLM, Ollama, LM Studio. Set the base URL, the key and the two model
 * names; omit the base URL for OpenAI itself.
 *
 * Azure used to have a dedicated preset. It was removed because Azure already speaks the
 * OpenAI API under `/openai/v1/` — the preset was a second code path to the same place,
 * and it cost a provider-selection bug, a four-deep model fallback chain, two undocumented
 * variables and a whole either/or caveat in the preflight docs. Azure users point
 * LEADGEN_LLM_BASE_URL at `https://<resource>.cognitiveservices.azure.com/openai/v1/` and
 * use their deployment names as the model names.
 *
 * Two roles, because the jobs differ:
 *   reasoning  — ranks pages, adjudicates ambiguous email formats
 *   extraction — pulls structured {name,title,email} out of page text
 * One model can fill both; point the two variables at the same name.
 */

/** Trailing slash matters to the SDK's URL joining; normalize once. */
const withSlash = (url: string): string => `${url.replace(/\/+$/, '')}/`;

export function llmClient(env: NodeJS.ProcessEnv = process.env): OpenAI {
  const baseURL = readEnv('llmBaseUrl', env);
  return new OpenAI({
    apiKey: requireEnv('llmKey', 'the language model that ranks pages and extracts people', env),
    // Omitted entirely for api.openai.com, which is the SDK's own default.
    ...(baseURL ? { baseURL: withSlash(baseURL) } : {}),
  });
}

/** Ranking / judgment model. */
export function reasoningModel(env: NodeJS.ProcessEnv = process.env): string {
  return requireEnv('llmModelReasoning', 'ranking team pages and judging email formats', env);
}

/** Structured-extraction model. Falls back to the reasoning model — one model can do both. */
export function extractionModel(env: NodeJS.ProcessEnv = process.env): string {
  return readEnv('llmModelExtraction', env) ?? reasoningModel(env);
}

/**
 * Base URL and key for callers that need the raw pair rather than a client — the Vercel
 * AI SDK provider in the extraction agent.
 */
export function llmEndpoint(env: NodeJS.ProcessEnv = process.env): {
  baseURL: string;
  apiKey: string;
} {
  return {
    baseURL: (readEnv('llmBaseUrl', env) ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: requireEnv('llmKey', 'the language model', env),
  };
}

/**
 * Turn a chat-completion failure into lines a person can act on.
 *
 * Lives here rather than in the health check because every stage builds its client from
 * this file and hits the same endpoint: an Azure 404 mid-run deserves the same explanation
 * as one during setup. Pure — takes the error, returns strings, touches no I/O — so it can
 * be called from anywhere a completion fails.
 *
 * Azure is the configuration most likely to be wrong and its two failure modes look nothing
 * alike from outside. The full explanation, including why the model catalog is the wrong
 * place to read deployment names from, is in `references/providers.md`.
 */
export { statusOf } from './redact.js';

export function explainLlmError(err: unknown, model: string, baseUrl?: string): string[] {
  const endpoint = baseUrl ?? 'https://api.openai.com/v1';
  const azure = /azure|cognitiveservices/i.test(endpoint);
  const status = statusOf(err);
  const msg = messageOf(err);

  if (status === 401 || status === 403) return [`the key in ${ENV.llmKey} was rejected by ${endpoint}`];
  if (status === 404) {
    return azure
      ? [
          `no deployment named "${model}" exists on this Azure resource.`,
          'Azure model names are DEPLOYMENT names — copy the exact spelling from Azure AI',
          'Foundry > Deployments, not from the model catalog. See references/providers.md.',
        ]
      : [`${endpoint} has no model named "${model}"`];
  }
  if (status === 400 && /not allowed|not supported|batch/i.test(msg)) {
    return [
      `the deployment "${model}" exists but rejects this operation —`,
      'on Azure, usually a batch-only deployment. See references/providers.md.',
    ];
  }
  return [`called ${endpoint} with model "${model}"`];
}

export function firecrawlClient(env: NodeJS.ProcessEnv = process.env): Firecrawl {
  return new Firecrawl({
    apiKey: requireEnv('firecrawlKey', 'mapping a site\'s URLs (stage 1)', env),
  });
}

export interface TeamPagesClients {
  firecrawl: Firecrawl;
  openai: OpenAI;
  /** Model name used for ranking. */
  model: string;
}

/** Everything page discovery needs: Firecrawl to map, the LLM to rank. */
export function clientsFromEnv(env: NodeJS.ProcessEnv = process.env): TeamPagesClients {
  return {
    firecrawl: firecrawlClient(env),
    openai: llmClient(env),
    model: reasoningModel(env),
  };
}
