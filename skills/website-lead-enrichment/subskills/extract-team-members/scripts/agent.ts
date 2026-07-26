import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createOpenAI } from '@ai-sdk/openai';
import { llmClient, llmEndpoint, extractionModel, reasoningModel } from '../../../shared/lib/llm.js';
import { z } from 'zod';
import {
  extractPeopleFromPage,
  fetchPage,
  fetchPageInteractive,
  type FetchedPage,
  type Person,
} from '../../../shared/lib/scrape.js';

/**
 * Website -> [{name, title, email}] agent.
 *
 * Brain: Azure OpenAI **sol** — decides which pages to visit and when to extract.
 * Extractor/organizer: Azure OpenAI **luna** — reads full page text (the agent
 * never sees it, keeping the loop fast/cheap) and produces the person records.
 * Scraper: Zyte smart proxy, static HTML first, browser rendering only for JS shells.
 */

// Provider resolution lives in shared/lib/llm.ts — one definition of "configured".
// This file used to re-implement the LLM_* -> AZURE_* precedence, and the two had
// already drifted (trailing slash, and which key/URL combinations count as valid).
const azureAiSdk = () => createOpenAI(llmEndpoint());
const azureClient = () => llmClient();

export interface TeamExtractSession {
  /** Full fetched pages, keyed by URL — tool results stay small, text stays here. */
  pages: Map<string, FetchedPage>;
  /** Every person luna extracted, across all pages (organized later). */
  rawPeople: Person[];
  visits: number;
}

export const newSession = (): TeamExtractSession => ({ pages: new Map(), rawPeople: [], visits: 0 });

const normUrl = (raw: string): string => (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);

interface InteractRequest {
  mode: 'render' | 'scroll' | 'click';
  clickSelector?: string;
}

const getPage = async (
  session: TeamExtractSession,
  url: string,
  interact?: InteractRequest,
): Promise<FetchedPage> => {
  const target = normUrl(url);
  const key = interact ? `${target}::${interact.mode}:${interact.clickSelector ?? ''}` : target;
  const cached = session.pages.get(key);
  if (cached) return cached;
  // Hard speed gate: interaction (30-60s) is only allowed as a SECOND look at a
  // page whose normal fast fetch has already been seen — never as the first fetch.
  if (interact && !session.pages.get(target)) {
    throw new Error(
      `fetch ${target} normally first (no interact) — interaction is a slow fallback reserved for pages whose normal fetch proved incomplete`,
    );
  }
  const t0 = Date.now();
  let page: FetchedPage;
  if (interact) {
    // No selector given for click mode? Fall back to the first "load more"
    // candidate detected on the non-interactive fetch of the same page.
    let selector = interact.mode === 'click' ? interact.clickSelector : undefined;
    if (interact.mode === 'click' && !selector) {
      selector = session.pages.get(target)?.loadMore[0]?.selector;
      if (!selector) throw new Error('click interaction needs clickSelector (none auto-detected on this page)');
    }
    page = await fetchPageInteractive(target, { mode: interact.mode, clickSelector: selector });
  } else {
    page = await fetchPage(target);
  }
  session.visits += 1;
  session.pages.set(key, page);
  console.error(
    `  ↳ fetch ${key} — ${Date.now() - t0}ms${page.rendered ? (interact ? ' (interactive)' : ' (rendered)') : ''}, ${page.text.length} chars`,
  );
  return page;
};

const pageSummary = (page: FetchedPage) => ({
  rendered: page.rendered,
  textChars: page.text.length,
  loadMoreCandidates: page.loadMore.map((c) => `${c.selector} — "${c.text}"`),
  dataUrls: page.dataUrls,
  apiCaptures: page.apiCaptures.map((c, i) => ({
    index: i,
    url: c.url,
    chars: c.body.length,
    preview: c.body.slice(0, 200),
  })),
  ...(page.actionResults ? { actionResults: page.actionResults } : {}),
});

/** Tool results must stay small — a 2000-person page returns a sample + count. */
const peopleResult = (people: Person[]) =>
  people.length > 40
    ? { found: people.length, sample: people.slice(0, 20), note: 'all recorded; sample shown' }
    : { found: people.length, people };

