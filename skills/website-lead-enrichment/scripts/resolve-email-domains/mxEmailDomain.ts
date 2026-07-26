import dns from 'node:dns';

/**
 * Cost-free email-domain check: a domain can receive mail if it has MX records, and the
 * MX hostnames say which provider runs them. Pure DNS — no paid API, no key, no vendor.
 *
 * This is a yes/no deliverability signal, NOT a resolver: `emailDomain` is always the
 * domain you passed in. It never discovers that a company sends from somewhere else.
 */

const resolver = dns.promises;
// Public resolvers, because a laptop's local resolver or a VPN's DNS is often flaky and
// a SERVFAIL here reads as "this company has no mail" — a wrong and expensive conclusion.
try {
  resolver.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']);
} catch {
  // Some sandboxes forbid this; the default resolver still works.
}

export type Confidence = 'high' | 'medium' | 'none' | 'error' | 'invalid';

export interface EmailDomainResult {
  domain: string | null;
  raw?: string;
  emailDomain?: string | null;
  provider?: string | null;
  hasMx?: boolean | null;
  confidence: Confidence;
  mx?: string[];
  signal: string;
}

/** MX hostname -> mail provider. First match wins. */
const PROVIDERS: [RegExp, string][] = [
  [/\.google\.com$|googlemail\.com$|\.l\.google\.com$|smtp\.google\.com$/i, 'Google Workspace'],
  [/mail\.protection\.outlook\.com$|\.outlook\.com$|olc\.protection\.outlook\.com$/i, 'Microsoft 365'],
  [/pphosted\.com$|ppe-hosted\.com$/i, 'Proofpoint'],
  [/mimecast\.com$|mimecast-offshore\.com$|mimecast\.co\.za$/i, 'Mimecast'],
  [/mx\.cloudflare\.net$/i, 'Cloudflare Email'],
  [/zoho\.com$|zohomail\.com$|zoho\.eu$|zoho\.in$/i, 'Zoho'],
  [/messagingengine\.com$|fastmail\.com$/i, 'Fastmail'],
  [/iphmx\.com$|cisco\.com$/i, 'Cisco/IronPort'],
  [/barracuda(networks)?\.com$|cudasvc\.com$/i, 'Barracuda'],
  [/secureserver\.net$/i, 'GoDaddy'],
  [/awsapps\.com$|amazonaws\.com$/i, 'Amazon WorkMail/SES'],
  [/protonmail\.ch$|proton\.me$|protonmail\.com$/i, 'Proton'],
  [/yandex\.net$|mx\.yandex/i, 'Yandex'],
  [/qq\.com$|exmail\.qq\.com$/i, 'Tencent Exmail'],
  [/aliyun\.com$|mxhichina\.com$/i, 'Alibaba'],
  [/messagelabs\.com$/i, 'Symantec MessageLabs'],
  [/emailsrvr\.com$/i, 'Rackspace'],
  [/forcepoint\.com$|mailcontrol\.com$/i, 'Forcepoint'],
  [/sophos\.com$/i, 'Sophos'],
  [/trendmicro\.com$|tmes\.trendmicro/i, 'Trend Micro'],
];

export function classifyProvider(mxHosts: string[]): string | null {
  for (const host of mxHosts) {
    const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
    for (const [re, name] of PROVIDERS) if (re.test(h)) return name;
  }
  return null;
}

/** Reduce anything URL-shaped to a bare hostname, or null when it cannot be one. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s
    .replace(/^[a-z]+:\/\//, '') // scheme
    .replace(/[/?#].*$/, '') // path / query / hash
    .replace(/:\d+$/, '') // port
    .replace(/^www\d?\./, '') // leading www, www2
    .replace(/\.$/, ''); // trailing dot
  if (!s.includes('.') || /\s/.test(s)) return null;
  return s;
}

interface DohAnswer {
  type: number;
  data: string;
}

/**
 * DNS-over-HTTPS fallback, Cloudflare then Google.
 *
 * Only used when the native lookup fails in a way that is not authoritative — a corporate
 * resolver that SERVFAILs would otherwise mark every domain as having no mail.
 */
async function dohQuery(name: string, type: string): Promise<{ Status?: number; Answer?: DohAnswer[] } | null> {
  const endpoints = [
    `https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      return (await res.json()) as { Status?: number; Answer?: DohAnswer[] };
    } catch {
      // try the next resolver
    }
  }
  return null;
}

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('dns-timeout')), ms)),
  ]);

/** MX hostnames by priority, or an error marker when DNS itself failed. */
async function lookupMx(domain: string): Promise<string[] | { error: string }> {
  try {
    const recs = await withTimeout(resolver.resolveMx(domain), 6000);
    return recs?.length
      ? [...recs].sort((a, b) => a.priority - b.priority).map((r) => r.exchange)
      : [];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // NODATA and NXDOMAIN are authoritative "no MX" — trust them, skip the DoH round trip.
    if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
    const j = await dohQuery(domain, 'MX');
    if (!j) return { error: code ?? 'dns-error' };
    if (j.Status === 3) return []; // NXDOMAIN
    return (j.Answer ?? [])
      .filter((a) => a.type === 15)
      .map((a) => String(a.data).replace(/^\d+\s+/, '').replace(/\.$/, ''))
      .filter(Boolean);
  }
}

/**
 * Confidence:
 *   high    MX at a recognised provider
 *   medium  MX present, provider unrecognised or self-hosted
 *   none    no MX — the domain cannot receive mail, so never predict against it
 *   error   DNS failed; transient, retry later
 *   invalid the input was not a domain
 */
export async function resolveEmailDomain(rawDomain: string): Promise<EmailDomainResult> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    return { domain: null, raw: rawDomain, confidence: 'invalid', signal: 'unparseable-domain' };
  }

  const mx = await lookupMx(domain);
  if (!Array.isArray(mx)) {
    return { domain, emailDomain: null, provider: null, hasMx: null, confidence: 'error', mx: [], signal: mx.error };
  }
  if (!mx.length) {
    return { domain, emailDomain: null, provider: null, hasMx: false, confidence: 'none', mx: [], signal: 'no-mx' };
  }
  const provider = classifyProvider(mx);
  return {
    domain,
    // Always the input domain: this checks deliverability, it does not find another domain.
    emailDomain: domain,
    provider: provider ?? 'other/self-hosted',
    hasMx: true,
    confidence: provider ? 'high' : 'medium',
    mx,
    signal: provider ? `provider-mx:${provider}` : 'mx-present',
  };
}
