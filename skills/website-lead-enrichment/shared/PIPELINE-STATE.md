# Pipeline state

Every stage reads and writes the same directory. `OUT_DIR` resolves to
`<project-root>/out`, or `LEADGEN_OUT_DIR` when set — point that at a scratch directory
to run against the sample input without touching real output.

## Layout

`out/` holds only what a salesperson opens: **three CSVs and a README**. Everything the
pipeline needs in order to run and resume lives under `out/.work/`.

```text
out/
├── ready-to-send.csv          real addresses — safe to send
├── company-inboxes.csv        published company inboxes — safe to send
├── verify-before-sending.csv  predictions — verify first
├── README.txt                 written every run; explains the three files
└── .work/
    ├── team-master.csv            THE pipeline state — every stage reads and rewrites it
    ├── run-summary.json           structured counts for the caller to report from
    ├── companies/<domain>.json    stage 2, one per company
    ├── ledgers/*.jsonl            resume state (table below)
    ├── team-page-candidates.csv   stage 1 report
    ├── business-emails.csv        stage 3 report
    ├── email-domains.csv          stage 6 report
    ├── company-email-patterns.json  stage 7 output, consumed by stage 8
    ├── permute-{input,wide,long}.csv  stage 8 working files
    └── .batch.lock
```

The split is about scale rather than tidiness: stage 2 writes one JSON per company, so a
flat `out/` on a 1,097-company run held 1,113 files with the deliverables lost among them.
Paths come from `lib/paths.ts` — `outPath()`, `workPath()`, `ledgerPath()` — never
hand-joined, so this layout has exactly one definition.

**`.work/` is not scratch.** It holds the master, so deleting it discards the whole run,
not just a cache. It is hidden because a user never needs to open it, not because it is
disposable.

## The master CSV

`out/.work/team-master.csv` — **one row per person, and only per person.** Stage 2 inserts
rows for people it found, so a company that named no staff has no row here at all. That is
why `company-inboxes.csv` is built from the stage 3/4 ledgers rather than from this file —
building it from master rows silently dropped every inbox-only company.

Stages upsert by normalized `domain + name`. Every writer rewrites it via `.tmp` +
`rename`, so a crash never leaves a half-written master.

Columns, grouped by what they mean:

| Group | Columns |
|---|---|
| identity | `company, domain, website, name, title` |
| real, scraped | `email, email_source_url, business_email, all_business_emails, business_email_source_url, related_email` |
| real, sourced | `web_found_email, web_found_source, web_found_confidence` |
| derived | `email_domain, mx_provider, best_email, best_email_basis, email_candidates` |

The two `*_source_url` columns are the page each address was read from — evidence, never
logic. Nothing branches on them; they exist so a buyer can check a claim.

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
| `learned:{last}.admin(ai)` | `<pattern>` may be a **template** over `{first} {last} {fi} {li}` when the company's own addresses show a style the 18 canonical names cannot express | prediction |
| `learned:<pattern>(unverified-domain)` | learned format, website domain only | prediction |
| `learned:<pattern>(ai)(unverified-domain)` | both caveats; suffixes concatenate in this order | prediction |
| `default:first.last` | rank-1 permutation, domain confirmed to receive mail | prediction |
| `default:first.last(unverified-domain)` | rank-1 permutation, website domain, no MX | prediction |
| `default:first` | single-token name, confirmed domain | prediction |
| `default:first(unverified-domain)` | single-token name, website domain | prediction |
| `no-domain` | no mail domain, or DNS says it accepts none; `best_email` empty | — |
| `no-name` | name yields no usable token; `best_email` empty | — |

Priority when more than one applies: `known` > `web-found` > `latest learned` > `default`.

## The three output files

Stage 8 writes all three, plus `README.txt` and `.work/run-summary.json`.

| File | Rows | Safe to send |
|---|---|---|
| `ready-to-send.csv` | people whose basis is `known` or `web-found:*` | **yes** |
| `company-inboxes.csv` | one row per company with a published inbox | **yes** — but it reaches the business, not a person |
| `verify-before-sending.csv` | basis `learned:*` or `default:*` | **no — verify first** |

The split exists so a prediction never reaches a sequencer by accident: sending unverified
guesses generates bounces and damages the sending domain.

Both person files carry the **same 13 columns**, so one saved column mapping works for
either and the two can be concatenated:

```
first_name, last_name, email, title, company, domain, website,
status, source, proof, business_email, all_business_emails, all_predicted_emails
```

`email` is the recommendation — the master's `best_email`. It is deliberately not the
master's `email` column, which holds only scraped addresses and is empty for most people;
anyone mapping a column called "email" from the old wide files sent an empty campaign.

`company-inboxes.csv` is built from the stage 3 and 4 **ledgers**, not from master rows,
because the master only ever gets a row when a person is found. A clinic that publishes
`info@clinic.com.au` and names no staff has no master row, and on a small-business list
those companies are most of the usable contacts.

### status, source, proof

Translated from `best_email_basis` by `lib/basis.ts` — one function, so the wording cannot
drift between the CSVs, the run summary, and what the caller says out loud.

| Basis | `status` | `source` | `proof` |
|---|---|---|---|
| `known` | Ready to send | Published on their website | the page it was read from |
| `web-found:<conf>` | Ready to send | Found on the web (<conf> confidence) | `web_found_source` |
| `learned:<p>` | Needs verification | Matches this company's email format | the real address the format came from |
| `learned:<p>(ai)` | Needs verification | …(AI-judged) | as above |
| `default:*` | Needs verification | Predicted — mail domain confirmed | *(blank)* |
| any `(unverified-domain)` | Needs verification | …mail domain not confirmed | *(blank)* |
| `no-domain` / `no-name` | *(neither file)* | — | — |

A blank `proof` on a prediction is the honest answer, not a missing value. There is
nothing to show.

People with no address of any kind appear in neither file; their count is in the run
summary so the caller can report the gap rather than let it vanish.

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
compacted; readers take last-write-wins. Every `.jsonl` below lives in
`out/.work/ledgers/`; `company-email-patterns.json` is not a ledger and sits directly in
`out/.work/`.

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

`out/.work/.batch.lock` is a single-writer PID lock, but only stage 2 takes it. Every other
master-rewriting stage ignores it, so **do not run two master-writing stages at once** —
they will clobber each other's rewrite. Run stages in sequence.

## Row-index coupling

Stage 5's ledger keys on the *positional row index* of the master as parsed, and
`parseCsv` drops all-blank rows. Any operation that inserts, deletes, or reorders master
rows silently invalidates every stage-5 ledger entry — nothing validates name or domain
on re-merge. The pipeline stages all preserve row order and count; hand-editing the
master does not.
