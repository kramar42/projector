import { readFileSync } from 'node:fs';
import { listTranscripts } from '../sources/claude.ts';
import type { IntakeContext } from '../intake/types.ts';
import { within, type Day } from './day.ts';
import { inScope, notesFor, type Scope } from './scope.ts';
import type { Activity, SourceReport } from './types.ts';

/**
 * Claude sessions you worked in on the day, in scope.
 *
 * A session is not a day: one opened on Monday and resumed on Thursday did two
 * days' work, so only the turns stamped inside the window count, and a session
 * whose file was touched but whose turns all fall outside it did nothing today.
 *
 * What is kept is what says what the work was, in the fewest bytes: the prompts
 * you typed, the files the session wrote, and its last word of the day — which
 * is usually a report of what it did. Never the transcript itself: those run to
 * megabytes, and the summariser reading this is paying for every one of them.
 */

const PROMPT_CHARS = 280;
const PROMPTS_KEPT = 10;
const FILES_KEPT = 10;
const LAST_WORD_CHARS = 600;

/** Tools whose input names a file the session wrote. */
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface DaySession {
  title?: string;
  cwd?: string;
  branch?: string;
  prompts: string[];
  firstAt?: string;
  lastAt?: string;
  toolCalls: number;
  files: string[];
  lastWord?: string;
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** What a person typed, from a `user` record — or null for a tool result or harness text. */
function promptOf(rec: Record<string, unknown>): string | null {
  if (rec.isMeta || rec.isSidechain) return null;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => (b as { type?: string })?.type === 'tool_result')) return null;
    text = content
      .filter((b) => (b as { type?: string })?.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join(' ');
  }
  return typed(text);
}

/** Housekeeping commands, which say nothing about the work. */
const HOUSEKEEPING = new Set(['/compact', '/clear', '/context', '/cost', '/model', '/resume', '/exit']);

/**
 * The part of a message a person typed, or null when the harness wrote it.
 *
 * A slash command arrives wrapped and its name is what was asked for; a `!`
 * shell line arrives as `<bash-input>` and is something you ran. Every other
 * angle-bracketed message — a task notification, a system reminder — is the
 * harness talking, and so is the summary a compacted session restarts from.
 */
export function typed(raw: string): string | null {
  const text = raw.trim();
  if (!text || HOUSEKEEPING.has(text)) return null;
  const command = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (command) {
    const name = command[1]!.trim();
    return HOUSEKEEPING.has(name) ? null : name;
  }
  const shell = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (shell) return `$ ${shell[1]!.trim()}`;
  if (text.startsWith('<')) return null;
  if (text.startsWith('This session is being continued from a previous conversation')) return null;
  return text;
}

/** Read one transcript and keep only the day's part of it. */
export function daySession(file: string, day: Day): DaySession {
  const s: DaySession = { prompts: [], toolCalls: 0, files: [] };
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return s;
  }
  const files = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // Titles carry no timestamp and the latest one stands.
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') s.title = rec.customTitle;
    s.cwd ??= typeof rec.cwd === 'string' ? rec.cwd : undefined;
    const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
    if (!within(ts, day) || rec.isSidechain) continue;
    // `HEAD` is what a session outside a repo, or on a detached one, reports.
    if (typeof rec.gitBranch === 'string' && rec.gitBranch && rec.gitBranch !== 'HEAD') s.branch = rec.gitBranch;
    s.firstAt ??= ts;
    s.lastAt = ts;

    if (rec.type === 'user') {
      const p = promptOf(rec);
      if (p) s.prompts.push(p);
    } else if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && typeof rec.content === 'string') {
      // A prompt typed while the session was busy; it lands again as a user
      // record, which the dedupe below collapses.
      const p = typed(rec.content);
      if (p) s.prompts.push(p);
    } else if (rec.type === 'assistant') {
      const content = (rec.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as { type?: string; name?: string; text?: string; input?: Record<string, unknown> }[]) {
        if (b.type === 'tool_use') {
          s.toolCalls++;
          const path = b.input?.file_path ?? b.input?.notebook_path;
          if (b.name && WRITERS.has(b.name) && typeof path === 'string') files.add(path);
        } else if (b.type === 'text' && b.text?.trim()) {
          s.lastWord = b.text;
        }
      }
    }
  }
  const seen = new Set<string>();
  const prompts = s.prompts.map((p) => clip(p, PROMPT_CHARS)).filter((p) => !seen.has(p) && seen.add(p));
  s.prompts =
    prompts.length > PROMPTS_KEPT
      ? [...prompts.slice(0, PROMPTS_KEPT / 2), `… ${prompts.length - PROMPTS_KEPT} more …`, ...prompts.slice(-PROMPTS_KEPT / 2)]
      : prompts;
  s.files = [...files].slice(0, FILES_KEPT);
  if (files.size > FILES_KEPT) s.files.push(`… ${files.size - FILES_KEPT} more`);
  if (s.lastWord) s.lastWord = clip(s.lastWord, LAST_WORD_CHARS);
  return s;
}

const localTime = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

export function claudeSource(ctx: IntakeContext, scope: Scope, day: Day): SourceReport {
  const activities: Activity[] = [];
  let outside = 0;
  // mtime is the cheap pass: a file untouched since the day began has no turn in it.
  for (const t of listTranscripts({ since: day.start })) {
    const s = daySession(t.file, day);
    if (!s.firstAt || !s.prompts.length) continue;
    if (!inScope(scope, s.cwd)) {
      outside++;
      continue;
    }
    activities.push({
      source: 'claude',
      at: s.firstAt,
      kind: 'session',
      title: s.title ?? s.prompts[0]!,
      ref: `claude:${t.uuid}`,
      where: s.branch ? `${s.cwd} @ ${s.branch}` : s.cwd,
      detail: [
        `until ${localTime(s.lastAt!)} · ${s.prompts.length} prompt(s) · ${s.toolCalls} tool call(s)`,
        ...s.prompts.map((p) => `> ${p}`),
        ...(s.files.length ? [`wrote: ${s.files.join(', ')}`] : []),
        ...(s.lastWord ? [`last word: ${s.lastWord}`] : []),
      ],
      notes: notesFor(ctx, {
        cwd: s.cwd,
        branch: s.branch,
        text: s.prompts.join('\n'),
        links: [`claude:${t.uuid}`],
      }),
    });
  }
  activities.sort((a, b) => a.at.localeCompare(b.at));
  return {
    source: 'claude',
    fetched: true,
    reason: outside ? `${outside} session(s) outside the work scope left out` : undefined,
    activities,
  };
}
