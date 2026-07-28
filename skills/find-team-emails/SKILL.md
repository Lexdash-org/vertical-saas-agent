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

**Every block below re-derives `SKILLS_DIR` and `DEST`, and that repetition is deliberate.**
Most agent runtimes run each shell command in a fresh process, so a variable set in one
block is empty in the next — `mkdir -p "$DEST"` against an unset `DEST` writes to the wrong
place or silently no-ops. It looks like pointless duplication when you paste these into one
terminal, which is exactly why it was missing and why the install broke. The one value that
cannot be re-derived — where the source tree ended up — is written to a file instead.

| State | What to do |
|---|---|
| all three present | **Say nothing about setup.** Go straight to *Running an enrichment*. |
| pipeline + deps, no credentials | Step 5 only, then run. |
| anything else missing | Steps 2–6, then run. |

After the first day the common case is "all present". Landing there must cost the user
nothing — no setup narration, no instructions, just the result they asked for.

### Whether to ask first

The table says what work is needed. What they asked for says whether to start it unprompted:

| They said | Do |
|---|---|
| "enrich these websites", or gave you a CSV | **Do not ask.** One line — *"Setting up first, this takes a few minutes"* — then Steps 2–6 and run. They asked for leads, not for a decision about npm. |
| "install this", "set it up" | **Do not ask.** They already did. Steps 2–6, then hand over. |
| nothing yet — they just ran `npx skills add`, or asked what this is | **Offer, then wait:** *"The pipeline and credentials aren't in place yet. Should I set it up for you?"* |

Only the third row waits. Someone who asked for something has already decided; asking again
is friction. Someone who asked for nothing has not, and `npx skills add` is exactly that
case — it places this file and nothing else, so a user who has just run it has a skill on
disk, no working tool, and no reason to know the difference. Offer to finish it. Do not hand
them a list of what is missing and leave them to trigger each part.

An offer is one sentence and a question. It is not a status table, not an inventory of
absent files, and not an explanation of what got installed where.

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

A source is a **repository root** — it must hold both `package.json` and the pipeline under
`skills/`, because step 4 copies from both. An already-installed skill folder is not a
source: it is the flattened *result* of a previous install and has no `skills/` directory.

```bash
STAGE="$HOME/.leadgen/install"
FETCHED=$(cat "$STAGE/source-path" 2>/dev/null)

SRC=""
for c in . .. "$FETCHED"; do
  [ -f "$c/package.json" ] && [ -f "$c/skills/website-lead-enrichment/SKILL.md" ] \
    && SRC=$(cd "$c" && pwd) && break
done

# Only when the free checks came up empty: a bounded sweep for a clone elsewhere. Heavy
# directories are pruned and the depth is capped, so this costs a second or two rather
# than minutes. It will miss a checkout nested deeper — that is what the question below is
# for. Running it before the cheap candidates would make every in-repo run pay for it.
if [ -z "$SRC" ]; then
  CLONED=$(find "$HOME" -maxdepth 5 \
    \( -name node_modules -o -name Library -o -name .git -o -name .Trash \) -prune -o \
    -type d -path '*/skills/website-lead-enrichment' -print 2>/dev/null | head -1)
  ROOT="${CLONED%/skills/website-lead-enrichment}"
  [ -n "$CLONED" ] && [ -f "$ROOT/package.json" ] && SRC=$(cd "$ROOT" && pwd)
fi

mkdir -p "$STAGE"
if [ -n "$SRC" ]; then
  printf '%s\n' "$SRC" > "$STAGE/source-path"
  echo "source: $SRC"
else
  echo "source: NONE"
fi
```

The sweep is not decoration: the documented way in is `npx skills add`, run from whatever
directory the user happened to be standing in, so neither `.` nor `..` is a repository root
on a first run. Probing only those sends every new user to the download path — which, as
below, is the one that cannot work today.

