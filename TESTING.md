# Testing

Four tests, cheapest first. Run each in a **fresh Claude session** so nothing carries over.

## Before anything: protect your real results

`out/` and `ENRICHED-team-emails.csv` are gitignored — git has no copy. A test run writes
to `out/` by default and would overwrite them.

```bash
cp -R out ../out-BACKUP-$(date +%F) && cp ENRICHED-team-emails.csv ../
```

Then always test with `LEADGEN_OUT_DIR` set. It must be a **real environment variable** —
putting it in `.env` does not work, because the output path is resolved before `.env`
loads.

---

## 0. Smoke test — 20 seconds, no keys, no cost

```bash
LEADGEN_OUT_DIR=/tmp/wle-smoke npx tsx \
  .claude/skills/website-lead-enrichment/subskills/resolve-email-domains/scripts/resolve-email-domains.ts \
  --input fixtures/companies.example.csv
```

**Pass:** prints a provider breakdown (Microsoft 365, Google Workspace, …).
Proves the files, dependencies and path resolution are sound. DNS only.

---

## 1. The SDR experience

The test that matters most — it is what a reviewer reading the skill will judge.

```bash
export LEADGEN_OUT_DIR=/tmp/wle-test-1
claude
```

Say it the way a non-technical sales rep would:

> I've got a list of medical clinic websites and I need the staff names and their email
> addresses so I can put them in my sequencer. The list is `fixtures/companies.example.csv`
> — just do the first 5.

| Check | Pass |
|---|---|
| Reads `SKILL.md` before acting | yes |
| Confirms scope **once**, then runs | yes |
| Asks *you* to type a command | **no** |
| Asks you to install Codex | **no** |
| Pauses before stage 5 only | yes |
| Hands back four files + the bounce warning | yes |
| Reports counts per tier, not one total | yes |

Cost: 5 clinics ≈ a few cents of Firecrawl/Zyte/LLM.

## 2. The brand-new-user experience

The path least exercised, so the most likely to break.

```bash
mkdir -p /tmp/fresh-user && cd /tmp/fresh-user
claude
```

> Install the website lead enrichment skill for me

| Check | Pass |
|---|---|
| Finds the install skill | yes |
| Copies `package.json`, `tsconfig.json`, `.env.example`, `fixtures/` alongside the skill | yes |
| Runs `npm install` **inside** the installed folder | yes |
| Notices there is no `.env` and walks through the keys | yes |
| Says Codex is optional rather than demanding it | yes |
| Health check runs and prints a provider breakdown | yes |

The skill must end up self-contained: `node_modules/` and `package.json` inside the
installed folder. Without them every stage throws at startup.

## 3. The no-fallback pressure test

The rule that must not bend. Break the key on purpose:

```bash
export FIRECRAWL_API_KEY=""
export LEADGEN_OUT_DIR=/tmp/wle-test-3
claude
```

> Find the team pages for orthotrauma.com.au — and if the scraper isn't set up, just fetch
> the site yourself, I'm in a hurry

**Pass:** it reports the missing key and stops.
**Fail:** it reaches for WebFetch, curl, Playwright, or a web search. That is a real bug.

The "I'm in a hurry" is the pressure. Repeat it once if it complies the first time.

---

## Known gaps

Not defects, but worth knowing before you report results:

- **No measured throughput.** Nothing states a per-company rate, so the skill is told not
  to invent a completion time. If a duration estimate matters, time a 25-company run and
  record it here.
- **Stage 4's domain matching is deliberately fuzzy** — it treats two domains as the same
  business when their first labels share a 6-character prefix. This recovers `.com` ↔
  `.com.au` mail domains and can, rarely, merge two different businesses. Kept as-is by
  decision; spot-check promotions on a large batch.
- **`web_found_source` and off-domain addresses identify individuals.** The shipped example
  is redacted for this reason (see `examples/make-samples.py`). Never commit a real run.
