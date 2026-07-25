# Pipeline state

Every stage reads and writes the same directory. `OUT_DIR` resolves to
`<project-root>/out`, or `LEADGEN_OUT_DIR` when set — point that at a scratch directory
to run against fixtures without touching real output.

## The master CSV

`out/team-master.csv` — one row per person, plus one row per company that had no people.
Stages upsert by normalized `domain + name`. Every writer rewrites it via `.tmp` +
`rename`, so a crash never leaves a half-written master.

Columns, grouped by what they mean:

| Group | Columns |
|---|---|
| identity | `company, domain, website, name, title` |
| real, scraped | `email, business_email, all_business_emails, related_email, other_contact_emails` |
| real, sourced | `web_found_email, web_found_source, web_found_confidence` |
| derived | `email_domain, mx_provider, best_email, best_email_basis, email_candidates` |

`email` is a personal address visibly attributable to that person. `business_email` is a
company inbox. They are never merged — that separation is what makes the honesty contract
checkable.

## best_email_basis

`best_email` is a single recommendation; `best_email_basis` says how much to trust it.
These are the only values any stage may write:

| Basis | Meaning | Real address? |
|---|---|---|
| `known` | scraped from the company's own site | yes |
| `web-found:high` / `:medium` / `:low` | sourced on the open web with a URL | yes |
| `learned:<pattern>` | company's learned format, confirmed mail domain | prediction |
| `learned:<pattern>(ai)` | format judged by the model rather than matched | prediction |
| `learned:<pattern>(unverified-domain)` | learned format, website domain only | prediction |
| `learned:<pattern>(ai)(unverified-domain)` | both caveats; suffixes concatenate in this order | prediction |
| `default:first.last` | rank-1 permutation, domain confirmed to receive mail | prediction |
| `default:first.last(unverified-domain)` | rank-1 permutation, website domain, no MX | prediction |
| `default:first` | single-token name, confirmed domain | prediction |
| `default:first(unverified-domain)` | single-token name, website domain | prediction |
| `no-domain` | no mail domain, or DNS says it accepts none; `best_email` empty | — |
| `no-name` | name yields no usable token; `best_email` empty | — |

Priority when more than one applies: `known` > `web-found` > `latest learned` > `default`.

## The four output files

Stage 8 writes all four:

| File | Rows | Safe to send |
|---|---|---|
| `team-master.csv` | everyone, every column | mixed — read the basis |
| `verified-real.csv` | people whose basis is `known` or `web-found:*` | **yes** |
| `company-inboxes.csv` | one row per company with a `business_email` or `related_email` | **yes** — but it reaches the business, not a person |
| `predicted-unverified.csv` | basis `learned:*` or `default:*` | **no — verify first** |

The split exists so a prediction never reaches a sequencer by accident: sending unverified
guesses generates bounces and damages the sending domain.

`company-inboxes.csv` exists because the person-level split would otherwise hide most of
the real contacts. A company that publishes only `info@clinic.com.au` and names no staff
produces rows with an empty `best_email` and basis `no-name` — they appear in neither
person-level file, yet the inbox is a genuine lead. On a list of small businesses these
outnumber personal addresses by roughly ten to one.

People with no address of any kind appear only in the master.

"Confirmed" means a domain demonstrably receives mail — either a real business address
lives there, or it has MX records. It does **not** mean the specific mailbox exists.
Nothing in this pipeline verifies deliverability; SMTP/catch-all checking is downstream.

## Domain priority

When predicting, the domain is chosen strictly: `business_email` domain > MX
`email_domain` > website domain. The first two are confirmed; the third is a guess and
forces an `(unverified-domain)` basis. Never permute across two domains — a confirmed
mail domain wins outright.

## Ledgers and resume

Each stage appends one JSON line per unit of work and skips completed units on re-run, so
an interrupted batch resumes rather than restarting. Ledgers are append-only and never
compacted; readers take last-write-wins.

| File | Written by | "Done" means | Retries |
|---|---|---|---|
| `team-page-rank.jsonl` | 1 discover-team-pages | record present | on error |
| `extract-ledger.jsonl` | 2 extract-team-members | record present | on error |
| `business-email-ledger.jsonl` | 3 harvest-business-emails | record present | errors retry |
| `related-email-ledger.jsonl` | 4 recover-related-emails | line with falsy `error` | errors retry |
| `web-search-ledger.jsonl` | 5 discover-web-emails | line with `rowId`, no `error` | only hard errors |
| `email-domain-cache.jsonl` | 6 resolve-email-domains | `confidence !== 'error'` | only `error` |
| `company-email-patterns.json` | 7 learn-email-patterns | — no ledger — | — |

Two behaviours worth knowing before you re-run a stage:

- **Stage 5 records negatives permanently.** A `not_found` or `mismatch` result counts as
  done and is never retried. Only hard errors come back around.
- **Stage 7 has no ledger**, but it *merges* into `company-email-patterns.json` rather
  than replacing it, so a run can only add or refresh a company's pattern. `--no-ai` is
  safe: it keeps everything the model worked out on earlier runs.

## Concurrency

`out/.batch.lock` is a single-writer PID lock, but only stage 2 takes it. Every other
master-rewriting stage ignores it, so **do not run two master-writing stages at once** —
they will clobber each other's rewrite. Run stages in sequence.

## Row-index coupling

Stage 5's ledger keys on the *positional row index* of the master as parsed, and
`parseCsv` drops all-blank rows. Any operation that inserts, deletes, or reorders master
rows silently invalidates every stage-5 ledger entry — nothing validates name or domain
on re-merge. The pipeline stages all preserve row order and count; hand-editing the
master does not.
