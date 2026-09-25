import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { paths } from '../config.ts';
import { loadFacets } from '../schema/facets.ts';
import { parseNote } from '../schema/note.ts';
import type { Note } from '../schema/types.ts';
import type { IntakeContext } from '../intake/types.ts';
import { localDate, type Day } from './day.ts';
import type { Activity, SourceReport } from './types.ts';

/**
 * Notes you created, closed or moved on the day.
 *
 * Not `pj log`, although it answers a neighbouring question. `pj log` reads the
 * vault's commits, and a vault committed in bulk every few days has no commit on
 * most days — the day's work sits in the working tree, or in a commit named
 * `latest` three days later. So the notes' own `created` and `updated` stamps
 * nominate what was touched, and each is compared with itself as it stood at
 * the last commit before the day began.
 *
 * The "after" side is the working tree when that is still the day's state — the
 * note was last updated that day — and otherwise the last commit before the day
 * ended. A note edited again since has lost the evidence of what the day did to
 * it, unless a commit that day caught it; that is said here rather than guessed.
 *
 * Every single-valued axis is compared, the way `pj log` does, because no facet
 * is privileged (C4): which one means *status* is the vocabulary's business, and
 * crossing its `closed` boundary is what makes a change a finish.
 */

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function noteAt(root: string, rev: string | null, rel: string): Note | null {
  if (!rev) return null;
  const text = git(root, ['show', `${rev}:${rel}`]);
  if (text === null) return null;
  const res = parseNote(rel, text, '.');
  return res.ok ? res.rec : null;
}

const value = (n: Note | null, facet: string) => n?.facets[facet]?.join(', ') ?? null;

export function vaultSource(ctx: IntakeContext, day: Day): SourceReport {
  const root = ctx.root;
  if (git(root, ['rev-parse', '--git-dir']) === null) {
    return { source: 'vault', fetched: false, reason: 'the vault is not a git repository', activities: [] };
  }
  const facets = loadFacets(paths(root).facets);
  const watched = Object.entries(facets).filter(([, d]) => d.single).map(([name]) => name);
  const shuts = (facet: string, v: string | null) => v !== null && !!facets[facet]?.closed?.includes(v);

  const before = git(root, ['rev-list', '-1', `--before=${day.start.toISOString()}`, 'HEAD'])?.trim() || null;
  const endRev = git(root, ['rev-list', '-1', `--before=${day.end.toISOString()}`, 'HEAD'])?.trim() || null;
  const today = day.day === localDate(new Date());

  // Files the day's own commits touched, for a note whose stamp moved on since.
  const committed = new Set(
    (git(root, [
      'log',
      `--since=${day.start.toISOString()}`,
      `--until=${day.end.toISOString()}`,
      '--name-only',
      '--format=',
    ]) ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.md')),
  );

  const activities: Activity[] = [];
  for (const note of ctx.notes.values()) {
    const rel = relative(root, note.file);
    const stamped = note.created === day.day || note.updated === day.day;
    if (!stamped && !committed.has(rel)) continue;

    const current = today || note.updated === day.day;
    const after = current ? note : noteAt(root, endRev, rel);
    if (!after) continue;
    const was = noteAt(root, before, rel);

    const changes: string[] = [];
    let closed: boolean | null = null;
    for (const facet of watched) {
      const from = value(was, facet);
      const to = value(after, facet);
      if (from === to || !was) continue;
      changes.push(`${facet}: ${from ?? '(none)'} → ${to ?? '(none)'}`);
      if (shuts(facet, from) !== shuts(facet, to)) closed = shuts(facet, to);
    }
    const kind = !was
      ? 'note-created'
      : closed === true
        ? 'note-closed'
        : closed === false
          ? 'note-reopened'
          : changes.length
            ? 'note-moved'
            : 'note-edited';
    if (kind === 'note-edited' && !stamped) continue;
    const now = watched.map((f) => [f, value(after, f)] as const).filter(([, v]) => v !== null);
    activities.push({
      source: 'vault',
      // A stamp is a date, not a moment; the report says so rather than invent a time.
      at: day.day,
      kind,
      title: after.title,
      ref: note.id,
      where: rel,
      detail: [...changes, ...(changes.length ? [] : [now.map(([f, v]) => `${f}: ${v}`).join(', ')])].filter(Boolean),
      notes: [{ id: note.id, why: 'is the note' }],
    });
  }
  const order = ['note-closed', 'note-created', 'note-moved', 'note-reopened', 'note-edited'];
  activities.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.title.localeCompare(b.title));
  return { source: 'vault', fetched: true, activities };
}
