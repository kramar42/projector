import { desktopSessionFor, describeSession, type SessionState } from '../sources/claude.ts';
import { ago } from '../sources/run.ts';
import { unavailable, type Fetcher, type Tone } from './types.ts';

/**
 * A `claude:` ref, resolved for display.
 *
 * Reading transcripts is `src/sources/claude.ts`; this file is only the mapping
 * from what is on disk to what a chip shows. Everything about the on-disk format
 * — where sessions live, which pid holds one, how a transcript is summarised —
 * belongs to the source, because intake reads the same files for a different
 * reason and the two must not drift.
 */

/** What the desktop app's `claude://resume` handler accepts as a session id. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How to get back into a session, as a deep link where the desktop app offers
 * one and the shell command where it does not.
 *
 * Two different links, because the app has two different ideas of a session. A
 * chat it already holds is opened by its own id, at the in-app route the app
 * itself uses for a chat — `claude://claude.ai/<route>`, where the host names
 * the app and the path is the route. A transcript it has never seen can only be
 * imported, and `claude://resume` mints a *new* chat every time it runs, so
 * offering it for a transcript the app already has would quietly duplicate the
 * chat rather than reopen it.
 */
function resume(uuid: string): {
  action?: { label: string; href: string };
  command?: string;
  badges?: { label: string; tone: Tone }[];
} {
  const chat = desktopSessionFor(uuid);
  if (chat) return { action: { label: 'open in Claude', href: `claude://claude.ai/epitaxy/${chat.sessionId}` } };
  if (CANONICAL_UUID.test(uuid))
    return {
      action: { label: 'import into Claude', href: `claude://resume?session=${uuid}` },
      // The row draws one way in, in one place, for every kind — so the label no
      // longer carries this distinction and something else has to. It is worth
      // seeing without hovering: importing mints a *new* chat, so following this
      // twice leaves two.
      badges: [{ label: 'import', tone: 'warn' }],
    };
  return { command: `claude --resume ${uuid}` };
}

/** How the four states read on a card. The state itself is decided upstream. */
const BADGE: Record<SessionState, { label: string; tone: Tone }> = {
  working: { label: '● working', tone: 'good' },
  stalled: { label: '◐ stalled', tone: 'warn' },
  waiting: { label: '◐ waiting', tone: 'accent' },
  closed: { label: '○ closed', tone: 'neutral' },
};

export const sessionFetcher: Fetcher = {
  // Cheap and local, so a short ttl costs nothing and keeps a running session fresh.
  ttl: 60,
  async fetch(ref) {
    const uuid = ref.replace(/^local_/, '').trim();
    if (!/^[0-9a-f-]{16,}$/i.test(uuid)) return unavailable(`"${ref}" is not a session id`);

    const found = describeSession(uuid);
    const live = found?.live ?? null;

    if (!found) {
      if (ref.startsWith('local_')) {
        return unavailable(
          'a local_… id comes from the desktop app and is not on disk — link the transcript uuid instead',
        );
      }
      return unavailable('no transcript found for that session id');
    }

    const { summary: s, lastAt } = found;
    const how = resume(uuid);
    const badges: { label: string; tone: Tone }[] = [BADGE[found.state]];
    if (s.branch) badges.push({ label: s.branch, tone: 'accent' });
    return {
      label: live?.name ?? uuid.slice(0, 8),
      title: s.opening || '(no opening prompt recorded)',
      badges: [...badges, ...(how.badges ?? [])],
      fields: [
        { k: 'last activity', v: ago(lastAt) },
        { k: 'turns', v: String(s.turns) },
        { k: 'cwd', v: s.cwd ?? '' },
        { k: 'started', v: ago(s.firstAt) },
      ].filter((f) => f.v),
      // Resuming is the user's move, not the app's: this offers the move, it does
      // not make it. `badges` is spread above rather than here, so it merges with
      // the session's own rather than replacing them.
      action: how.action,
      command: how.command,
    };
  },
};
