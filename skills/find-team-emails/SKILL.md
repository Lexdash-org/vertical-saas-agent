---
name: find-team-emails
description: >-
  Use when someone has a list of company websites and wants the people who work there and
  their email addresses - "find the staff emails for these clinics", "get me contacts at
  these companies", "enrich this account list", "scrape team members from these sites",
  "I have domains but no emails". Handles first-time setup automatically when the tool is
  not installed or has no API keys yet, then runs the enrichment. NOT for: verifying that
  an address delivers, scraping one known page, or lists that already have the people.
license: MIT
metadata:
  author: Lexdash-org
  version: "1.0.0"
---

# Find Team Emails

Turns a CSV of company websites into named staff and their email addresses — for the case
where those contacts exist in no data vendor, only on the companies' own sites.

You run this for the user. They do not type commands; you invoke the tools and report what
came back. Most users are salespeople, not engineers.

## Step 1 — Triage before anything else

Setup is a means, not the goal. Check what is already there, then do only what is missing:

```bash
SKILLS_DIR="${HOME}/.claude/skills"; [ -d "$HOME/.claude" ] || SKILLS_DIR="$HOME/.agents/skills"
DEST="$SKILLS_DIR/website-lead-enrichment"

[ -f "$DEST/SKILL.md" ]      && echo "pipeline: present"     || echo "pipeline: MISSING"
[ -d "$DEST/node_modules" ]  && echo "deps: present"         || echo "deps: MISSING"
[ -f "$HOME/.leadgen/.env" ] && echo "credentials: present"  || echo "credentials: MISSING"
```

| State | What to do |
|---|---|
| all three present | **Say nothing about setup.** Go straight to *Running an enrichment*. |
| pipeline + deps, no credentials | Step 5 only, then run. |
| anything else missing | Steps 2–6, then run. |

After the first day the common case is "all present". Landing there must cost the user
nothing — no setup narration, no instructions, just the result they asked for.

## Step 2 — Node.js

Check first. An npm failure three steps later is a wall of text nobody can act on.

```bash
node --version 2>/dev/null || echo "not installed"
```

Node 20 or newer is required. If it is missing or older, **ask before installing anything**
— this is the only step that touches the machine outside this tool's own folders:

| Platform | Command |
|---|---|
| macOS | `brew install node` |
| Windows | `winget install OpenJS.NodeJS.LTS` |
| Debian/Ubuntu | `sudo apt install nodejs` |
| Fedora | `sudo dnf install nodejs` |

Never run a `sudo` command without showing it and getting a yes. If the package manager is
absent, or the user declines, point them at <https://nodejs.org> and stop — a stop with a
clear next step is a fine outcome; an unexplained npm crash is not.

## Step 3 — Find or fetch the pipeline

It may already be on disk: the skills CLI can place the whole repository, or the user may
have cloned it. Look before downloading.

```bash
for c in "$SKILLS_DIR/website-lead-enrichment" ./skills/website-lead-enrichment; do
  [ -f "$c/SKILL.md" ] && SRC_SKILL="$c" && break
done
```

**If found**, use it as the source for step 4 and skip the download.

**If not found**, fetch the tagged release:

```bash
REPO=Lexdash-org/vertical-saas-agent
TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4)
curl -fsSL -o /tmp/wle.tar.gz "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
curl -fsSL -o /tmp/wle.sha256 "https://github.com/$REPO/releases/download/$TAG/checksums.txt" \
  && shasum -a 256 -c /tmp/wle.sha256 --ignore-missing
tar -xzf /tmp/wle.tar.gz -C /tmp
```

Fail loudly if the release request 404s — that means no release is published and the user
should install from a clone instead. Do not silently fall back to the default branch; an
untagged tree is not a release. If the checksum file is absent, say so plainly and ask
whether to continue — never present an unverified download as verified.

## Step 4 — Assemble and install

One list drives both the copy and the check, so they cannot drift apart:

