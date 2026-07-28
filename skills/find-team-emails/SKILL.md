---
name: find-team-emails
description: >-
  Use when someone has a list of company websites and wants the people who work there and
  their email addresses - "find staff emails for these clinics", "enrich this account
  list", "I have domains but no emails". Also when they ask to install or set this tool
  up, or it is broken, missing dependencies, or erroring because API keys were never
  configured. NOT for: checking whether an address delivers, scraping one already-known
  page, or lists that already contain the people.
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

One list drives both the copy and the check, so they cannot drift apart. It is held in the
positional parameters rather than a string, because `for item in $NEEDS` splits into five
entries under bash and stays one impossible filename under zsh — the default shell on macOS,
where it aborts every install:

```bash
# The extracted release, or set SRC to the checkout step 3 found instead.
SRC=$(find -L /tmp -maxdepth 1 -type d -name 'vertical-saas-agent-*' 2>/dev/null | head -1)
[ -n "$SRC" ] || { echo "no source tree — go back to step 3"; exit 1; }
set -- package.json .npmrc tsconfig.json .env.example examples/input

mkdir -p "$DEST"
cp -R "$SRC/skills/website-lead-enrichment/." "$DEST/"
for item in "$@"; do
  mkdir -p "$DEST/$(dirname "$item")"
  cp -R "$SRC/$item" "$DEST/$item"
done

fail=0
for item in SKILL.md scripts/lib/paths.ts "$@"; do
  [ -e "$DEST/$item" ] || { echo "MISSING: $item"; fail=1; }
done
[ "$(ls "$DEST"/references/[0-9][0-9]-*.md 2>/dev/null | wc -l)" -eq 8 ] || { echo "MISSING: stage references"; fail=1; }
[ "$fail" -eq 0 ] || { rm -rf "$DEST"; echo "install aborted"; exit 1; }

cd "$DEST" && npm install
```

`.npmrc` is not optional. It carries `legacy-peer-deps=true`, and without it `npm install`
fails outright — firecrawl ships zod 3 while this project uses zod 4, and npm's strict peer
resolution refuses to proceed. The two resolve fine at runtime; only the installer objects.

A partial install is worse than none: on any missing entry remove `$DEST` entirely and
report, rather than leaving a folder that half works.

## Step 5 — Credentials

Four keys, one file. Run this for them — it creates the file only if it does not already
exist, so re-running can never wipe keys they already have:

```bash
mkdir -p ~/.leadgen
[ -f ~/.leadgen/.env ] || cat > ~/.leadgen/.env <<'EOF'
# Paste each key after the "=" sign. No quotes, no spaces.

LEADGEN_FIRECRAWL_API_KEY=
LEADGEN_ZYTE_API_KEY=
LEADGEN_LLM_API_KEY=
LEADGEN_LLM_MODEL_REASONING=gpt-4o

# Optional — leave blank unless you know you need them.
LEADGEN_LLM_BASE_URL=
LEADGEN_LLM_MODEL_EXTRACTION=
EOF
chmod 600 ~/.leadgen/.env
nano ~/.leadgen/.env
```

Then tell them **exactly** how to save, because nano gives no hint and this is where a
non-technical user gets stuck:

> Paste each key after its `=` sign, then:
>
> 1. **Ctrl + O** then **Enter** — saves
> 2. **Ctrl + X** — closes the editor
>
> (On a Mac that is the Control key, not Command.)

Where the three keys come from:

| Key | Get it at | Free tier? |
|---|---|---|
| `LEADGEN_FIRECRAWL_API_KEY` | firecrawl.dev | yes |
| `LEADGEN_ZYTE_API_KEY` | zyte.com | trial |
| `LEADGEN_LLM_API_KEY` | platform.openai.com, or any OpenAI-compatible provider | varies |

`LEADGEN_LLM_MODEL_REASONING` is pre-filled with `gpt-4o` and works as-is on OpenAI. For a
different provider, set `LEADGEN_LLM_BASE_URL` too — `.env.example` lists the base URLs for
OpenRouter, Together, Groq, Ollama and Azure.

Confirm it saved without ever printing a value:

```bash
grep -c '^LEADGEN_.*=.\+' ~/.leadgen/.env   # expect 4 or more
```

Tell them why the names look unusual, because it is what they are most likely to ask:

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

Both credential-free stages, against a scratch output directory so nothing real is touched.

**Stage 6 — proves the install.** DNS only: the files landed, dependencies resolve, the
network works, paths point where they should.

```bash
cd "$DEST"
export CHECK=/tmp/wle-check && rm -rf "$CHECK"
LEADGEN_OUT_DIR=$CHECK npx tsx \
  scripts/resolve-email-domains/resolve-email-domains.ts \
  --input examples/input/companies.example.csv
```

A provider breakdown means the install is sound.

**Stage 8 — proves the output layer**, which is the half that makes what the user actually
receives. It reads the master, so seed a throwaway one first; run against an empty
directory it will correctly report that nothing has been extracted yet and prove nothing:

```bash
mkdir -p "$CHECK/.work"
cat > "$CHECK/.work/team-master.csv" <<'CSV'
company,domain,website,name,title,email,email_source_url,updated_at,business_email,all_business_emails,business_email_source_url,related_email
Check Co,example.com,https://example.com,Jane Doe,Director,jane.doe@example.com,https://example.com/team,2026-01-01T00:00:00Z,,,,
Check Co,example.com,https://example.com,John Smith,Analyst,,,2026-01-01T00:00:00Z,,,,
CSV
LEADGEN_OUT_DIR=$CHECK npx tsx scripts/email-permutation/apply-permutation.ts
ls "$CHECK"          # expect: ready-to-send.csv, verify-before-sending.csv, README.txt, .work
```

One row is a real scraped address and one needs predicting, so a pass exercises both
branches: the first lands in `ready-to-send.csv`, the second in `verify-before-sending.csv`.

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

Do not explain the internal skill layout, the stage references, or what "routing" means.
None of it helps someone who wants a list of emails.

## Rules

- Never overwrite an existing install without asking.
- Never present an unverified download as verified.
- Never leave a partial extract in place.
- Never print, echo, or commit a credential.
- Never write a key into `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, and never suggest putting
  any key in a shell profile — this tool reads one file and nothing else.
- Never run a system-level install without showing the command and getting a yes.
- A missing Codex is not a failed install.
