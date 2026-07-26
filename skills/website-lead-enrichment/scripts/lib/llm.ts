import { Firecrawl } from 'firecrawl';
import OpenAI from 'openai';
import { readEnv, requireEnv } from './env.js';

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
