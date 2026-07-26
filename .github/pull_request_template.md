## What this changes

<!-- One or two sentences. If it changes agent behaviour, say what the agent will now
     do differently. -->

## Why

<!-- Link an issue if there is one. -->

## Verification

- [ ] `npm run check` passes (SKILL.md spec compliance + project invariants)
- [ ] `npm run typecheck` passes
- [ ] `npx tsc --noEmit --noUnusedLocals` passes
- [ ] Smoke test runs (keyless, DNS only):
      `LEADGEN_OUT_DIR=/tmp/wle-smoke npx tsx skills/website-lead-enrichment/subskills/resolve-email-domains/scripts/resolve-email-domains.ts --input examples/input/companies.example.csv`
- [ ] If this touches how the agent is instructed, I ran the relevant scenario in
      [TESTING.md](../TESTING.md) and said which one below.

<!-- Which scenario, and what happened: -->

## Checks that are easy to miss

- [ ] No API key, `.env`, real lead list, or enrichment output is in this diff.
- [ ] Any new `best_email_basis` value is documented in `shared/PIPELINE-STATE.md`.
      A prediction must never be able to surface as `known` or `web-found`.
- [ ] Email patterns were changed in `shared/lib/patterns.json` only — never in a copy
      inside `patterns.ts`, `permute.ts`, or a model prompt.
- [ ] No stage was given a browser, a general web search, or `curl` as a fallback for a
      configured provider.
- [ ] Paths referenced in any `SKILL.md` still resolve.