/** Build the agent + its per-run session (tools close over the session). */
export function buildTeamExtractor() {
  const session = newSession();
  const luna = extractionModel();
  const sol = reasoningModel();

  // NOTE: Azure strict tool-calling makes every key required — optional fields
  // must be modeled as nullable-with-an-explicit-"none", or validation rejects
  // every call the model makes (null / omitted / "" all failed with .optional()).
  const interactInput = {
    interact: z
      .enum(['none', 'render', 'scroll', 'click'])
      .nullable()
      .describe(
        'Fetch mode. "none" (default): fast static fetch. Slow JS modes, only for pages a normal fetch could not fully reveal — "render": browser-render and capture the JSON API calls the page makes; "scroll": infinite scroll; "click": press a Load-more button repeatedly.',
      ),
    clickSelector: z
      .string()
      .nullable()
      .describe('CSS selector of the Load-more button (use a loadMoreCandidates value). Only with interact:"click"; else null.'),
  };
  const toInteract = (c: {
    interact?: 'none' | 'render' | 'scroll' | 'click' | null;
    clickSelector?: string | null;
  }): InteractRequest | undefined =>
    c.interact && c.interact !== 'none'
      ? { mode: c.interact, clickSelector: c.clickSelector || undefined }
      : undefined;

  const visitPage = createTool({
    id: 'visit_page',
    description:
      'Fetch one page of the website (fast static HTML; auto-falls back to browser rendering for JS-only pages). Returns a text preview, the same-site links, and any emails in the source. Safe to retry on error.',
    inputSchema: z.object({ url: z.string().describe('Absolute URL to fetch'), ...interactInput }),
    execute: async ({ context }) => {
      try {
        const page = await getPage(session, context.url, toInteract(context));
        return {
          url: page.url,
          ...pageSummary(page),
          preview: page.text.slice(0, 1500),
          emails: page.emails.slice(0, 40),
          links: page.links.map((l) => `${l.url}${l.text ? ` — ${l.text}` : ''}`),
        };
      } catch (err) {
        return { url: context.url, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const extractPeople = createTool({
    id: 'extract_people',
    description:
      'Extract people (name, title, public email) from a page. Reads the FULL page text (fetches the page first if not yet visited) — call this directly on any page you believe lists team members; no need to visit_page first.',
    inputSchema: z.object({
      url: z.string().describe('Absolute URL of the page to extract from'),
      ...interactInput,
    }),
    execute: async ({ context }) => {
      try {
        const page = await getPage(session, context.url, toInteract(context));
        const people = await extractPeopleFromPage(azureClient(), luna, page);
        session.rawPeople.push(...people);
        return { url: page.url, ...pageSummary(page), ...peopleResult(people) };
      } catch (err) {
        return { url: context.url, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const extractFromCapture = createTool({
    id: 'extract_people_from_capture',
    description:
      'Extract people from a JSON API response captured during a rendered fetch (an apiCaptures entry of an already-fetched page). Instant — no network call. Use when the people data lives in a captured API payload.',
    inputSchema: z.object({
      pageUrl: z.string().describe('URL of the page whose fetch produced the capture'),
      captureIndex: z.number().int().describe('index from that page result\'s apiCaptures list'),
    }),
    execute: async ({ context }) => {
      try {
        const target = normUrl(context.pageUrl);
        const candidates = [...session.pages.values()].filter(
          (p) => p.url === target && p.apiCaptures.length > 0,
        );
        const page = candidates.sort((a, b) => b.apiCaptures.length - a.apiCaptures.length)[0];
        const capture = page?.apiCaptures[context.captureIndex];
        if (!capture) {
          return {
            error: `no capture #${context.captureIndex} for ${target} — captures exist only after a rendered/interactive fetch of that page`,
          };
        }
        const people = await extractPeopleFromPage(azureClient(), luna, {
          url: capture.url,
          text: capture.body,
          emails: [],
        });
        session.rawPeople.push(...people);
        return { capturedFrom: capture.url, ...peopleResult(people) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const agent = new Agent({
    name: 'team-extractor',
    model: azureAiSdk().chat(sol),
    tools: { visitPage, extractPeople, extractFromCapture },
    instructions: [
      'You extract the team members (name, job title, public email) of ONE organization from its public website. SPEED IS THE TOP PRIORITY — take the shortest path.',
      '',
      'Playbook:',
      '1. visit_page the homepage. Look at its links for people pages: team, about, our-people, staff, leadership, doctors, providers, specialists, practitioners, partners, board — including unconventional names ("meet …", "who we are").',
      '2. If the homepage preview itself clearly names team members, extract_people on the homepage immediately.',
      '3. extract_people directly on each likely people page (it fetches the page itself — do NOT visit_page first unless you need its links). Prefer directory pages that list many people over individual profiles.',
      '4. Only open individual profile pages when the directory shows names but NO titles/emails, and then at most a handful.',
      '5. If a people directory is PAGINATED (links like "page 2", "next", "?page=2", "/page/3"), walk every page of the directory and extract_people on each until the pages run out or repeat.',
      '6. If a directory loads people DYNAMICALLY — real evidence: loadMoreCandidates reported, the page says "Showing N of M" with fewer extracted, or the list is clearly cut off — find the DATA SOURCE instead of driving the browser. Escalate in THIS order, easiest first:',
      '   a. Check dataUrls on the page result: sites often ship the people data as a .json/.csv file. If one looks like people data, extract_people directly on that URL — it fetches fast and extraction handles even thousands of records. If dataUrls only shows a JS bundle (/assets/*.js), visit_page the bundle: its dataUrls will name the data files the site loads (NEVER extract_people on a .js file itself — bundles are code, use them only for discovery).',
      '   b. interact:"render" on the page. It captures the JSON/CSV API calls the page makes (apiCaptures). Jackpot when a capture holds the people data: extract_people_from_capture on it — and captured API URLs are plain GETs, so you can also extract_people on the API URL with tweaked params (?page=2, ?per_page=100, ?limit=1000) to sweep ALL records. Pages that auto-rendered (rendered:true) already include apiCaptures — check before interacting at all.',
      '   c. interact:"scroll" for infinite-scroll pages with no findable data source.',
      '   d. interact:"click" with a clickSelector from loadMoreCandidates — the WORST case, last resort only.',
      '   Interaction fetches are SLOW (30-60s) and refused on a page not fetched normally first. A directory that already yielded its full people list needs NO interaction even if a load-more button exists. At most 3 interactive fetches per site.',
      '7. A tool error is usually transient — retry that URL once, then move on to the next candidate page.',
      '',
      'Budget: at most 12 page fetches total. Stop as soon as the team list looks complete — most sites need only 1-3 pages.',
      'When done, reply with one short line summarizing how many people were found and from which pages. Do NOT list the people in your reply — they are collected automatically.',
    ].join('\n'),
  });

  return { agent, session };
}

export { organizePeople } from '../../../shared/lib/scrape.js';
export const lunaClient = azureClient;
