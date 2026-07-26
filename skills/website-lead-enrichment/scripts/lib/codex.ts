import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV, readEnv } from './env.js';

/**
 * Find the Codex CLI. One resolver, used by the discovery runner AND the usage probe, so
 * preflight can never report a binary that the runner then fails to spawn.
 *
 * Codex is OPTIONAL: `bin: null` means stage 5 is skipped, not that anything is broken.
 *
 * `LEADGEN_CODEX_BIN` is an override, not the source of truth. A pinned absolute path — an nvm
 * directory from another machine, say — goes stale silently, so a LEADGEN_CODEX_BIN that does not
 * exist is reported and stepped over rather than trusted.
 */

export type CodexSource = 'LEADGEN_CODEX_BIN' | 'PATH' | 'well-known' | 'not-found';

export interface CodexResolution {
  /** Absolute path or bare command, or null when Codex is not installed. */
  bin: string | null;
  source: CodexSource;
  /** Set when LEADGEN_CODEX_BIN pointed somewhere unusable. Worth surfacing to the user. */
  warning?: string;
}

const isExecutableFile = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Whatever the user's shell would run. */
function fromPath(): string | null {
  try {
    const found = execFileSync('sh', ['-c', 'command -v codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return found && isExecutableFile(found) ? found : null;
  } catch {
    return null;
  }
}

/** Places node CLIs land when PATH is not set up for a non-interactive shell. */
function fromWellKnown(): string | null {
  const home = os.homedir();
  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(home, '.local/bin/codex'),
    path.join(home, '.npm-global/bin/codex'),
    path.join(home, '.bun/bin/codex'),
    path.join(home, '.volta/bin/codex'),
  ];
  // Every installed nvm node version, newest first.
  const nvm = path.join(home, '.nvm/versions/node');
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) {
      candidates.push(path.join(nvm, v, 'bin/codex'));
    }
  } catch {
    /* no nvm */
  }
  return candidates.find(isExecutableFile) ?? null;
}

export function resolveCodex(env: NodeJS.ProcessEnv = process.env): CodexResolution {
  let warning: string | undefined;
  // Resolved once — the pinned-bare-name path used to ask twice, forking a shell twice.
  const onPath = fromPath();

  const pinned = readEnv('codexBin', env);
  if (pinned) {
    // A bare command name is a preference, not a path — let PATH resolve it.
    if (!pinned.includes('/')) {
      if (onPath) return { bin: onPath, source: ENV.codexBin };
    } else if (isExecutableFile(pinned)) {
      return { bin: pinned, source: ENV.codexBin };
    } else {
      warning =
        `LEADGEN_CODEX_BIN points at ${pinned}, which is not an executable file on this machine. ` +
        'Ignoring it and searching PATH instead — you can safely delete the line from .env.';
    }
  }

  if (onPath) return { bin: onPath, source: 'PATH', warning };

  const wellKnown = fromWellKnown();
  if (wellKnown) return { bin: wellKnown, source: 'well-known', warning };

  return { bin: null, source: 'not-found', warning };
}

/** One-line status for preflight. Never phrase a missing Codex as an error. */
export function describeCodex(r: CodexResolution): string {
  if (!r.bin) return 'Codex: not installed — stage 5 (open-web discovery) will be skipped';
  return `Codex: ${r.bin} (found via ${r.source})`;
}
