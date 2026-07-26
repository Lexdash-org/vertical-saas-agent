import type OpenAI from 'openai';
import { z } from 'zod';

/**
 * Team-member extractor building blocks: fast Zyte fetch (static HTML first,
 * browser rendering ONLY when the static HTML is a JS shell), HTML→text/link/
 * email utilities, and the luna-powered extract + organize calls.
 *
 * Speed contract: most sites list people directly in the HTML source — the
 * static proxy GET (~1-3s) is always tried first and is usually all we need.
 */

export interface Person {
  name: string;
  title: string | null;
  email: string | null;
}

export interface PageLink {
  url: string;
  text: string;
}

export interface LoadMoreCandidate {
  /** CSS selector usable in a Zyte click action. */
  selector: string;
  text: string;
}

export interface ApiCapture {
  url: string;
  /** Decoded response body (JSON text). */
  body: string;
}

export interface FetchedPage {
  url: string;
  html: string;
  text: string;
  links: PageLink[];
  emails: string[];
  /** true when we had to fall back to Zyte browserHtml (JS-rendered site). */
  rendered: boolean;
  /** "Load more"-style clickables detected in the HTML (hints for interaction). */
  loadMore: LoadMoreCandidate[];
  /** JSON/CSV XHR responses captured during a browser-rendered fetch — often
   *  the site's own people API, the easiest and most complete data source. */
  apiCaptures: ApiCapture[];
  /** Same-site JS bundles + .json/.csv//api//data/ URLs referenced by the content. */
  dataUrls: string[];
  /** Per-action outcomes when the page was fetched interactively. */
  actionResults?: { action: string; status: string; error?: string }[];
}

const ZYTE_ENDPOINT = 'https://api.zyte.com/v1/extract';
const STATIC_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 60_000;
/** Below this much visible text the page is treated as a JS shell → render. */
const JS_SHELL_TEXT_CHARS = 600;

const RETRYABLE = /\b(429|500|502|503|520|521|522|523|524)\b|UND_ERR|ECONNRESET|ETIMEDOUT|aborted|network/i;

interface ZyteResult {
  html: string;
  actionResults?: { action: string; status: string; error?: string }[];
  apiCaptures: ApiCapture[];
}

// Capture data-ish network responses during browser rendering. Zyte caps
// captures at ~10 — a broad filter gets flooded by css/images/fonts, so target
// the URL shapes data actually travels under.
const NETWORK_CAPTURE = ['json', '.csv', '/api/', '/data/', 'graphql'].map((value) => ({
  filterType: 'url',
  matchType: 'contains',
  value,
  httpResponseBody: true,
}));

const isJsonText = (s: string): boolean => {
  if (!/^[[{]/.test(s)) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/** ≥3 lines whose first two rows carry ≥2 delimiters each. */
const isCsvText = (s: string): boolean => {
  const lines = s.split('\n', 3);
  if (lines.length < 3) return false;
  const count = (l: string) => (l.match(/[,\t]/g) ?? []).length;
  return count(lines[0]) >= 2 && count(lines[1]) >= 2;
};

/** Keep captured responses that are JSON or CSV (data), same-site sorted first. */
function decodeCaptures(
  raw: { url?: string; httpResponseBody?: string }[] | undefined,
  pageUrl: string,
): ApiCapture[] {
  const siteKey = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return '';
    }
  })();
  const sameSite = (u: string): boolean => {
    try {
      const host = new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
      return host === siteKey || host.endsWith(`.${siteKey}`);
    } catch {
      return false;
    }
  };
  const out: ApiCapture[] = [];
  for (const cap of raw ?? []) {
    if (!cap.url || !cap.httpResponseBody) continue;
    const body = Buffer.from(cap.httpResponseBody, 'base64').toString('utf8').trim();
    if (!isJsonText(body) && !isCsvText(body)) continue;
    out.push({ url: cap.url, body: body.slice(0, 1_500_000) });
    if (out.length >= 15) break;
  }
  // The site's own data endpoints matter most; big payloads before trackers.
  return out.sort(
    (a, b) => Number(sameSite(b.url)) - Number(sameSite(a.url)) || b.body.length - a.body.length,
  );
}

/**
 * Data-source URLs referenced by the fetched content: JS bundles (which often
 * embed or name the data files a JS site renders from), and .json/.csv//api/
 * paths found in markup or script source. Lets the agent read the data source
 * directly instead of driving the browser.
 */
