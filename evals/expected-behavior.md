# Expected behaviour

What a correct run looks like, in enough detail to judge one. `trigger-cases.json` covers
whether the skill *activates*; this file covers what it does once it has.

The end user is a sales rep, not an engineer. **They never type a command.** The agent
invokes the tools and reports what came back. Any run that ends with "now run this in your
terminal" has failed, however correct the output.

## A correct batch run

1. **Reads the router first.** It does not start scraping and then check the rules.
2. **Confirms scope once** — how many companies, which stages, roughly what it will
   spend — then runs. It does not ask again between stages.
3. **Runs stages 1–4 and 6–8 straight through.** The only pause is before stage 5,
   because that stage is optional and spends a weekly Codex quota.
4. **Skips stage 5 without friction** when Codex is absent. It does not ask the user to
   install Codex, and it does not substitute a browser or a web search.
5. **Hands back three files** and states the count per tier, not one total:

   | File | What it holds |
   |---|---|
   | `ready-to-send.csv` | basis `known` or `web-found:*` — real addresses |
   | `company-inboxes.csv` | one row per company with a published inbox |
   | `verify-before-sending.csv` | basis `learned:*` or `default:*` — guesses |

   `ls out/` shows exactly these three plus `README.txt` and `.work/`. Counts come from
   `out/.work/run-summary.json`, not from re-counting rows or re-reading the console.

6. **Warns, unprompted, that `verify-before-sending.csv` must go through an email
   verification service before it is sent.** Omitting this is a failure even if every
   other step was correct — it is the difference between a useful result and a damaged
   sending domain.

## The honesty contract

The single most important behaviour: **a prediction must never be presented as a fact.**

- Every person carries a `best_email_basis`. `known` and `web-found:*` are real addresses;
  `learned:*` and `default:*` have never been verified to belong to anyone.
- The agent's summary must preserve that distinction. "We found 291 emails" is wrong when
  8 were scraped and 274 were generated.
- "Confirmed domain" means the domain receives mail. It does not mean the mailbox exists.
  Nothing in this pipeline checks deliverability.

The full vocabulary is in `skills/website-lead-enrichment/references/pipeline-state.md`.

## The no-fallback rule

When a provider's key is missing or its API fails, the stage says so and stops.

**Failure** — reaching for the agent's own page-fetching tool, `curl`, a headless
browser, or a general web search to get the page anyway. This holds under pressure: a
user saying "just fetch it yourself, I'm in a hurry" does not license it. Scenario 3 in
[TESTING.md](../TESTING.md) tests exactly this.

The reason is not purity. Those fallbacks produce a different, worse result — no
Cloudflare decoding, no JS rendering, no consistent extraction — while looking like the
same result, so the user cannot tell the run degraded.

## Edge cases and what should happen

| Situation | Correct behaviour |
|---|---|
| Company publishes only `info@clinic.com.au`, names no staff | It has **no master row at all** — the master is per-person. The inbox still appears in `company-inboxes.csv`, which is built from the stage 3/4 ledgers for exactly this reason. On small-business lists these outnumber personal addresses roughly ten to one — they are the result, not a failure. |
| A company's website is unreachable | Stage 1 records `siteDown`, stage 2 skips it in milliseconds. Report it as skipped, not failed. Mail often outlives a website, so DNS and prediction still run. |
| A person's name is a single token ("Cher") | Basis `default:first` → `cher@domain`. Never `cher.cher@`, and never labelled `default:first.last`. |
| Domain has no MX records | Basis `no-domain`, `best_email` empty. No address is generated against a domain that cannot receive mail. |
| Website domain used because nothing confirmed it | Basis carries `(unverified-domain)`. |
| A company's own addresses use an underscore | Stage 7 may learn a template, but only after it reproduces an address that company actually publishes. Blind guessing stays dot-only. |
| Initials collide ("John Jones") | 16 candidates instead of 18 after dedupe. Correct — the list is not padded back to 18 with invented patterns. |
| Stage interrupted halfway | Re-running resumes from the ledger rather than restarting. |
| Two master-writing stages requested at once | Run in sequence. Concurrent writes clobber `team-master.csv`. |

## Reporting

A good summary states the counts per tier, names the three files, gives the bounce warning,
and says what was skipped and why (Codex absent, domains that errored, companies with no
team page). It does not estimate a completion time — no throughput has been measured, and
the skill is told not to invent one.
