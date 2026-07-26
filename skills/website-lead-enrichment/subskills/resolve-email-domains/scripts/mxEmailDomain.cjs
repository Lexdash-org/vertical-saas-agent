// mxEmailDomain.js
// Cost-free email-domain predictor: a domain's "email domain" is whichever
// domain has valid MX records pointed at a real mail provider.
// Pure DNS (native + DoH fallback). No paid API, no key, no rate-limited vendor.
//
//   const { resolveEmailDomain, normalizeDomain } = require('./mxEmailDomain');
//   await resolveEmailDomain('sixfold.ai');
//   => { domain, emailDomain, provider, hasMx, confidence, mx, signal }

const dns = require('dns').promises;
const https = require('https');

// Use reliable public resolvers; avoids flaky local resolver / VPN DNS.
try { dns.setServers(['1.1.1.1', '8.8.8.8', '9.9.9.9']); } catch (_) {}

// ---- MX hostname -> mail provider fingerprints ----------------------------
const PROVIDERS = [
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

function classifyProvider(mxHosts) {
  for (const host of mxHosts) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    for (const [re, name] of PROVIDERS) if (re.test(h)) return name;
  }
  return null;
}

// ---- domain normalization -------------------------------------------------
function normalizeDomain(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '');     // strip scheme
  s = s.replace(/[/?#].*$/, '');          // strip path/query/hash
  s = s.replace(/:\d+$/, '');             // strip port
  s = s.replace(/^www\d?\./, '');         // strip leading www / www2
  s = s.replace(/\.$/, '');               // strip trailing dot
  if (!s.includes('.') || /\s/.test(s)) return null;
  return s;
}

// ---- DoH fallback (Cloudflare then Google) --------------------------------
function dohQuery(name, type) {
  const endpoints = [
    `https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
  ];
  function hit(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { accept: 'application/dns-json' }, timeout: 6000 }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }
  return hit(endpoints[0]).catch(() => hit(endpoints[1]));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('dns-timeout')), ms)),
  ]);
}

async function lookupMx(domain) {
  // native first
  try {
    const recs = await withTimeout(dns.resolveMx(domain), 6000);
    if (recs && recs.length) {
      return recs.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
    }
    return [];
  } catch (e) {
    const code = e && e.code;
    // NODATA / NXDOMAIN are authoritative "no MX" — trust them, no DoH needed.
    if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
    // SERVFAIL / timeout / other => try DoH before giving up.
    try {
      const j = await dohQuery(domain, 'MX');
      if (j && j.Status === 3) return []; // NXDOMAIN
      const ans = (j && j.Answer) || [];
      const mx = ans
        .filter((a) => a.type === 15)
        .map((a) => String(a.data).replace(/^\d+\s+/, '').replace(/\.$/, ''))
        .filter(Boolean);
      return mx;
    } catch (_) {
      return { error: code || 'dns-error' };
    }
  }
}

// ---- main -----------------------------------------------------------------
// confidence:
//   high   -> domain has MX at a recognized mail provider  (email domain = domain)
//   medium -> domain has MX but provider unrecognized/self-hosted
//   none   -> no MX (leave for a lead source)
//   error  -> DNS failed (transient; retry later)
async function resolveEmailDomain(rawDomain) {
  const domain = normalizeDomain(rawDomain);
  if (!domain) return { domain: null, raw: rawDomain, confidence: 'invalid', signal: 'unparseable-domain' };

  const mx = await lookupMx(domain);
  if (mx && mx.error) {
    return { domain, emailDomain: null, provider: null, hasMx: null, confidence: 'error', mx: [], signal: mx.error };
  }
  if (!mx.length) {
    return { domain, emailDomain: null, provider: null, hasMx: false, confidence: 'none', mx: [], signal: 'no-mx' };
  }
  const provider = classifyProvider(mx);
  return {
    domain,
    emailDomain: domain,
    provider: provider || 'other/self-hosted',
    hasMx: true,
    confidence: provider ? 'high' : 'medium',
    mx,
    signal: provider ? `provider-mx:${provider}` : 'mx-present',
  };
}

module.exports = { resolveEmailDomain, normalizeDomain, classifyProvider, lookupMx };