**If it prints `NONE`, ask the user before downloading:** *"Do you have a clone of this
repository? If so, what is the path?"* Then record their answer and continue at step 4:

```bash
STAGE="$HOME/.leadgen/install"; mkdir -p "$STAGE"
CANDIDATE="<the path they gave>"
[ -f "$CANDIDATE/package.json" ] && [ -f "$CANDIDATE/skills/website-lead-enrichment/SKILL.md" ] \
  && (cd "$CANDIDATE" && pwd) > "$STAGE/source-path" && echo "source: $CANDIDATE" \
  || echo "that path is not a checkout of this repository"
```

One question is cheaper than a failed download, and it is the only step that reliably works
while the release is unreachable.

The third candidate is read from a file rather than globbed as `"$STAGE"/vertical-saas-agent-*`,
because **zsh aborts the whole block when a glob matches nothing** — `no matches found`, and
nothing after it runs. bash leaves the pattern as a literal word and carries on. zsh is the
default shell on macOS, so the glob form fails for exactly the users the fallback exists to
serve, while every bash CI run stays green. Same trap as the `for item in $NEEDS` bug in
step 4, in the opposite direction, and an invariant now rejects both.

`STAGE` lives under `$HOME/.leadgen/`, the directory this project already owns for
per-user state, and **not** under `/tmp`. It has to be a fixed, predictable name rather than
`mktemp -d`, because the next block cannot see a random directory this one invented — and a
predictable name in a world-writable directory is a hole: on Linux `/tmp`'s sticky bit stops
another local user deleting your files, not creating them first. They could pre-place a
`source-path` pointing at a tree they control, which step 4 then `cp -R`s into your skills
folder and runs `npm install` inside — arbitrary lifecycle scripts, as you. `$HOME/.leadgen/`
is not writable by anyone else, so the predictable name costs nothing.

**If found**, skip the download and go to step 4.

**If not found**, fetch the tagged release:

```bash
STAGE="$HOME/.leadgen/install"; rm -rf "$STAGE"; mkdir -p "$STAGE"
REPO=Lexdash-org/vertical-saas-agent

TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4)
[ -n "$TAG" ] || { echo "no release is publicly reachable — install from a clone instead"; exit 1; }

curl -fsSL -o "$STAGE/wle.tar.gz" "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz" \
  || { echo "release $TAG is not downloadable — install from a clone instead"; exit 1; }

# Compare digests directly. `shasum -c --ignore-missing` cannot be used here: the file it
# verifies is GitHub's auto-generated source tarball, whose name is not the name any
# uploaded asset carries, so nothing matches and shasum exits 1 with "no file was verified"
# — indistinguishable from real tampering, and it would delete a perfect download the day
# checksums are first published. A missing file and a file with no matching digest are the
# same outcome to the user, so they share a branch.
WANT=$(curl -fsSL "https://github.com/$REPO/releases/download/$TAG/checksums.txt" 2>/dev/null \
  | grep -iE 'source|\.tar\.gz' | grep -oiE '[0-9a-f]{64}' | head -1)
if [ -z "$WANT" ]; then
  echo "UNVERIFIED: no published checksum for $TAG"
elif [ "$WANT" != "$(shasum -a 256 "$STAGE/wle.tar.gz" | cut -d' ' -f1)" ]; then
  echo "CHECKSUM MISMATCH — discarding the download"; rm -rf "$STAGE"; exit 1
else
  echo "checksum verified"
fi

tar -xzf "$STAGE/wle.tar.gz" -C "$STAGE"
find "$STAGE" -maxdepth 1 -type d -name 'vertical-saas-agent-*' | head -1 > "$STAGE/source-path"
[ -s "$STAGE/source-path" ] || { echo "archive did not contain the expected tree"; exit 1; }
```

**A 404 on the release API is the expected result today, not a transient error.** It means
the release is not publicly reachable — either none is published, or the repository is
private, and from outside the two are indistinguishable. Either way the download path is
closed and a clone is the supported route. Say that plainly and stop; do not fall back to
the default branch, because an untagged tree is not a release.

