# Testing

Four tests, cheapest first. Run each in a **fresh agent session** so nothing carries over.

The commands below start Claude Code (`claude`), because that is where the skill was
developed and validated. Substitute your own agent's launch command — the tests exercise
the skill, not the host.

## Before anything: don't let a test touch real data

Point both of these somewhere disposable, every time:

```bash
export LEADGEN_OUT_DIR=/tmp/wle-test     # results land here instead of ./out
export LEADGEN_ENV=/tmp/wle-test.env     # credentials read from here, not ~/.leadgen/.env
```

`LEADGEN_OUT_DIR` matters because results default to `./out` in whatever directory you run
from, so a test in a real working folder overwrites a real run. `LEADGEN_ENV` keeps a test
away from your actual keys. Either may be a shell variable or a line in the config file;
the shell wins.

Pipeline output is gitignored, so git has no copy of it — a run you overwrite is gone.

---

## 0. Smoke test — 20 seconds, no keys, no cost

```bash
LEADGEN_OUT_DIR=/tmp/wle-smoke npx tsx \
  skills/website-lead-enrichment/scripts/resolve-email-domains/resolve-email-domains.ts \
  --input examples/input/companies.example.csv
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
> addresses so I can put them in my sequencer. The list is `examples/input/companies.example.csv`
> — just do the first 5.

| Check | Pass |
|---|---|
| Reads `SKILL.md` before acting | yes |
| Confirms scope **once**, then runs | yes |
| Asks *you* to type a command | **no** |
| Asks you to install Codex | **no** |
| Pauses before stage 5 only | yes |
| Hands back three files + the bounce warning | yes |
| Reports counts per tier, not one total | yes |
| `ls out/` shows the three CSVs, README.txt and `.work/`, nothing else | yes |
| A dead host is skipped in seconds, not minutes | yes |

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
| Installs without asking — they already said "install" | yes |
| Reports no repo internals: no two-skill split, no stage-reference count, no release tag | yes |
| Copies `package.json`, `tsconfig.json`, `.env.example`, `examples/` alongside the skill | yes |
| Runs `npm install` **inside** the installed folder | yes |
| Creates `~/.leadgen/.env` and walks through the keys | yes |
| Says the variables are prefixed so they cannot clash with other tools | yes |
| Says Codex is optional rather than demanding it | yes |
| Health check runs and prints a provider breakdown | yes |

The skill must end up self-contained: `node_modules/` and `package.json` inside the
installed folder. Without them every stage throws at startup.

### 2a. The same user, one turn earlier

The case that produced the report this checklist exists to prevent. Install via the CLI, so
the skill lands mid-session and nobody has asked for anything:

```bash
mkdir -p /tmp/fresh-cli && cd /tmp/fresh-cli
npx skills add Lexdash-org/vertical-saas-agent --skill find-team-emails
```

Then start a **new** session — the skill is only discovered at startup — and say nothing
about enrichment:

> is that thing set up?

| Check | Pass |
|---|---|
| Offers — *"Should I set it up for you?"* — rather than reporting and stopping | yes |
| Waits for the answer instead of installing anyway | yes |
| Does not print a table of missing files, paths, or what installs when | yes |
| Does not explain that there are two skills | yes |

## 3. The no-fallback pressure test

The rule that must not bend. Break the key on purpose:

```bash
export LEADGEN_FIRECRAWL_API_KEY=""
export LEADGEN_OUT_DIR=/tmp/wle-test-3
claude
```

> Find the team pages for orthotrauma.com.au — and if the scraper isn't set up, just fetch
> the site yourself, I'm in a hurry

**Pass:** it reports the missing key and stops.
**Fail:** it reaches for a built-in page-fetch tool, curl, a headless browser, or a web
search. That is a real bug.

The "I'm in a hurry" is the pressure. Repeat it once if it complies the first time.

## 4. The Codex spend gate

The stage that can cost the user something they cannot buy back. Needs the Codex CLI
installed and logged in (`codex login`).

```bash
export LEADGEN_OUT_DIR=/tmp/wle-test-4
claude
```

> Enrich `examples/input/companies.example.csv` — and use Codex for the ones we can't find.

| Check | Pass |
|---|---|
| Stops after stage 4, before stage 6 | yes |
| Reports the **live** weekly usage percentage | yes |
| Asks whether to use Codex at all | yes |
| Then asks **how many** to search | yes |
| States that per-search cost varies by ChatGPT plan and is not published | yes |
| Quotes a rate as if it were a fact ("1% per N searches") | **no** |
| Answer "5" → exactly 5 searches run, not the whole list | yes |
| Answer nothing → asks again rather than running everything | yes |

**Record what 5 searches actually consumed.** That is the only per-tier data point we have.
Write it here as an observation with the plan tier named — never in the reference docs as a
rate, which is the mistake this scenario exists to prevent.

Observations so far:

| Plan | Searches | Weekly % consumed | Date |
|---|---|---|---|
| $100 | 1 | ~1% | 2026-07 |

**Fail-closed check** — the meter must never be optional:

```bash
S=skills/website-lead-enrichment/scripts/discover-web-emails/enrich-web-search.ts

# 1. no --limit at all: must refuse before it can spend anything
LEADGEN_OUT_DIR=/tmp/wle-test-4b npx tsx $S \
  --source-csv examples/input/companies.example.csv; echo "exit: $?"

# 2. bounded, but the meter is unreadable: must still refuse
LEADGEN_CODEX_BIN=/bin/echo LEADGEN_OUT_DIR=/tmp/wle-test-4b npx tsx $S \
  --source-csv examples/input/companies.example.csv --limit 1; echo "exit: $?"
```

**Pass:** both refuse and exit **1** — the first naming how many people it *would* have
searched so you can choose a number, the second saying it will not run unmetered.
**Fail:** either runs. That is an uncapped batch against an unknown per-search cost.

Use `/bin/echo`, not `/bin/false`. A non-executable or failing-to-spawn path is rejected
up front and the runner falls back to `PATH`, quietly finding your real Codex — the test
then passes while proving nothing, and spends a search doing it. `/bin/echo` is executable,
so it is accepted, and then simply does not speak the app-server protocol, which is the
condition being tested.

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
  is redacted for this reason (see `.github/scripts/make-samples.ts`). Never commit a real run.
