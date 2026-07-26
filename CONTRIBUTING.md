# Contributing

Thanks for looking. This is a small project with a specific shape, and a few of its
conventions are load-bearing in ways that are not obvious from the diff. Read the short
version below before you start.

## Getting set up

```bash
git clone https://github.com/Lexdash-org/vertical-saas-agent
cd vertical-saas-agent
npm install
mkdir -p ~/.leadgen && cp .env.example ~/.leadgen/.env   # then fill it in
```

You can do useful work without any credentials: stage 6 is plain DNS, stage 8 is string
generation, and everything in `shared/lib/` is pure.

## Repository layout

```text
skills/
├── website-lead-enrichment/          # the skill people install
│   ├── SKILL.md                      # the router — orchestration only
│   ├── shared/
│   │   ├── PROVIDERS.md              # the one copy of the credential contract
│   │   ├── PIPELINE-STATE.md         # out/ file contract, basis vocabulary, ledgers
│   │   └── lib/                      # code shared across stages, incl. patterns.json
│   └── subskills/                    # eight stages, each SKILL.md + scripts/
└── find-team-emails/                 # the ONLY published skill: sets up the above, then runs it

.github/scripts/                      # repo tooling: validate-skills, check-invariants,
                                      # make-samples (maintainer-only, see below)
evals/                                # when the skill should and should not fire
examples/
├── input/companies.example.csv       # sample input, safe to run against
└── output/enriched-sample.csv        # what a run produces, 50 verified addresses
```

`.github/scripts/make-samples.ts` regenerates both sample files, so the filter that
decides what ships is auditable rather than asserted. It reads two gitignored files and
therefore **cannot run from a clone** — it lives with the tooling rather than in
`examples/` so nobody mistakes it for something to run.

`skills/<name>/SKILL.md` is the portable location every runtime understands. The repo
deliberately keeps nothing under `.claude/` — to use the skill while developing, install
it into your agent's skills directory with the copy commands in the README.

**`subskills/` is deliberate.** The specification names `scripts/`, `references/` and
`assets/` as the standard optional directories, and requires only `SKILL.md`. Nested
subskills are how this project decomposes a long pipeline, and nested `SKILL.md` files are
not auto-discovered — which is the point. A stage should only ever run in pipeline order,
routed to by the parent.

## The conventions that matter

**One source of truth for email patterns.** The 18 canonical patterns live in
`shared/lib/patterns.json` and nowhere else. `patterns.ts` and `permute.ts` both derive
their builders from it, and the model prompt builds its allowed-list from it. There used
to be three hand-maintained copies; they drifted. Do not add a fourth.

**A prediction must never be able to look like a fact.** `best_email_basis` is the whole
honesty contract: `known` and `web-found:*` are real addresses, `learned:*` and
`default:*` are guesses. If you add a value, document it in `shared/PIPELINE-STATE.md`,
and make sure it lands in the right one of `ready-to-send.csv` /
`verify-before-sending.csv`. A guess reaching a sequencer generates bounces and damages
someone's sending domain.

**No fallbacks for a missing provider.** If a key is absent the stage reports it and
stops. It does not reach for `curl`, a headless browser, the agent's own page-fetching
tool, or a web search. This is a hard rule, tested in TESTING.md, and enforced in
CI for the skill text.

**TypeScript only.** Every script in the repo is `.ts`, run through `tsx` — no build step,
no `.js`/`.mjs`/`.cjs`, no Python. A contributor should never have to work out which runtime
a given file needs.

**Skills stay portable.** Write "run the script" rather than naming a specific agent's
tool. CI rejects host-specific tool names in a `SKILL.md`.

**Stages are resumable and single-writer.** Each appends to a ledger and skips completed
work on re-run. Only one stage may write `out/.work/team-master.csv` at a time. If you add a
stage, follow both patterns — `shared/PIPELINE-STATE.md` documents the existing ledgers,
including the two with surprising semantics.

## Verifying a change

```bash
npm run check                      # SKILL.md spec compliance + project invariants
npm run typecheck                  # tsc --noEmit
npx tsc --noEmit --noUnusedLocals  # also catches dead code
```

`npm run check` is the two scripts in `.github/scripts/`, and CI runs exactly the same
commands — nothing passes locally and fails there for a different reason.

Free, keyless smoke test — proves the paths and dependencies resolve:

```bash
LEADGEN_OUT_DIR=/tmp/wle-smoke npx tsx \
  skills/website-lead-enrichment/subskills/resolve-email-domains/scripts/resolve-email-domains.ts \
  --input examples/input/companies.example.csv
```

**There is no unit test suite yet**, which is the biggest gap in the project — the
invariant checks cover a few load-bearing behaviours, not the pipeline. Contributions
adding real tests are very welcome; start with `shared/lib/`, which is pure and has no
I/O. `evals/trigger-cases.json` records which requests should and should
not activate the skill; add a case there when you change a description.

If your change affects how the agent behaves rather than what the code computes, run the
matching scenario in [TESTING.md](TESTING.md) and say what happened in the PR. That is
the only way to check routing.

**Point `LEADGEN_ENV` at a throwaway config when testing**, so a test can never read or
write your real `~/.leadgen/.env`. `LEADGEN_OUT_DIR` may be set either in that file or as
a shell variable; the shell wins. Results otherwise land in `./out` wherever you are.

## Things that will get a PR sent back

- A key, a `.env`, a real lead list, or pipeline output in the diff.
- A new `process.env.SOMETHING` outside `shared/lib/env.ts` — CI rejects it.
- A new copy of the pattern table, the role-inbox regex, or the CSV parser.
- A predicted address that can surface with a `known` or `web-found` basis.
- A network fallback added to a stage whose provider is unconfigured.
- Hardcoded personal paths or a customer file as a default `--input`.

## Licence

Contributions are accepted under the MIT licence, the same as the project.
