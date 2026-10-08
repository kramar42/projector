import { execFile } from 'node:child_process';
import { ago } from '../sources/run.ts';
import { unavailable, type Fetcher, type Tone } from './types.ts';

/**
 * A `bb:` ref, resolved for display: one thread in the bb app.
 *
 * bb is asked rather than read. Its store is a SQLite file with no published
 * schema, and the `bb` CLI is the contract it does publish — so this shells out
 * to `bb thread show --json` and maps what comes back, the way the GitHub
 * fetchers go through `gh`.
 *
 * There is no `url`. A thread's route is project-aware and bb asks callers not
 * to build one, so the way in is `bb thread open`, which focuses the thread in
 * whichever bb window is connected.
 */

/** `BB_CLI` is what bb itself sets inside its threads; anywhere else, `bb` on PATH. */
const bbBinary = () => process.env.BB_CLI || 'bb';

const THREAD_ID = /^thr_[a-z0-9]+$/i;

/** bb's display statuses, as a card reads them. Anything unknown stays neutral. */
const TONE: Record<string, Tone> = {
  active: 'good',
  idle: 'neutral',
  failed: 'bad',
  interrupted: 'warn',
};

interface ThreadShow {
  thread?: {
    title?: string | null;
    titleFallback?: string | null;
    status?: string;
    archivedAt?: number | null;
    deletedAt?: number | null;
    updatedAt?: number;
    providerId?: string;
  };
  environment?: { path?: string | null; branchName?: string | null } | null;
}

function show(id: string): Promise<ThreadShow | string> {
  return new Promise((resolve) => {
    execFile(bbBinary(), ['thread', 'show', id, '--json'], { timeout: 15_000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve('the bb CLI is not on PATH');
      // A failed lookup still prints the `{ ok: false, error }` envelope on stdout.
      try {
        const body = JSON.parse(stdout) as ThreadShow & { ok?: boolean; error?: { message?: string } };
        if (body.ok === false) return resolve(body.error?.message ?? 'bb could not find that thread');
        resolve(body);
      } catch {
        resolve(err ? err.message : 'bb answered with something that is not JSON');
      }
    });
  });
}

export const bbFetcher: Fetcher = {
  // Local and cheap, and a thread's status is the thing worth keeping fresh.
  ttl: 60,
  async fetch(ref) {
    const id = ref.trim();
    if (!THREAD_ID.test(id)) return unavailable(`"${ref}" is not a bb thread id`);

    const found = await show(id);
    if (typeof found === 'string') return unavailable(found);
    const t = found.thread ?? {};
    if (t.deletedAt) return unavailable('the thread was deleted in bb');

    // Phrased as bb's state, not a bare word: a bare one would collide with the
    // vault's own status vocabulary, which this is not (vocabulary.test).
    const status = t.archivedAt ? 'archived in bb' : (t.status ?? 'unknown');
    const env = found.environment;
    return {
      label: id.replace(/^thr_/, ''),
      title: t.title || t.titleFallback || '(untitled thread)',
      badges: [
        { label: status, tone: TONE[status] ?? 'neutral' },
        ...(env?.branchName ? [{ label: env.branchName, tone: 'accent' as Tone }] : []),
      ],
      fields: [
        { k: 'last activity', v: t.updatedAt ? ago(t.updatedAt) : '' },
        { k: 'provider', v: t.providerId ?? '' },
        { k: 'cwd', v: env?.path ?? '' },
      ].filter((f) => f.v),
      command: `bb thread open ${id}`,
    };
  },
};