export function extractDataUrls(content: string, pageUrl: string, cap = 20): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const siteKey = base.hostname.replace(/^www\./i, '').toLowerCase();
  const found = new Set<string>();
  const push = (raw: string) => {
    if (found.size >= cap) return;
    try {
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) return;
      const host = u.hostname.replace(/^www\./i, '').toLowerCase();
      if (host !== siteKey && !host.endsWith(`.${siteKey}`)) return;
      found.add(u.toString());
    } catch {
      // ignore malformed
    }
  };
  for (const m of content.matchAll(/(?:src|href)=["']([^"']+\.m?js(?:\?[^"']*)?)["']/gi)) push(m[1]);
  for (const m of content.matchAll(/["'`]((?:https?:\/\/[^"'`\s]+|\/[^"'`\s]+)\.(?:json|csv)(?:\?[^"'`\s]*)?)["'`]/gi)) push(m[1]);
  for (const m of content.matchAll(/["'`](\/(?:api|data)\/[^"'`\s]{2,100})["'`]/gi)) push(m[1]);
  return [...found];
}

/** One Zyte extract call, 3 attempts on transient errors. */
async function zyteExtract(
  body: Record<string, unknown>,
  timeout: number,
  apiKey: string,
  label: string,
): Promise<ZyteResult> {
  const auth = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ZYTE_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Zyte ${label} ${res.status}: ${errBody.slice(0, 160)}`);
      }
      const json = (await res.json()) as {
        httpResponseBody?: string;
        browserHtml?: string;
        actions?: { action: string; status: string; error?: string }[];
        networkCapture?: { url?: string; httpResponseBody?: string }[];
      };
      if (json.httpResponseBody) {
        return { html: Buffer.from(json.httpResponseBody, 'base64').toString('utf8'), apiCaptures: [] };
      }
      if (json.browserHtml) {
        return {
          html: json.browserHtml,
          actionResults: json.actions,
          apiCaptures: decodeCaptures(json.networkCapture, String(body.url ?? '')),
        };
      }
      throw new Error(`Zyte: empty ${label} response`);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? `${err.message} ${(err.cause as Error | undefined)?.message ?? ''}` : String(err);
      if (attempt < 2 && RETRYABLE.test(msg)) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * mode "static" = raw HTTP response body (fast, ~1-3s); "rendered" = browserHtml.
 */
async function zyteFetch(url: string, apiKey: string, mode: 'static' | 'rendered'): Promise<ZyteResult> {
  const target = url.replace(/^http:\/\//i, 'https://');
  const body =
    mode === 'static'
      ? { url: target, httpResponseBody: true }
      : { url: target, browserHtml: true, networkCapture: NETWORK_CAPTURE };
  const timeout = mode === 'static' ? STATIC_TIMEOUT_MS : RENDER_TIMEOUT_MS;
  return zyteExtract(body, timeout, apiKey, mode);
}

/**
 * Heuristic scan for "Load more"-style clickables. Derives a CSS selector from
 * the element's id or first class so it can be fed to a Zyte click action.
 */
export function detectLoadMore(html: string): LoadMoreCandidate[] {
  const out: LoadMoreCandidate[] = [];
  const seen = new Set<string>();
  const SAFE = /^[A-Za-z][A-Za-z0-9_-]*$/;
  for (const m of html.matchAll(/<(button|a|div|span)\b([^>]*)>([\s\S]{0,160}?)<\/\1>/gi)) {
    const text = decodeEntities(m[3].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text.length > 60) continue;
    if (!/\b(?:load|show|view|see)\s+(?:more|all)\b|\bmore\s+(?:results|doctors|people|team)\b/i.test(text)) continue;
    const attrs = m[2];
    const id = attrs.match(/\bid=["']([^"']+)["']/i)?.[1];
    const cls = attrs
      .match(/\bclass=["']([^"']+)["']/i)?.[1]
      ?.trim()
      .split(/\s+/)
      .find((c) => SAFE.test(c));
    const selector = id && SAFE.test(id) ? `#${id}` : cls ? `${m[1].toLowerCase()}.${cls}` : null;
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    out.push({ selector, text });
    if (out.length >= 5) break;
  }
  return out;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(?:br|hr)[^>]*>|<\/(?:p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Same-site links (absolute, deduped by path, hash-stripped). */
export function extractLinks(html: string, pageUrl: string, cap = 150): PageLink[] {
  const base = new URL(pageUrl);
  const siteKey = base.hostname.replace(/^www\./i, '').toLowerCase();
  const seen = new Set<string>();
  const links: PageLink[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= cap) break;
    try {
      const url = new URL(m[1], base);
      if (!/^https?:$/.test(url.protocol)) continue;
      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      if (host !== siteKey && !host.endsWith(`.${siteKey}`)) continue;
      if (/\.(?:css|js|json|xml|pdf|jpe?g|png|gif|webp|svg|ico|woff2?|zip|mp4)$/i.test(url.pathname)) continue;
      url.hash = '';
      // Keep the query string in the dedupe key — ?page=2 / ?page=3 style
      // pagination links are distinct pages the agent must be able to walk.
      const key = `${host}${url.pathname.replace(/\/+$/, '') || '/'}${url.search}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      links.push({ url: url.toString(), text: text.slice(0, 80) });
    } catch {
      // skip malformed hrefs
    }
  }
  return links;
}

/** mailto: hrefs + plain-text email mentions, junk filtered. */
/**
 * Decode one Cloudflare "email address obfuscation" blob (`data-cfemail="6b02..."`).
 * The address is XOR-encoded with the first byte as key — no browser/render
 * needed; the encoded blob is already in the static HTML Cloudflare serves.
 */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-fA-F]{6,}$/.test(hex) || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out) ? out : null;
}

export function extractEmails(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?\s<>]+)/gi)) {
    // mailto values can carry URL-encoded whitespace / leading junk
    // (e.g. "mailto:%20admin@x.com%20") — pull the clean email token out.
    const decoded = decodeEntities(m[1]).replace(/%20/gi, ' ');
    const em = decoded.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (em) out.add(em[0].toLowerCase());
  }
  for (const m of html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) out.add(m[0].toLowerCase());
  // Cloudflare-obfuscated addresses: decode data-cfemail= attrs and the
  // #<hex> fragment on /cdn-cgi/l/email-protection links.
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-fA-F]+)["']/gi)) {
    const e = decodeCfEmail(m[1]);
    if (e) out.add(e.toLowerCase());
  }
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/gi)) {
    const e = decodeCfEmail(m[1]);
    if (e) out.add(e.toLowerCase());
  }
  return [...out].filter(
    (e) =>
      !/\.(?:png|jpe?g|gif|webp|svg|css|js)$/.test(e) &&
      // Template/placeholder addresses baked into themes (incl. ones that come
      // out of decoded Cloudflare cfemail dummy blobs like info@domain.com).
      !/@(?:example|sentry|schema|w3|domain|yourdomain|email|yourcompany|company|website|test)\.(?:com|net|org)/.test(e) &&
      !/^(?:your|youremail|name|firstname|lastname|email|username|user)@/.test(e) &&
      !/^[0-9a-f]{16,}@/.test(e),
  );
}

/**
 * Fetch a page the fast way: static HTML through the Zyte proxy; escalate to
 * browser rendering ONLY when the static HTML has almost no visible text.
 */
export async function fetchPage(url: string, opts: { forceRender?: boolean } = {}): Promise<FetchedPage> {
  const apiKey = process.env.ZYTE_API_KEY;
  if (!apiKey) throw new Error('ZYTE_API_KEY not set (expected in repo-root .env)');
  let html = '';
  let rendered = false;
  let apiCaptures: ApiCapture[] = [];
  let staticErr: unknown;
  // forceRender: skip static entirely and go straight to browserHtml — used to
  // recover emails that a site injects via JS (never present in the static HTML,
  // so the shell-size heuristic below would never trigger the render fallback).
  if (opts.forceRender) {
    const res = await zyteFetch(url, apiKey, 'rendered');
    const rhtml = res.html;
    return {
      url,
      html: rhtml,
      text: htmlToText(rhtml),
      links: extractLinks(rhtml, url),
      emails: extractEmails(rhtml),
      rendered: true,
      loadMore: detectLoadMore(rhtml),
      apiCaptures: res.apiCaptures,
      dataUrls: extractDataUrls(rhtml, url),
    };
  }
  try {
    html = (await zyteFetch(url, apiKey, 'static')).html;
  } catch (err) {
    staticErr = err;
  }
  // Non-HTML content (a JSON/CSV data file, a JS bundle) is already "text":
  // stripping tags would mangle it, and it is complete as-is — never a JS shell.
  const isMarkup = (s: string) => /<(?:!doctype|html|head|body|div|main|section)\b/i.test(s.slice(0, 4000));
  let text = html ? (isMarkup(html) ? htmlToText(html) : html) : '';
  const isData = html !== '' && (isJsonText(html.trim()) || isCsvText(html) || !isMarkup(html));
  if (!html || (text.length < JS_SHELL_TEXT_CHARS && !isData)) {
    try {
      const res = await zyteFetch(url, apiKey, 'rendered');
      html = res.html;
      text = htmlToText(html);
      apiCaptures = res.apiCaptures;
      rendered = true;
    } catch (err) {
      if (!html) throw staticErr ?? err; // both paths failed
      // keep the thin static page — better than nothing
    }
  }
  return {
    url,
    html,
    text,
    links: extractLinks(html, url),
    emails: extractEmails(html),
    rendered,
    loadMore: detectLoadMore(html),
    apiCaptures,
    dataUrls: extractDataUrls(html, url),
  };
}

export interface InteractOptions {
  /** "render" = browser render + network capture only; "scroll" = infinite scroll; "click" = press a load-more button. */
  mode: 'render' | 'scroll' | 'click';
  /** CSS selector to click repeatedly ("Load more" button). Required for mode "click". */
  clickSelector?: string;
  /** How many times to click / extra-scroll. */
  rounds?: number;
}

/**
 * Interactive fetch for JS pages that reveal people as you scroll or click
 * "load more": browser-rendered with Zyte actions. Zyte stops at the first
 * failing action (e.g. the button disappeared after the list was exhausted)
 * but still returns the HTML captured so far — exactly what we want.
 */
export async function fetchPageInteractive(url: string, opts: InteractOptions): Promise<FetchedPage> {
  const apiKey = process.env.ZYTE_API_KEY;
  if (!apiKey) throw new Error('ZYTE_API_KEY not set (expected in repo-root .env)');
  const rounds = Math.min(Math.max(opts.rounds ?? 6, 1), 12);
  const actions: Record<string, unknown>[] = [];
  if (opts.mode !== 'render') {
    actions.push({ action: 'scrollBottom' }, { action: 'waitForTimeout', timeout: 1.5 });
    for (let i = 0; i < rounds; i++) {
      if (opts.mode === 'click' && opts.clickSelector) {
        actions.push(
          { action: 'click', selector: { type: 'css', value: opts.clickSelector } },
          { action: 'waitForTimeout', timeout: 1.5 },
          { action: 'scrollBottom' },
        );
      } else {
        actions.push({ action: 'scrollBottom' }, { action: 'waitForTimeout', timeout: 1.5 });
      }
    }
  }
  const target = url.replace(/^http:\/\//i, 'https://');
  const { html, actionResults, apiCaptures } = await zyteExtract(
    { url: target, browserHtml: true, networkCapture: NETWORK_CAPTURE, ...(actions.length ? { actions } : {}) },
    RENDER_TIMEOUT_MS + (opts.mode === 'render' ? 0 : rounds * 5_000),
    apiKey,
    'interactive',
  );
  return {
    url,
    html,
    text: htmlToText(html),
    links: extractLinks(html, url),
    emails: extractEmails(html),
    rendered: true,
    loadMore: detectLoadMore(html),
    apiCaptures,
    dataUrls: extractDataUrls(html, url),
    actionResults,
  };
}

// ---------------------------------------------------------------------------
// luna: page text -> people, and raw people -> final organized array
// ---------------------------------------------------------------------------

const peopleSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string(),
        title: z.string().nullish(),
        email: z.string().nullish(),
      }),
    )
    .default([]),
});

const parseJson = (raw: string): unknown =>
  JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));

const EXTRACT_SYSTEM = `You extract the people who WORK AT (or are listed by) the organization from one page of its website. The input may be visible page text, or raw JSON/CSV from the site's own data API — extract from whichever it is.

Return every person the page names as part of the organization: employees, leadership, founders, doctors, practitioners, partners, board members, staff.
For each person:
- "name": full name as written (no honorific-only entries; keep credentials out of the name — "Dr Jane Smith" -> "Jane Smith").
- "title": their role/job title as stated on the page, else null. Never invent one.
- "email": their PERSONAL email only if it is publicly shown on the page or in the provided email list and clearly belongs to that person (matching name fragments). Generic inboxes (info@, reception@, admin@) are NOT a person's email — use null.
Do NOT include: testimonials, patients, clients, article authors from other companies, or people only mentioned in passing news text.
Respond with strict JSON only: {"people":[{"name":"...","title":"..."|null,"email":"..."|null}]}. If the page names nobody, return {"people":[]}.`;

const CHUNK_CHARS = 50_000;
const MAX_CHUNKS = 24;

/** Split oversized content on line boundaries; CSV chunks re-carry the header row. */
function chunkText(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const lines = text.split('\n');
  const header = isCsvText(text) ? lines.shift() ?? '' : '';
  const chunks: string[] = [];
  let current: string[] = header ? [header] : [];
  let size = header.length;
  for (const line of lines) {
    if (size + line.length > CHUNK_CHARS && current.length > (header ? 1 : 0)) {
      chunks.push(current.join('\n'));
      current = header ? [header] : [];
      size = header.length;
      if (chunks.length >= MAX_CHUNKS) return chunks;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > (header ? 1 : 0)) chunks.push(current.join('\n'));
  return chunks.slice(0, MAX_CHUNKS);
}

async function extractChunk(
  client: OpenAI,
  model: string,
  url: string,
  emails: string[],
  chunk: string,
): Promise<Person[]> {
  const user = [
    `Page URL: ${url}`,
    emails.length ? `Emails found in the page source: ${emails.join(', ')}` : '',
    'Page content:',
    chunk,
  ]
    .filter(Boolean)
    .join('\n');
  const res = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: user },
    ],
  });
  const parsed = peopleSchema.parse(parseJson(res.choices[0]?.message?.content ?? '{}'));
  return parsed.people.map((p) => ({
    name: p.name.trim(),
    title: p.title?.trim() || null,
    email: p.email?.trim().toLowerCase() || null,
  }));
}

/** Extract people; large payloads (a whole people API/CSV) run as parallel chunks. */
export async function extractPeopleFromPage(
  client: OpenAI,
  model: string,
  page: { url: string; text: string; emails: string[] },
): Promise<Person[]> {
  const chunks = chunkText(page.text);
  if (chunks.length === 1) return extractChunk(client, model, page.url, page.emails, chunks[0]);
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(4);
  const results = await Promise.all(
    chunks.map((chunk) => limit(() => extractChunk(client, model, page.url, page.emails, chunk))),
  );
  return results.flat();
}

/** Deterministic merge of duplicate people (case/punctuation-insensitive name key). */
export function dedupePeople(raw: Person[]): Person[] {
  const byKey = new Map<string, Person>();
  for (const p of raw) {
    const key = p.name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...p });
    } else {
      if (p.name.length > prev.name.length) prev.name = p.name;
      if (p.title && (!prev.title || p.title.length > prev.title.length)) prev.title = p.title;
      if (p.email && !prev.email) prev.email = p.email;
    }
  }
  return [...byKey.values()];
}

const ORGANIZE_SYSTEM = `You are given raw person records extracted from several pages of one organization's website. Produce the final clean team list.

Rules:
- Merge duplicates of the same person (name variants, with/without credentials): keep the fullest name form, the most specific title, and any non-null email.
- Drop entries that are clearly not people (departments, "Our Team", locations).
- Keep the organization's own people only.
- Order: leadership/founders first, then the rest alphabetically by name.
Respond with strict JSON only: {"people":[{"name":"...","title":"..."|null,"email":"..."|null}]}.`;

export async function organizePeople(client: OpenAI, model: string, raw: Person[]): Promise<Person[]> {
  if (!raw.length) return [];
  const deduped = dedupePeople(raw);
  // Large teams: the deterministic dedupe IS the organize step — an LLM pass
  // over thousands of records would be slow, expensive, and lossy.
  if (deduped.length > 250) {
    return deduped.sort((a, b) => a.name.localeCompare(b.name));
  }
  const res = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: ORGANIZE_SYSTEM },
      { role: 'user', content: JSON.stringify(deduped) },
    ],
  });
  const parsed = peopleSchema.parse(parseJson(res.choices[0]?.message?.content ?? '{}'));
  return parsed.people.map((p) => ({
    name: p.name.trim(),
    title: p.title?.trim() || null,
    email: p.email?.trim().toLowerCase() || null,
  }));
}
