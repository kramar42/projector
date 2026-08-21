import { statSync } from 'node:fs';
import { findTranscript, liveById, summarise } from '../sources/claude.ts';
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

export const sessionFetcher: Fetcher = {
  // Cheap and local, so a short ttl costs nothing and keeps a running session fresh.
  ttl: 60,
  async fetch(ref) {
    const uuid = ref.replace(/^local_/, '').trim();
    if (!/^[0-9a-f-]{16,}$/i.test(uuid)) return unavailable(`"${ref}" is not a session id`);

    const file = findTranscript(uuid);
    const live = liveById().get(uuid);

    if (!file) {
      if (ref.startsWith('local_')) {
        return unavailable(
          'a local_… id comes from the desktop app and is not on disk — link the transcript uuid instead',
        );
      }
      return unavailable('no transcript found for that session id');
    }

    const s = summarise(file);
    const badges: { label: string; tone: Tone }[] = [
      live?.alive ? { label: '● running', tone: 'good' } : { label: '○ idle', tone: 'neutral' },
    ];
    if (s.branch) badges.push({ label: s.branch, tone: 'accent' });

    const lastAt = s.lastAt ?? statSync(file).mtime.toISOString();
    return {
      label: live?.name ?? uuid.slice(0, 8),
      title: s.opening || '(no opening prompt recorded)',
      badges,
      fields: [
        { k: 'last activity', v: ago(lastAt) },
        { k: 'turns', v: String(s.turns) },
        { k: 'cwd', v: s.cwd ?? '' },
        { k: 'started', v: ago(s.firstAt) },
      ].filter((f) => f.v),
      // Resuming is the user's move, not the app's: it prints the command to run.
      command: `claude --resume ${uuid}`,
    };
  },
};
