---
name: install-website-lead-enrichment
description: Use when the website-lead-enrichment skill needs to be installed, updated, or repaired - the user asks to set it up, its folders are missing or incomplete, its dependencies are not installed, or a run fails because credentials were never configured.
---

# Install Website Lead Enrichment

Downloads the `website-lead-enrichment` skill, puts its folders in the right place,
configures credentials, and proves it works before handing over.

This skill only installs. It never enriches anything — once install finishes, the
`website-lead-enrichment` skill takes over.

## What gets installed

```text
<skills-dir>/website-lead-enrichment/
├── SKILL.md                 # the router
├── shared/                  # PROVIDERS.md, PIPELINE-STATE.md, lib/
├── subskills/               # eight stages, each with its own SKILL.md + scripts/
├── package.json             # the tools are TypeScript — deps live here
├── tsconfig.json
├── .env.example             # template for the user's .env
├── fixtures/                # sample input, used by the health check
└── node_modules/            # created by step 5
```

`<skills-dir>` is the host's global skills directory — `~/.claude/skills/` for Claude Code.
Install there, not into a project, so the skill is available everywhere.

**The last five entries are not optional.** The stages resolve their project root by
walking up for a `package.json`; without one they throw at startup and nothing runs. In the
development repo that file sits at the repo root, so it is easy to forget that an installed
copy needs its own. Steps 4 and 5 put it there.

## Steps

### 1. Check what is already there

If `<skills-dir>/website-lead-enrichment/SKILL.md` exists, this is an update or a repair,
not a fresh install. Tell the user which version is present (read `version.txt` if it
exists) and confirm before overwriting. Never silently replace a working install.

### 2. Download the release

```bash
REPO=Lexdash-org/vertical-saas-agent
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4)
curl -fsSL -o /tmp/wle.tar.gz "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
```

Fail loudly if either request 404s — that means no release is published yet, and the user
should install from a clone instead (step 2b). Do not fall back to cloning `main` silently;
an untagged tree is not a release.

**2b. From a clone**, when no release exists or the user already has the repo: copy
`.claude/skills/website-lead-enrichment/` out of the checkout into `<skills-dir>/`.

### 3. Verify the checksum

```bash
curl -fsSL -o /tmp/wle.sha256 "https://github.com/$REPO/releases/download/$TAG/checksums.txt"
shasum -a 256 -c /tmp/wle.sha256 --ignore-missing
```

If the checksum file is absent, say so plainly and ask the user whether to continue. Do not
present an unverified download as verified.

### 4. Assemble the install

The tarball contains the whole repo. Take the skill folder **plus the four files it needs
to run**, which live at the repo root:

```bash
tar -xzf /tmp/wle.tar.gz -C /tmp
SRC=$(echo /tmp/vertical-saas-agent-*)
DEST="$SKILLS_DIR/website-lead-enrichment"

mkdir -p "$DEST"
cp -R "$SRC/.claude/skills/website-lead-enrichment/." "$DEST/"
cp "$SRC/package.json" "$SRC/tsconfig.json" "$SRC/.env.example" "$DEST/"
cp -R "$SRC/fixtures" "$DEST/"
```

Then verify, and stop if anything is missing — a partial install is worse than none:

```bash
for f in SKILL.md package.json tsconfig.json .env.example \
         shared/lib/paths.ts fixtures/companies.example.csv; do
  [ -e "$DEST/$f" ] || echo "MISSING: $f"
done
ls "$DEST"/subskills/*/SKILL.md | wc -l   # must be 8
```

If anything is missing, remove `$DEST` entirely and report the failure. Do not leave a
half-installed skill in place.

### 5. Install the Node dependencies

The tools are TypeScript, run through `tsx`. Install inside the skill folder — the
`package.json` copied in step 4 is what makes the skill self-contained:

```bash
cd "$DEST" && npm install
```

`node_modules/` must end up inside `$DEST`. The stages find their root by walking up for a
`package.json`, so they will now resolve to `$DEST` and write their output to `$DEST/out/`.

Set `LEADGEN_OUT_DIR` if the user would rather results landed somewhere else — a project
folder, say — and `LEADGEN_ROOT` only if you deliberately point the skill at a different
checkout.

### 6. Configure credentials

Copy `.env.example` to `.env` and walk the user through it. Read
`website-lead-enrichment/shared/PROVIDERS.md` for what each key is for.

Required:

- `FIRECRAWL_API_KEY` — site mapping
- `ZYTE_API_KEY` — page fetching
- `LLM_API_KEY` (+ `LLM_BASE_URL` unless using OpenAI) and the two model names — any
  OpenAI-compatible provider. The Azure preset also works.

**Codex is optional.** If the user has no Codex CLI, say the open-web discovery stage will
be skipped and move on. Do not ask them to install it, and never write a key into
`OPENAI_API_KEY` — that variable must stay unset.

Never print a key back to the user, never echo `.env`, and never commit it.

### 7. Health check

Prove the install works before saying it is done. Run the two keyless stages against the
bundled fixture and a scratch output directory, so nothing real is touched:

```bash
cd "$DEST" && LEADGEN_OUT_DIR=/tmp/wle-check \
  npx tsx subskills/resolve-email-domains/scripts/resolve-email-domains.ts \
  --input fixtures/companies.example.csv
```

This uses only DNS — no credits, no keys, no network beyond MX lookups. It proves the
files landed, the dependencies resolve, and the root/output paths work. A provider
breakdown means the install is sound.

Then confirm the credentialed providers respond, one cheap call each, and report which are
live and which are missing. Do not run a full enrichment as a health check.

### 8. Hand over

Report: install location, version/tag, which providers are configured, whether Codex is
present, and the one-line way to start —

> "Enrich this list of company websites: `<path to csv>`"

## Rules

- Never overwrite an existing install without asking.
- Never present an unverified download as verified.
- Never leave a partial extract in place.
- Never print, echo, or commit a credential.
- A missing Codex is not a failed install.
