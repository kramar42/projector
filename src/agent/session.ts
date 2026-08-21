import { resolve } from 'node:path';
import { liveSessions, type LiveSession } from '../sources/claude.ts';

/**
 * Find the live Claude session working in a directory.
 *
 * This is how a session links itself back to its card: it knows its own working
 * directory but not its own transcript id, and `~/.claude/sessions/<pid>.json`
 * has both. Closing that loop is what makes a card's history accumulate instead
 * of relying on someone remembering to paste an id.
 *
 * Reading those files is `src/sources/claude.ts` — this is only the cwd match.
 */

export type { LiveSession };

/**
 * The session whose working directory is `cwd`, or the nearest one containing it.
 * Most recently started wins, since that is the one that just asked.
 */
export function sessionForCwd(cwd: string, self?: number): LiveSession | null {
  const want = resolve(cwd);
  const candidates = liveSessions().filter((s) => s.alive && s.pid !== self);
  return (
    candidates.find((s) => s.cwd && resolve(s.cwd) === want) ??
    candidates.find((s) => s.cwd && want.startsWith(resolve(s.cwd) + '/')) ??
    null
  );
}
