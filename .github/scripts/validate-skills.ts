#!/usr/bin/env node
/**
 * Validate every SKILL.md against the Agent Skills specification.
 *
 * Uses only the Node standard library, so the only thing it needs from
 * node_modules is tsx itself.
 *
 * Checks, in order of how badly getting them wrong breaks a user:
 *   1. frontmatter exists, is delimited, and parses
 *   2. `name` is lowercase kebab-case AND matches its directory (hosts key off this)
 *   3. `description` is present and non-empty
 *   4. frontmatter is <= 1024 characters (the spec's hard cap)
 *   5. relative paths referenced in the body actually resolve
 *   6. the body names no host-specific tools (portability)
 *   7. body length is within the recommended 500 lines (advisory)
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const MAX_FRONTMATTER = 1024;
/** Spec guidance: keep descriptions under 500 chars where possible. */
const MAX_DESCRIPTION = 500;
const RECOMMENDED_LINES = 500;

/**
 * Tool names that only exist inside one vendor's agent. A skill naming these
 * reads as an instruction another runtime cannot follow — the portability rule.
 * Prose mentions of a *provider* ("Codex CLI", "Claude Code") are fine and are
 * not listed; this targets tool-call names.
 */
const HOST_SPECIFIC = [
  /\bthe (Read|Write|Edit|Bash|Grep|Glob|Task|WebFetch|WebSearch) tool\b/i,
  /\buse (Read|Write|Edit|Bash|Grep|Glob|WebFetch|WebSearch)\(/i,
  /\bstr_replace_editor\b/i,
  /\bantml:invoke\b/i,
];

const errors: string[] = [];
const warnings: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    // Do not follow symlinks: .claude/skills/ points back here and would double-report.
    if (statSync(p, { throwIfNoEntry: false })?.isDirectory() && !statSync(p).isSymbolicLink()) {
      out.push(...walk(p));
    } else if (entry === 'SKILL.md') {
      out.push(p);
    }
  }
  return out;
}

/** Shallow YAML: top-level `key: value` only, which is all the spec requires. */
interface Frontmatter {
  fields: Record<string, string>;
  raw: string;
  body: string;
}

function parseFrontmatter(text: string, file: string): Frontmatter | null {
  if (!text.startsWith('---\n')) {
    errors.push(`${file}: no YAML frontmatter (must start with '---')`);
    return null;
  }
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) {
    errors.push(`${file}: frontmatter is never closed with '---'`);
    return null;
  }
  const raw = text.slice(0, end + 5);
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of text.slice(4, end + 1).split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (m) {
      key = m[1];
      fields[key] = m[2].trim();
    } else if (key && line.startsWith('  ')) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return { fields, raw, body: text.slice(end + 5) };
}

const files = walk(join(ROOT, 'skills')).sort();
if (files.length === 0) errors.push('no SKILL.md found under skills/');

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  const parsed = parseFrontmatter(readFileSync(file, 'utf8'), rel);
  if (!parsed) continue;
  const { fields, raw, body } = parsed;

  const dir = basename(dirname(file));
  if (!fields.name) {
    errors.push(`${rel}: missing required field 'name'`);
  } else {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.name)) {
      errors.push(`${rel}: name '${fields.name}' is not lowercase kebab-case`);
    }
    if (fields.name !== dir) {
      errors.push(`${rel}: name '${fields.name}' does not match its directory '${dir}'`);
    }
  }

  if (!fields.description) {
    errors.push(`${rel}: missing required field 'description'`);
  }

  // A host with many skills installed truncates descriptions to fit its context budget,
  // and truncation eats the TAIL — which is where the "NOT for:" clauses live. Losing
  // those is what makes a skill fire on requests it should decline.
  if (fields.description && fields.description.length > MAX_DESCRIPTION) {
    warnings.push(
      `${rel}: description is ${fields.description.length} chars; keep it under ` +
        `${MAX_DESCRIPTION} so a host with many skills cannot truncate away the "NOT for" clauses`,
    );
  }

  if (raw.length > MAX_FRONTMATTER) {
    errors.push(`${rel}: frontmatter is ${raw.length} chars, over the ${MAX_FRONTMATTER} limit`);
  }

  // Relative paths written in backticks — the move to skills/ is exactly the kind
  // of change that silently breaks these.
  for (const [, p] of body.matchAll(/`(\.\.?\/[A-Za-z0-9._\-/]+)`/g)) {
    if (!existsSync(resolve(dirname(file), p))) {
      errors.push(`${rel}: referenced path '${p}' does not exist`);
    }
  }

  for (const pattern of HOST_SPECIFIC) {
    const hit = pattern.exec(body);
    if (hit) errors.push(`${rel}: host-specific tool reference '${hit[0].trim()}' — keep skills portable`);
  }

  const lines = body.split('\n').length;
  if (lines > RECOMMENDED_LINES) {
    warnings.push(`${rel}: ${lines} lines, over the recommended ${RECOMMENDED_LINES}`);
  }
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
console.log(`\nvalidated ${files.length} SKILL.md file(s): ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