If the checksum file is absent the download is **unverified**. Say so in those words and ask
whether to continue — never present an unverified download as verified.

## Step 4 — Assemble and install

One list drives both the copy and the check, so they cannot drift apart. It is held in the
positional parameters rather than a string, because `for item in $NEEDS` splits into five
entries under bash and stays one impossible filename under zsh — the default shell on macOS,
where it aborts every install:

```bash
SKILLS_DIR="${HOME}/.claude/skills"; [ -d "$HOME/.claude" ] || SKILLS_DIR="$HOME/.agents/skills"
DEST="$SKILLS_DIR/website-lead-enrichment"
STAGE="$HOME/.leadgen/install"

# Whatever step 3 resolved — a clone or an extracted release, both repository roots.
SRC=$(cat "$STAGE/source-path" 2>/dev/null)
# The same pair step 3 validates on. Testing only package.json here would accept a tree
# step 3 would have rejected, which is how one definition of "a source" becomes two.
[ -n "$SRC" ] && [ -f "$SRC/package.json" ] && [ -f "$SRC/skills/website-lead-enrichment/SKILL.md" ] \
  || { echo "no source tree — go back to step 3"; exit 1; }
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

cd "$DEST" && npm install --no-audit --no-fund
```

`.npmrc` is not optional. It carries `legacy-peer-deps=true`, and without it `npm install`
fails outright — firecrawl ships zod 3 while this project uses zod 4, and npm's strict peer
resolution refuses to proceed. The two resolve fine at runtime; only the installer objects.

A partial install is worse than none: on any missing entry remove `$DEST` entirely and
report, rather than leaving a folder that half works.

**Only a non-zero exit is a failure**, and do not run `npm audit fix` — it will change
pinned versions the pipeline depends on. `--no-audit --no-fund` is on the command because
those summaries read as failure to a salesperson watching an install, and relaying them
turns a successful setup into an alarming one. The flags belong here, on the one command
whose audience is that user — not in `.npmrc`, where they would also hide real advisories
from maintainers and CI.

## Step 5 — Credentials

Four keys, one file. Run this for them — it creates the file only if it does not already
exist, so re-running can never wipe keys they already have:

```bash
mkdir -p ~/.leadgen
if [ -f ~/.leadgen/.env ]; then echo "~/.leadgen/.env already exists — keeping it"; else
cat > ~/.leadgen/.env <<'EOF'
# Paste each key after the "=" sign. No quotes, no spaces.

LEADGEN_FIRECRAWL_API_KEY=
LEADGEN_ZYTE_API_KEY=
LEADGEN_LLM_API_KEY=
LEADGEN_LLM_MODEL_REASONING=gpt-4o

# Optional — leave blank unless you know you need them.
LEADGEN_LLM_BASE_URL=
LEADGEN_LLM_MODEL_EXTRACTION=
EOF
echo "created a blank ~/.leadgen/.env"
fi
chmod 600 ~/.leadgen/.env
```

The two messages are different on purpose. "Created a blank" and "already exists" are the
only signal that distinguishes *the user's keys are already in place* from *a blank template
was just written* — reporting "created" for both sends the agent off to collect keys the
user configured last week.

**Do not open an editor.** `nano` was here and it broke the premise of the skill: no agent
running without a terminal can drive an interactive editor, so the install stopped dead at
the last step. Ask the user for the keys in the conversation and write them into the file
yourself — that is the whole reason they are talking to you rather than reading a README.

Only if they say they would rather edit it by hand, and only when a terminal is actually
attached, offer to open one:

```bash
if [ -t 0 ] && [ -t 1 ]; then "${EDITOR:-nano}" ~/.leadgen/.env; else
  echo "no terminal attached — the keys must be written into ~/.leadgen/.env directly"
fi
```

