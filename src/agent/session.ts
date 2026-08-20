import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Find the live Claude session working in a directory.
 *
 * This is how a session links itself back to its card: it knows its own working
 * directory but not its own transcript id, and `~/.claude/sessions/<pid>.json`
 * has both. Closing that loop is what makes a card's history accumulate instead
 * of relying on someone remembering to paste an id.
 */

const LIVE = join(homedir(), '.claude', 'sessions');

export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd: string;
  startedAt?: number;
  name?: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function liveSessions(): LiveSession[] {
  if (!existsSync(LIVE)) return [];
  const out: LiveSession[] = [];
  for (const f of readdirSync(LIVE)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(LIVE, f), 'utf8')) as LiveSession;
      if (j.sessionId && j.pid && alive(j.pid)) out.push(j);
    } catch {
      /* a half-written file is not worth failing over */
    }
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * The session whose working directory is `cwd`, or the nearest one containing it.
 * Most recently started wins, since that is the one that just asked.
 */
export function sessionForCwd(cwd: string, self?: number): LiveSession | null {
  const want = resolve(cwd);
  const candidates = liveSessions().filter((s) => s.pid !== self);
  return (
    candidates.find((s) => resolve(s.cwd) === want) ??
    candidates.find((s) => want.startsWith(resolve(s.cwd) + '/')) ??
    null
  );
}
