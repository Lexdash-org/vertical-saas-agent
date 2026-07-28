# Working on this repo

<!-- Kept byte-identical to AGENTS.md below the title; CI enforces it.
     Two filenames because the runtimes disagree on where to look —
     Claude Code reads CLAUDE.md, Codex and others read AGENTS.md. -->

Instructions for a coding agent contributing to **this repository**. If you are looking for
how to *use* the tool, read the [README](README.md) instead.

This project ships an agent skill that turns a list of company websites into the people who
work there and their email addresses. Several of its conventions are load-bearing in ways
that are not obvious from a diff — the ones below are the ones worth knowing before you
change anything.

## Verify with

```bash
npm run check      # SKILL.md spec compliance + the project invariants
npm run typecheck  # tsc --noEmit
npx tsc --noEmit --noUnusedLocals
```

`npm run check` covers SKILL.md spec compliance, the project invariants, and the routing
evals. CI runs exactly these, plus an **install job** on Linux, macOS and Windows that
installs the skill the way a user does and runs the health check — the install path is the
product now, and two bugs reached the repo before that job existed.

A green local run and a red CI run should not be possible.

Free, keyless smoke test — no credentials, no credits, DNS only:

```bash
LEADGEN_OUT_DIR=/tmp/wle-smoke npx tsx \
  skills/website-lead-enrichment/scripts/resolve-email-domains/resolve-email-domains.ts \
  --input examples/input/companies.example.csv
```

## The rules that matter

**A prediction must never be able to look like a fact.** This is the whole product.
`best_email_basis` separates real addresses (`known`, `web-found:*`) from guesses
(`learned:*`, `default:*`), and the output files are split on it. A guess reaching a
sequencer generates bounces and damages someone's sending domain. If you add a basis value,
document it in `references/pipeline-state.md` and make sure it routes to the right file — a CI
invariant asserts only real addresses can reach `ready-to-send.csv`.

**No fallbacks for a missing provider.** If a credential is absent, the stage reports it and
stops. It does not reach for `curl`, a headless browser, the agent's own fetch tool, or a
web search. Those produce a different, worse result that *looks* identical, so the user
cannot tell the run degraded.

**One source of truth for email patterns, and for the role-inbox vocabulary.** The 18
canonical patterns live in `scripts/lib/patterns.json`; the `info@`/`reception@` tests live in
`scripts/lib/emails.ts`. Both had hand-maintained copies once, and both drifted — `reception1@`
was a role inbox to stage 3 and an ordinary address to stage 4. CI now fails on a second copy.

**`scripts/lib/env.ts` is the only file that may name an environment variable.** Everything
else calls `readEnv('zyteKey')`. A mistyped name must be a compile error, not a runtime
"key not set" — which is indistinguishable from a user who never configured anything. CI
rejects a hard-coded name anywhere else.

**A caught error may never be printed or stored raw.** `scripts/lib/redact.ts` is the one
redactor; stages exit through `reportFatal`, record failures through `brief`, and write
ledgers through `appendLedger` — which redacts the error-bearing fields and nothing else,
because a whole-record redact would elide the `sourceUrl` that is the proof beside an
address. A provider's
own 401 body can quote the key back — OpenAI's gives up the first eight and last four
characters — and that text reaches three places at once: the console, the ledgers and
failures CSV on disk, and the extraction agent's tool output, which sends it to the model.
Sanitising only what is displayed leaves the other two. CI rejects `console.error(err)` and
raw `.message` extraction anywhere else.

**TypeScript only.** Every script is `.ts`, run through `tsx`. No build step, no
`.js`/`.mjs`/`.cjs`, no Python. A contributor should never have to work out which runtime a
file needs.

**Skills stay portable.** Write "run the script", not the name of one agent's tool. CI
rejects host-specific tool names inside a `SKILL.md`.

**Keep skill descriptions under 500 characters.** A host with many skills installed
truncates them to fit its context budget, and truncation eats the tail — which is where the
`NOT for:` clauses live. Losing those is what makes a skill fire on requests it should
decline.

**Stages are resumable and single-writer.** Each appends to a ledger and skips completed
work. Only one stage may write `out/.work/team-master.csv` at a time.

## Layout

```text
skills/find-team-emails/           the only published skill: sets up, then runs
skills/website-lead-enrichment/    the pipeline it installs
  SKILL.md                         the router — orchestration only
  references/NN-<stage>.md         one per stage, numbered in pipeline order
  references/providers.md          credentials + the no-fallback rule, stated once
  references/pipeline-state.md     out/ contract, basis vocabulary, ledgers
  scripts/<stage>/                 that stage's tools
  scripts/lib/                     code shared across stages
.github/scripts/                   validate-skills, check-invariants, make-samples
evals/                             which requests should and should not fire the skill
examples/input | examples/output   sample input, and what a run produces
```

**Only `SKILL.md`, `references/` and `scripts/` — the three directories the Agent Skills
specification names.** Stages are reference documents, not nested skills, and that is not
cosmetic: while the stage docs were named `SKILL.md`, `skills add --full-depth` discovered
ten installable skills instead of two. A user could install `email-permutation` on its own,
where it would run without the domain-priority rules the pipeline gives it.

## Testing

**Always redirect both of these**, or a test will read your real credentials and overwrite
real output:

```bash
export LEADGEN_ENV=/tmp/test.env      # instead of ~/.leadgen/.env
export LEADGEN_OUT_DIR=/tmp/test-out  # instead of ./out in the current folder
```

Credentials live in `~/.leadgen/.env`, not in the repo. Results default to `./out` in
whatever directory the user runs from.

The unit suite is new and small: `npm test` runs `node --test` over
`scripts/lib/*.test.ts`, and `redact.test.ts` is the only file in it so far. The glob is
shell-expanded and single-level on purpose — `node --test` only learned to expand `**`
itself in Node 21, and `engines` says 20.
Growing it is the most useful contribution available. Start with the rest of
`scripts/lib/` — it is pure and has no I/O. Behaviour of a function belongs there, not in
`check-invariants.ts`, which is for facts about the shape of the repo that a test cannot
see: no second copy of the pattern table, no hard-coded environment variable name.

If your change affects how the *agent* behaves rather than what the code computes, run the
matching scenario in [TESTING.md](TESTING.md) and say what happened. That is the only way
to check routing.

## Never

- Commit a key, a `.env`, a real lead list, or pipeline output. This tool collects contact
  details about identifiable people; treat every run's output as personal data.
- Add a network fallback to a stage whose provider is unconfigured.
- Let a predicted address surface with a `known` or `web-found` basis.
- Add a second copy of the pattern table, the role-inbox regex, or the CSV parser.
- Hardcode a personal path or a private file as a default `--input`.
- Write a credential into `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, or suggest putting one in
  a shell profile. A key under a shared name silently switches an agent from the
  subscription the user pays for to API billing.

More detail, and the PR checklist, in [CONTRIBUTING.md](CONTRIBUTING.md).
