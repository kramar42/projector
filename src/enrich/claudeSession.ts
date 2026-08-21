import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ago, firstLine } from './run.ts';
import { unavailable, type Fetcher, type Tone } from './types.ts';

/**
 * Claude sessions, read from disk. No configuration, no MCP, no network.
 *
 * The durable identifier is the transcript uuid — the filename under
 * `~/.claude/projects/<slug>/<uuid>.jsonl`, which is also the `sessionId` a
 * running session records. Ids of the form `local_<uuid>` come from the desktop
 * app's own store, which is not on disk, so those cannot be resolved here.
 */

const CLAUDE = join(homedir(), '.claude');
const PROJECTS = join(CLAUDE, 'projects');
const LIVE = join(CLAUDE, 'sessions');

interface Live {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  name?: string;
  kind?: string;
  entrypoint?: string;
}

/** Sessions with a process currently holding them. */
function liveSessions(): Map<string, Live> {
  const out = new Map<string, Live>();
  if (!existsSync(LIVE)) return out;
  for (const f of readdirSync(LIVE)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(LIVE, f), 'utf8')) as Live;
      if (j.sessionId) out.set(j.sessionId, j);
    } catch {
      /* a half-written file is not worth failing over */
    }
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findTranscript(uuid: string): string | null {
  if (!existsSync(PROJECTS)) return null;
  for (const dir of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, dir, `${uuid}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface TranscriptSummary {
  opening: string;
  cwd?: string;
  branch?: string;
  turns: number;
  firstAt?: string;
  lastAt?: string;
}

/**
 * Summarise a transcript by scanning it line by line.
 *
 * Transcripts reach tens of megabytes, so this reads the file once and keeps
 * only what a chip needs rather than parsing the whole thing into memory.
 */
export function summarise(file: string, maxBytes = 6 * 1024 * 1024): TranscriptSummary {
  const raw = readFileSync(file, 'utf8');
  const text = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  let opening = '';
  let cwd: string | undefined;
  let branch: string | undefined;
  let turns = 0;
  let firstAt: string | undefined;
  let lastAt: string | undefined;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    cwd ??= typeof rec.cwd === 'string' ? rec.cwd : undefined;
    branch ??= typeof rec.gitBranch === 'string' && rec.gitBranch ? rec.gitBranch : undefined;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
    if (ts) {
      firstAt ??= ts;
      lastAt = ts;
    }
    if (rec.type === 'user') turns++;
    if (!opening) {
      // The first thing a human typed is the closest thing to a title.
      if (rec.type === 'queue-operation' && typeof rec.content === 'string') opening = rec.content;
      else if (rec.type === 'user') {
        const msg = rec.message as { content?: unknown } | undefined;
        const c = msg?.content;
        if (typeof c === 'string') opening = c;
        else if (Array.isArray(c)) {
          const block = c.find((b) => b && typeof b === 'object' && typeof (b as { text?: string }).text === 'string');
          if (block) opening = (block as { text: string }).text;
        }
      }
    }
  }
  // The full file's tail is the real last activity when the read was truncated.
  if (raw.length > maxBytes) lastAt = statSync(file).mtime.toISOString();
  return { opening: firstLine(opening.replace(/\s+/g, ' '), 160), cwd, branch, turns, firstAt, lastAt };
}

export const sessionFetcher: Fetcher = {
  // Cheap and local, so a short ttl costs nothing and keeps a running session fresh.
  ttl: 60,
  async fetch(ref) {
    const uuid = ref.replace(/^local_/, '').trim();
    if (!/^[0-9a-f-]{16,}$/i.test(uuid)) return unavailable(`"${ref}" is not a session id`);

    const file = findTranscript(uuid);
    const live = liveSessions().get(uuid);

    if (!file) {
      if (ref.startsWith('local_')) {
        return unavailable(
          'a local_… id comes from the desktop app and is not on disk — link the transcript uuid instead',
        );
      }
      return unavailable('no transcript found for that session id');
    }

    const s = summarise(file);
    const running = !!live && alive(live.pid);
    const badges: { label: string; tone: Tone }[] = [
      running ? { label: '● running', tone: 'good' } : { label: '○ idle', tone: 'neutral' },
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
