# Website Lead Enrichment

Your accounts aren't in Apollo, ZoomInfo, or Clay — vertical markets never are. But their
staff are named on their own websites. Give this a list of company URLs and it returns
**the people and their email addresses**.

Validated on 1,097 Australian medical clinics, which produced 9,122 people.

[![skills.sh](https://skills.sh/b/Lexdash-org/vertical-saas-agent)](https://skills.sh/Lexdash-org/vertical-saas-agent)

## Install

```bash
npx skills add Lexdash-org/vertical-saas-agent --skill find-team-emails
```

One skill. Ask it for what you want and it installs the rest on first use, then runs.

The command above only places the skill. The pipeline and credentials are set up on first
use, so there is nothing to read and nothing to configure yet — say *"set up
find-team-emails"* and the skill takes it from there.

**If you are the agent that just ran that command:** you installed a file, not a working
tool, and this skill was not in your context while you did it — so report the install in one
line and offer to finish it. Do not describe the repository layout, the stage references, or
how skills are loaded; none of it helps someone who wants a list of emails.

Built and tested on **Claude Code and Codex**. The skill names no host-specific tools, so
any agent that reads `SKILL.md` and can run shell commands should work.

## Use

Give your agent a CSV with a website column and ask in plain language:

> Enrich this list of clinic websites — I need staff names and email addresses.
> `examples/input/companies.example.csv`

You never type a command; the agent runs the pipeline and reports back. You get three files:

| File | Contents | Safe to send? |
|---|---|---|
| `ready-to-send.csv` | people with a real address | **yes** |
| `company-inboxes.csv` | one published inbox per company | **yes** — reaches the business, not a person |
| `verify-before-sending.csv` | predictions | **no — verify first** |

> **Sending `verify-before-sending.csv` without running it through an email verification
> service will generate bounces and damage your sending domain.**

Every person carries a `best_email_basis` saying how much to trust the address:

```
known (scraped) > web-found (sourced, with a URL) > learned:<pattern> > default:first.last
```

That separation is the point. Scraped and sourced addresses are real; a `learned:` or
`default:` basis is **a guess nobody has verified**.

## How it works

Eight stages in three groups:

```
EXTRACT (real)                        DISCOVER (real)      PREDICT (the rest)
1. rank team pages    Firecrawl+LLM   5. open-web search   6. MX-confirm the mail domain
2. scrape people      Zyte+LLM           via Codex         7. learn the company's format
3. harvest inboxes    Zyte               (optional)        8. permute + rank candidates
4. recover cross-domain inboxes
```

Stage 5 is the only one that stops to ask. It spends a weekly Codex quota you cannot top up
with money, so it asks whether to use Codex at all and then **how many people to search** —
it never picks that number for you. What one search costs varies by ChatGPT plan and OpenAI
does not publish it, so it reports your live usage and lets you size the batch against it.

Every stage is resumable: re-running one picks up where it stopped.

## Requirements

| | |
|---|---|
| Node.js | 20+ |
| Firecrawl | API key — site mapping |
| Zyte | API key — page fetching |
| An LLM | any OpenAI-compatible endpoint |
| Codex CLI | **optional** — stage 5 only; skip it and the rest runs |

## Configure

One file in your home directory, so the same keys work from every folder and survive a
reinstall:

```bash
mkdir -p ~/.leadgen && cp .env.example ~/.leadgen/.env
```

Four values are required — `LEADGEN_FIRECRAWL_API_KEY`, `LEADGEN_ZYTE_API_KEY`,
`LEADGEN_LLM_API_KEY`, `LEADGEN_LLM_MODEL_REASONING`. The rest are optional and documented
in [`.env.example`](.env.example), including base URLs for OpenRouter, Together, Groq,
Ollama and Azure.

**Every name starts with `LEADGEN_` so it cannot collide with another tool.** Keep
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` unset: a key under a shared name silently switches
Claude Code and Codex from the subscription you pay for to API billing. This project reads
neither.

## Known limits

- **No unit test suite.** Invariant checks cover load-bearing behaviours, not the pipeline
  end to end.
- **Nothing verifies deliverability.** A confirmed mail domain accepts mail; it does not
  mean the mailbox exists.
- **Stage 5 hardcodes `Australia`** in its search location. It is optional, so the rest is
  unaffected — adapt it before using that stage elsewhere.
- **Stage 4 matches "same business, different domain" loosely** (6-character prefix) so
  `.com` ↔ `.com.au` mail domains are recovered. It can rarely merge two similarly-named
  businesses; spot-check large batches.

## Data and privacy

This tool collects business contact details about identifiable people, and predicts
addresses nobody has verified.

Pipeline output is never committed — `out/` is gitignored. The shipped
`examples/output/enriched-sample.csv` holds 50 addresses read directly off companies' own
websites, on their own domains; the filter that produced it is committed so it can be
audited. What you may lawfully do with collected data is governed by privacy and anti-spam
law where you and your targets are — GDPR, the Australian Privacy Act and Spam Act,
CAN-SPAM — not by this project's licence.

## More

| | |
|---|---|
| Manual install, layout, conventions, how to verify a change | [CONTRIBUTING.md](CONTRIBUTING.md) |
| End-to-end test scenarios | [TESTING.md](TESTING.md) |
| Credentials and the no-fallback rule | [providers.md](skills/website-lead-enrichment/references/providers.md) |
| Reporting a security issue | [SECURITY.md](SECURITY.md) |

Bugs: <https://github.com/Lexdash-org/vertical-saas-agent/issues> — include the stage, the
console output, your Node version and LLM provider. **Never paste `.env` contents, real
lead lists, or enrichment output into an issue.**

## License

MIT — see [LICENSE](LICENSE).
