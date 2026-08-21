import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { firstLine } from './run.ts';

/**
 * Claude sessions, read from disk. No configuration, no MCP, no network.
 *
 * The durable identifier is the transcript uuid — the filename under
 * `~/.claude/projects/<slug>/<uuid>.jsonl`, which is also the `sessionId` a
 * running session records. Ids of the form `local_<uuid>` come from the desktop
 * app's own store, which is not on disk, so those cannot be resolved.
 *
 * Three consumers, one reader: the `claude:` fetcher resolves a uuid it was
 * given, `ck link-session` finds the session working in a directory, and intake
 * discovers transcripts that moved since it last looked. Before this file each
 * had its own copy of `liveSessions`, which is two too many for a format we do
 * not control.
 */

const CLAUDE = join(homedir(), '.claude');
const PROJECTS = join(CLAUDE, 'projects');
const LIVE = join(CLAUDE, 'sessions');

export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd: string;
  startedAt?: number;
  name?: string;
  kind?: string;
  entrypoint?: string;
  /** Whether the recorded pid still exists. A stale file is not a live session. */
  alive: boolean;
}

/** Signal 0 tests for existence without touching the process. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every session file on disk, newest first, each carrying whether its process is
 * still there. Callers that want only running sessions filter on `alive` — the
 * `claude:` fetcher wants the dead ones too, so it can say "idle" rather than
 * "not found".
 */
export function liveSessions(): LiveSession[] {
  if (!existsSync(LIVE)) return [];
  const out: LiveSession[] = [];
  for (const f of readdirSync(LIVE)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(LIVE, f), 'utf8')) as Partial<LiveSession>;
      if (!j.sessionId || !j.pid) continue;
      out.push({ ...j, sessionId: j.sessionId, pid: j.pid, cwd: j.cwd ?? '', alive: alive(j.pid) });
    } catch {
      /* a half-written file is not worth failing over */
    }
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function liveById(): Map<string, LiveSession> {
  return new Map(liveSessions().map((s) => [s.sessionId, s]));
}

export function findTranscript(uuid: string): string | null {
  if (!existsSync(PROJECTS)) return null;
  for (const dir of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, dir, `${uuid}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface Transcript {
  uuid: string;
  file: string;
  /** The `~/.claude/projects/<slug>` directory it sits in. */
  slug: string;
  /** Last write, which is the last activity even when the file is huge. */
  modifiedAt: string;
  bytes: number;
}

/**
 * Every transcript on disk, newest first, optionally only those written since a
 * moment.
 *
 * mtime rather than a parse: this is the discovery pass and it runs over every
 * transcript there has ever been, so it must not open any of them. `summarise`
 * is the expensive step and intake calls it only for what survives the window.
 */
export function listTranscripts(opts: { since?: Date; limit?: number } = {}): Transcript[] {
  if (!existsSync(PROJECTS)) return [];
  const out: Transcript[] = [];
  const floor = opts.since?.getTime() ?? 0;

  for (const slug of readdirSync(PROJECTS)) {
    let files: string[];
    try {
      files = readdirSync(join(PROJECTS, slug));
    } catch {
      continue; // not a directory, or gone between the two reads
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(PROJECTS, slug, f);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs <= floor) continue;
      out.push({
        uuid: f.slice(0, -'.jsonl'.length),
        file,
        slug,
        modifiedAt: st.mtime.toISOString(),
        bytes: st.size,
      });
    }
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return opts.limit ? out.slice(0, opts.limit) : out;
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