```bash
SRC=$(echo /tmp/vertical-saas-agent-*)     # or the checkout found in step 3
NEEDS="package.json tsconfig.json .env.example examples/input"

mkdir -p "$DEST"
cp -R "$SRC/skills/website-lead-enrichment/." "$DEST/"
for item in $NEEDS; do
  mkdir -p "$DEST/$(dirname "$item")"
  cp -R "$SRC/$item" "$DEST/$item"
done

fail=0
for item in SKILL.md shared/lib/paths.ts $NEEDS; do
  [ -e "$DEST/$item" ] || { echo "MISSING: $item"; fail=1; }
done
[ "$(ls "$DEST"/subskills/*/SKILL.md 2>/dev/null | wc -l)" -eq 8 ] || { echo "MISSING: subskills"; fail=1; }
[ "$fail" -eq 0 ] || { rm -rf "$DEST"; echo "install aborted"; exit 1; }

cd "$DEST" && npm install
```

A partial install is worse than none: on any missing entry remove `$DEST` entirely and
report, rather than leaving a folder that half works.

## Step 5 — Credentials

One file, in the user's home directory — not in a project, not inside the skill, so the
same keys work everywhere and survive a reinstall:

```bash
mkdir -p ~/.leadgen && cp "$DEST/.env.example" ~/.leadgen/.env
```

Walk them through the four required values:

- `LEADGEN_FIRECRAWL_API_KEY` — site mapping (firecrawl.com)
- `LEADGEN_ZYTE_API_KEY` — page fetching (zyte.com)
- `LEADGEN_LLM_API_KEY` and `LEADGEN_LLM_MODEL_REASONING` — any OpenAI-compatible endpoint.
  Add `LEADGEN_LLM_BASE_URL` for anything other than OpenAI; `.env.example` lists base URLs
  for OpenRouter, Together, Groq, Ollama and Azure.

Tell them why the names look like that, because it is what they are most likely to worry
about:

> Every variable starts with `LEADGEN_` so it cannot clash with another tool. Keep
> `OPENAI_API_KEY` unset — if it is set, Codex bills that key instead of using the ChatGPT
> subscription you already pay for. The same goes for `ANTHROPIC_API_KEY` and Claude Code.
> This tool reads neither.

If one of those is already exported in their shell, say so — it is costing them money
regardless of this install.

**Codex is optional.** Without it, open-web discovery is skipped and everything else runs.
Do not ask them to install it. It authenticates with `codex login`, not a key.

Never print a key back, never echo the file, never commit it.

## Step 6 — Prove it works

Both credential-free stages, against the bundled fixture and a scratch output directory, so
nothing real is touched:

```bash
cd "$DEST"
LEADGEN_OUT_DIR=/tmp/wle-check npx tsx \
  subskills/resolve-email-domains/scripts/resolve-email-domains.ts \
  --input examples/input/companies.example.csv
LEADGEN_OUT_DIR=/tmp/wle-check npx tsx \
  subskills/email-permutation/scripts/apply-permutation.ts
```

The first is DNS only — it proves the files landed, dependencies resolve and the network
works. The second is pure string generation — it proves the output layer produces the three
deliverable files. Checking only the first leaves untested the half that makes what the user
actually receives.

Then one cheap call per configured provider, and report which are live. Do not run a full
enrichment as a health check.

## Running an enrichment

Read `$DEST/SKILL.md` and follow it. That skill owns the pipeline; this one owns getting to
the point where it can run.

If the user asked for emails and setup has just finished, **run it now** — they asked for
leads, not for an installation. Only when they explicitly asked to "set up" or "install"
should you stop and hand over with:

> Ready. To start: *"Enrich this list of company websites: `<path to csv>`"*

Either way, tell them once where things live:

- credentials: `~/.leadgen/.env` — edit that file to change keys
- results: `out/` **in whatever folder they run from**

Do not explain the internal skill layout, the subskills, or what "routing" means. None of it
helps someone who wants a list of emails.

## Rules

- Never overwrite an existing install without asking.
- Never present an unverified download as verified.
- Never leave a partial extract in place.
- Never print, echo, or commit a credential.
- Never write a key into `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, and never suggest putting
  any key in a shell profile — this tool reads one file and nothing else.
- Never run a system-level install without showing the command and getting a yes.
- A missing Codex is not a failed install.