If that opens `nano`, tell them **exactly** how to save, because nano gives no hint and this
is where a non-technical user gets stuck:

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
SKILLS_DIR="${HOME}/.claude/skills"; [ -d "$HOME/.claude" ] || SKILLS_DIR="$HOME/.agents/skills"
DEST="$SKILLS_DIR/website-lead-enrichment"
CHECK="$HOME/.leadgen/health-check"; rm -rf "$CHECK"

cd "$DEST"
LEADGEN_OUT_DIR="$CHECK" npx tsx \
  scripts/resolve-email-domains/resolve-email-domains.ts \
  --input examples/input/companies.example.csv
```

A provider breakdown means the install is sound.

**Stage 8 — proves the output layer**, which is the half that makes what the user actually
receives. It reads the master, so seed a throwaway one first; run against an empty
directory it will correctly report that nothing has been extracted yet and prove nothing:

```bash
SKILLS_DIR="${HOME}/.claude/skills"; [ -d "$HOME/.claude" ] || SKILLS_DIR="$HOME/.agents/skills"
DEST="$SKILLS_DIR/website-lead-enrichment"
CHECK="$HOME/.leadgen/health-check"

cd "$DEST"
mkdir -p "$CHECK/.work"
cat > "$CHECK/.work/team-master.csv" <<'CSV'
company,domain,website,name,title,email,email_source_url,updated_at,business_email,all_business_emails,business_email_source_url,related_email
Check Co,example.com,https://example.com,Jane Doe,Director,jane.doe@example.com,https://example.com/team,2026-01-01T00:00:00Z,,,,
Check Co,example.com,https://example.com,John Smith,Analyst,,,2026-01-01T00:00:00Z,,,,
CSV
LEADGEN_OUT_DIR="$CHECK" npx tsx scripts/email-permutation/apply-permutation.ts
ls "$CHECK"          # expect: ready-to-send.csv, verify-before-sending.csv, README.txt, .work
```

One row is a real scraped address and one needs predicting, so a pass exercises both
branches: the first lands in `ready-to-send.csv`, the second in `verify-before-sending.csv`.

**Then the providers.** Both stages above are credential-free by design, so passing them
proves the install and nothing about the keys. Run the health check:

```bash
SKILLS_DIR="${HOME}/.claude/skills"; [ -d "$HOME/.claude" ] || SKILLS_DIR="$HOME/.agents/skills"
DEST="$SKILLS_DIR/website-lead-enrichment"

cd "$DEST" && npx tsx scripts/doctor/doctor.ts
```

One cheap call per configured provider — PASS, FAIL or SKIP per line, and a non-zero exit if
anything configured is broken. A provider with no key set is SKIP, not FAIL: someone who
deliberately left Firecrawl out has not broken their install. Never run a full enrichment as
a health check.

Report only the failing lines and what they mean for the user's run — a bad LLM key means
the pipeline cannot rank or extract; a missing Codex means one optional stage is skipped.
Do not paste the whole table at someone who just wants leads.

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
None of it helps someone who wants a list of emails. That holds while reporting an install
just as much as while reporting a run — see the Rules.

## Rules

- Never describe the internals — the two-skill split, the stage references, the release
  tag, what got copied where, how skills are discovered. This applies to install reports,
  not only to enrichment results. The user wants emails; the plumbing is yours to know and
  theirs to never think about. Report an install as one line and an offer.
- Never end a setup by listing what is still missing and leaving the user to trigger it.
  Offer to do it, or do it — a table of absent files is homework, not a handoff.
- Never overwrite an existing install without asking.
- Never present an unverified download as verified.
- Never leave a partial extract in place.
- Never print, echo, or commit a credential.
- Never write a key into `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, and never suggest putting
  any key in a shell profile — this tool reads one file and nothing else.
- Never run a system-level install without showing the command and getting a yes.
- A missing Codex is not a failed install.
