import { Firecrawl } from 'firecrawl';
import OpenAI from 'openai';

/**
 * Provider clients, split by role so a stage only demands what it actually uses.
 *
 * The LLM is any OpenAI-compatible endpoint — OpenAI, Azure OpenAI, OpenRouter, Together,
 * Groq, vLLM, Ollama, LM Studio. Set LLM_BASE_URL + LLM_API_KEY and the two model names.
 * Azure's AZURE_OPENAI_* variables still work unchanged as a preset.
 *
 * Two roles, because the jobs differ:
 *   reasoning  — ranks pages, adjudicates ambiguous email formats
 *   extraction — pulls structured {name,title,email} out of page text
 * One model can fill both; point the two variables at the same name.
 */

const need = (name: string, env: NodeJS.ProcessEnv): string => {
  const v = env[name];
  if (!v) throw new Error(`${name} not set (expected in the project-root .env)`);
  return v;
};

/** Azure exposes an OpenAI-compatible surface under /openai/v1/ on the resource host. */
const azureBaseUrl = (endpoint: string): string => {
  const e = endpoint.replace(/\/+$/, '');
  return e.endsWith('/openai/v1') ? `${e}/` : `${e}/openai/v1/`;
};

/**
 * The chat client. Prefers the generic variables; falls back to the Azure preset so
 * existing .env files keep working.
 */
export function llmClient(env: NodeJS.ProcessEnv = process.env): OpenAI {
  if (env.LLM_BASE_URL || env.LLM_API_KEY) {
    return new OpenAI({
      apiKey: need('LLM_API_KEY', env),
      // Omit LLM_BASE_URL to talk to api.openai.com.
      ...(env.LLM_BASE_URL ? { baseURL: env.LLM_BASE_URL.replace(/\/+$/, '') + '/' } : {}),
    });
  }
  if (env.AZURE_OPENAI_ENDPOINT) {
    return new OpenAI({
      apiKey: need('AZURE_OPENAI_API_KEY', env),
      baseURL: azureBaseUrl(env.AZURE_OPENAI_ENDPOINT),
    });
  }
  throw new Error(
    'no LLM configured: set LLM_API_KEY (plus LLM_BASE_URL for a non-OpenAI endpoint), ' +
      'or the AZURE_OPENAI_* preset. See shared/PROVIDERS.md.',
  );
}

/** Ranking / judgment model. Validated default: Azure gpt-5.6-sol. */
export function reasoningModel(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.LLM_MODEL_REASONING ||
    env.AZURE_OPENAI_DEPLOYMENT_SOL ||
    env.AZURE_OPENAI_RANK_DEPLOYMENT ||
    env.AZURE_OPENAI_DEPLOYMENT_NAME ||
    need('LLM_MODEL_REASONING', env)
  );
}

/** Structured-extraction model. Validated default: Azure gpt-5.6-luna. */
export function extractionModel(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.LLM_MODEL_EXTRACTION ||
    env.AZURE_OPENAI_DEPLOYMENT_LUNA ||
    // Fall back to the reasoning model: one model can do both jobs.
    reasoningModel(env)
  );
}

/**
 * Base URL and key for callers that need the raw pair rather than a client — the
 * Vercel AI SDK provider in the extraction agent. Same precedence as llmClient.
 */
export function llmEndpoint(env: NodeJS.ProcessEnv = process.env): {
  baseURL: string;
  apiKey: string;
} {
  if (env.LLM_BASE_URL || env.LLM_API_KEY) {
    return {
      baseURL: (env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: need('LLM_API_KEY', env),
    };
  }
  return {
    baseURL: azureBaseUrl(need('AZURE_OPENAI_ENDPOINT', env)).replace(/\/+$/, ''),
    apiKey: need('AZURE_OPENAI_API_KEY', env),
  };
}

export function firecrawlClient(env: NodeJS.ProcessEnv = process.env): Firecrawl {
  return new Firecrawl({ apiKey: need('FIRECRAWL_API_KEY', env) });
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
