import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { firstLine } from './run.ts';

/**
 * Claude sessions, read from disk. No configuration, no MCP, no network.
 *
 * The durable identifier is the transcript uuid — the filename under
 * `~/.claude/projects/<slug>/<uuid>.jsonl`, which is also the `sessionId` a
 * running session records. Ids of the form `local_<uuid>` name a chat in the
 * desktop app's own store instead — a different id space, read here only to map
 * a transcript to the chat that drives it (`desktopSessionFor`).
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
const DESKTOP = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

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

export interface DesktopSession {
  /** The desktop app's own id for the chat — `local_<uuid>`, its uuid not ours. */
  sessionId: string;
  /** The transcript the chat drives. */
  cliSessionId: string;
  title?: string;
  archived: boolean;
  lastFocusedAt: number;
}

/**
 * The desktop app's chat for a transcript, when it has one.
 *
 * One file per chat at `claude-code-sessions/<org>/<account>/<sessionId>.json`,
 * recording the transcript it drives as `cliSessionId`. A chat the app started
 * names itself `local_<its own uuid>`, so a transcript uuid does not name its
 * chat and the mapping only runs this way — by reading the files.
 *
 * Only each file's head is read: they carry the whole MCP config and run to a
 * few hundred kilobytes each, while every field wanted here is in the first one.
 *
 * A transcript can have two chats: the one that ran it, and a duplicate created
 * by importing it again. The live one wins, then the most recently looked at.
 */
export function desktopSessionFor(uuid: string): DesktopSession | null {
  const found: DesktopSession[] = [];
  for (const file of desktopSessionFiles()) {
    const head = readHead(file);
    // Cheap reject before parsing: the id is in the head or the file is not it.
    if (!head || !head.includes(`"cliSessionId":"${uuid}"`)) continue;
    const s = parseHead(head);
    if (s?.cliSessionId === uuid) found.push(s);
  }
  found.sort((a, b) => Number(a.archived) - Number(b.archived) || b.lastFocusedAt - a.lastFocusedAt);
  return found[0] ?? null;
}

function desktopSessionFiles(): string[] {
  if (!existsSync(DESKTOP)) return [];
  const out: string[] = [];
  for (const org of readdirSync(DESKTOP)) {
    for (const account of readdirSync(join(DESKTOP, org), { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const dir = join(DESKTOP, org, account.name);
      try {
        for (const f of readdirSync(dir)) if (f.endsWith('.json')) out.push(join(dir, f));
      } catch {
        /* gone between the two reads */
      }
    }
  }
  return out;
}

function readHead(file: string, bytes = 1024): string | null {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The head is a truncated object, so read the fields out of it rather than parse. */
function parseHead(head: string): DesktopSession | null {
  const str = (k: string) => head.match(new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
  const sessionId = str('sessionId');
  const cliSessionId = str('cliSessionId');
  if (!sessionId || !cliSessionId) return null;
  return {
    sessionId,
    cliSessionId,
    title: str('title'),
    archived: /"isArchived":true/.test(head),
    lastFocusedAt: Number(head.match(/"lastFocusedAt":(\d+)/)?.[1] ?? 0),
  };
}

export interface Turn {
  /** Whose move it is. `model` is the only state that means work is happening. */
  waitingOn: 'model' | 'human';
  /** When the record that decided it was written. */
  at?: string;
}

/**
 * Whose move it is, from the tail of a transcript.
 *
 * A live process is not a working agent. The desktop app keeps one per open
 * chat, so `alive` says a session exists and nothing about whether it is doing
 * anything — which is why a screen full of sessions all read as running.
 *
 * The last conversation record does say. The model owes the next record after a
 * prompt, after a tool result, and while a tool it asked for is still running
 * (an assistant turn that stopped at `tool_use` is not a finished turn); the
 * human owes it once a turn ends, and an interrupt is the human taking the move
 * back mid-turn. Everything else in the file — `mode`, `last-prompt`,
 * `attachment`, the rest — is bookkeeping the session rewrites while nothing is
 * happening, so it is skipped rather than read as activity.
 *
 * Only the tail is read: transcripts reach tens of megabytes and the answer is
 * always in the last few records. Sidechains are skipped too — a subagent's
 * records say what it is doing, not what the session is waiting on.
 */
export function lastTurn(file: string, tailBytes = 256 * 1024): Turn | null {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString('utf8').split('\n');
    // Reading from an offset lands mid-record, and half a record parses as none.
    if (from > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const turn = readTurn(lines[i] ?? '');
      if (turn) return turn;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readTurn(line: string): Turn | null {
  if (!line) return null;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (rec.isSidechain === true) return null;
  const msg = rec.message as { stop_reason?: string; content?: unknown } | undefined;
  const at = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
  if (rec.type === 'assistant') return { waitingOn: msg?.stop_reason === 'tool_use' ? 'model' : 'human', at };
  if (rec.type === 'user') return { waitingOn: interrupted(msg?.content) ? 'human' : 'model', at };
  return null;
}

/** An interrupt is recorded as a user turn saying so, which is not a prompt. */
function interrupted(content: unknown): boolean {
  const isMarker = (t: unknown) => typeof t === 'string' && t.startsWith('[Request interrupted');
  if (typeof content === 'string') return isMarker(content);
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && typeof b === 'object' && isMarker((b as { text?: unknown }).text));
}

/**
 * How long a turn can go quiet before "working" stops being credible. Above the
 * ceiling on a single tool call, so a slow build still reads as work, while a
 * session left mid-turn and later reopened by the desktop app does not.
 */
const STALL_MS = 15 * 60 * 1000;

export type SessionState = 'working' | 'stalled' | 'waiting' | 'closed';

/**
 * What a session is doing, which is a different question from whether a process
 * exists — all `alive` answers, and not much, since the desktop app keeps one
 * per open chat. Working is the model owing the next record and the file saying
 * so recently; waiting is a finished turn, where the move is the human's.
 *
 * The word, not a badge: the board draws it with a glyph and a colour and a
 * sweep prints it as it is, and both should mean the same thing.
 */
export function sessionState(alive: boolean, turn: Turn | null, lastAt?: string): SessionState {
  if (!alive) return 'closed';
  if (turn?.waitingOn !== 'model') return 'waiting';
  const at = turn.at ?? lastAt;
  const quiet = at ? Date.now() - Date.parse(at) : 0;
  return quiet > STALL_MS ? 'stalled' : 'working';
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
