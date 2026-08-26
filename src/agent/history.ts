import { execFileSync } from 'node:child_process';
import { paths } from '../config.ts';
import { loadFacets } from '../schema/facets.ts';
import { isNotePath, parseNote } from '../schema/note.ts';
import type { Note } from '../schema/types.ts';

/**
 * What happened to the notes recently, read out of git.
 *
 * The vault is git-tracked and every note write is a commit-shaped change to one
 * file (C1), so the history of the work is already on disk — it was simply never
 * read. Nothing here is stored: `updated` is a single overwritten date and can
 * only ever say *when* a note last moved, never *what* it did.
 *
 * The transitions come from comparing the two versions of each file through the
 * real note parser, not from scraping `+`/`-` lines out of a diff. A diff line
 * only reads if the frontmatter happens to be block style, and
 * `facets: { status: [done] }` is just as valid — so the cheap answer and the
 * exact one differ, and this takes the exact one. `git log --raw` names both
 * blobs of every change and `git cat-file --batch` returns all of them at once,
 * so it stays two subprocesses whatever the size of the window.
 *
 * Read-only, and `git` is called with an argument array — no shell, so nothing is
 * interpolated into a command line.
 */

export type Change =
  | { kind: 'created'; id: string; title: string }
  | { kind: 'deleted'; id: string; title: string }
  /**
   * One axis moved. It was two variants, `status` and `due`, named in code — so a
   * vault renaming either lost its log and a vault with a third axis worth
   * watching could not have one.
   *
   * Every **single-valued** facet is narrated, which is the derivable form of the
   * choice those two names were making: a note holds one value on such an axis,
   * so changing it is a transition. A multi-valued axis accumulates, and "tech
   * gained k8s" is not an event in the same sense.
   */
  | { kind: 'facet'; facet: string; id: string; title: string; from: string | null; to: string | null };

export interface Commit {
  sha: string;
  date: string;
  author: string;
  subject: string;
  changes: Change[];
}

export interface HistoryReport {
  since: string;
  commits: Commit[];
  /**
   * Ids whose last transition in the window crossed the `closed` boundary.
   *
   * `started` used to sit beside `finished` and could not survive: it read
   * `to === 'active'`, and nothing in the vocabulary declares which value means
   * *started*. `closed` does declare the other boundary, so what is derivable is
   * crossing it — in, and back out.
   */
  finished: string[];
  reopened: string[];
  created: string[];
}

/**
 * Separators a commit message cannot contain.
 *
 * Passed to git as its own `%xNN` placeholders rather than as literal control
 * bytes: `execFile` refuses an argument holding a NUL, so git has to be the one
 * that expands them.
 */
const REC_FMT = '%x00';
const FIELD_FMT = '%x1f';
const REC = '\u0000';
const FIELD = '\u001f';

/** git's "this side does not exist" blob, for an add or a delete. */
const ABSENT = '0'.repeat(40);

function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The same call, undecoded — for output that must be walked by byte count. */
function gitBytes(root: string, args: string[], input?: string): Buffer {
  return execFileSync('git', ['-C', root, ...args], { input, maxBuffer: 256 * 1024 * 1024 });
}

export function isRepo(root: string): boolean {
  try {
    git(root, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

interface RawChange {
  path: string;
  before: string;
  after: string;
}

interface RawCommit {
  sha: string;
  date: string;
  author: string;
  subject: string;
  files: RawChange[];
}

/** `:100644 100644 <before> <after> M\tnotes/x.md` — one line per changed file. */
const RAW = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*\t(.+)$/;

function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const chunk of out.split(REC)) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const header = (nl === -1 ? chunk : chunk.slice(0, nl)).split(FIELD);
    if (header.length < 4) continue;
    const [sha, date, author, subject] = header as [string, string, string, string];
    const files: RawChange[] = [];
    for (const line of (nl === -1 ? '' : chunk.slice(nl + 1)).split('\n')) {
      const m = RAW.exec(line);
      if (m && isNotePath(m[3]!)) files.push({ before: m[1]!, after: m[2]!, path: m[3]! });
    }
    if (files.length) commits.push({ sha, date, author, subject, files });
  }
  return commits;
}

/**
 * Fetch every blob named, in one `git cat-file --batch`.
 *
 * The batch protocol answers each request with `<sha> blob <size>\n<size bytes>\n`,
 * so the reply is walked by byte count rather than by line — a note body holds
 * newlines and a line-oriented read would resynchronise on one of them.
 */
function readBlobs(root: string, shas: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  const wanted = [...shas].filter((s) => s !== ABSENT);
  if (!wanted.length) return out;

  // Walked as bytes, because `<size>` is a byte count. Decoding first and
  // slicing the string walked UTF-16 code units instead: one em dash in a note
  // put the walk two bytes into the next record's header, and every blob after
  // the drift was misread or lost — a modified note whose `after` goes missing
  // narrates as deleted.
  const raw = gitBytes(root, ['cat-file', '--batch'], wanted.join('\n') + '\n');
  let at = 0;
  while (at < raw.length) {
    const eol = raw.indexOf(0x0a, at);
    if (eol === -1) break;
    const [sha, type, size] = raw.toString('utf8', at, eol).split(' ');
    at = eol + 1;
    if (!sha || type !== 'blob' || size === undefined) continue;
    const n = Number(size);
    out.set(sha, raw.toString('utf8', at, at + n));
    at += n + 1; // the newline the batch protocol adds after each body
  }
  return out;
}

/** Parse a blob as a note, or null when it is absent or unreadable. */
function recordOf(text: string | undefined, path: string): Note | null {
  if (text === undefined) return null;
  const res = parseNote(path, text);
  return res.ok ? res.rec : null;
}

/** One axis's values as the log prints them, or null when it carries none. */
function valueOf(rec: Note | null, facet: string): string | null {
  return rec?.facets[facet]?.join(', ') ?? null;
}

/**
 * Note changes since `since` — anything `git log --since` accepts: `1 week ago`,
 * `2026-08-01`, `yesterday`.
 */
export function history(dataRoot: string, since = '1 week ago'): HistoryReport {
  const facets = loadFacets(paths(dataRoot).facets);
  // The axes a note holds one of, so moving one is a transition rather than an
  // accumulation. Declaration order, so a log reads in the vocabulary's order.
  const watched = Object.entries(facets)
    .filter(([, def]) => def.single)
    .map(([name]) => name);
  // The whole vault: the notes are the repository's contents now, not a folder
  // inside it. A pathspec is still passed rather than dropped, so `--` keeps
  // separating paths from revisions.
  const cards = '.';
  const raw = parseLog(
    git(dataRoot, [
      'log',
      `--since=${since}`,
      '--date=short',
      `--format=${REC_FMT}%H${FIELD_FMT}%ad${FIELD_FMT}%an${FIELD_FMT}%s`,
      '--raw',
      '--no-abbrev',
      '--no-renames',
      '--',
      cards,
    ]),
  );

  const blobs = readBlobs(
    dataRoot,
    new Set(raw.flatMap((c) => c.files.flatMap((f) => [f.before, f.after]))),
  );

  const commits: Commit[] = [];
  for (const c of raw) {
    const changes: Change[] = [];
    for (const f of c.files) {
      const before = recordOf(blobs.get(f.before), f.path);
      const after = recordOf(blobs.get(f.after), f.path);
      const rec = after ?? before;
      if (!rec) continue;
      const { id, title } = rec;

      if (!before) changes.push({ kind: 'created', id, title });
      else if (!after) changes.push({ kind: 'deleted', id, title });
      else {
        for (const facet of watched) {
          const from = valueOf(before, facet);
          const to = valueOf(after, facet);
          if (from !== to) changes.push({ kind: 'facet', facet, id, title, from, to });
        }
      }
    }
    if (changes.length) {
      commits.push({
        sha: c.sha.slice(0, 8),
        date: c.date,
        author: c.author,
        subject: c.subject,
        changes,
      });
    }
  }

  const finished = new Set<string>();
  const reopened = new Set<string>();
  const created = new Set<string>();
  const shuts = (facet: string, value: string | null) =>
    value !== null && !!facets[facet]?.closed?.includes(value);
  // Oldest first, so the last transition in the window is the one that stands.
  for (const c of [...commits].reverse()) {
    for (const ch of c.changes) {
      if (ch.kind === 'created') created.add(ch.id);
      if (ch.kind !== 'facet' || !facets[ch.facet]?.closed?.length) continue;
      const was = shuts(ch.facet, ch.from);
      const is = shuts(ch.facet, ch.to);
      if (was === is) continue;
      if (is) {
        finished.add(ch.id);
        reopened.delete(ch.id);
      } else {
        reopened.add(ch.id);
        finished.delete(ch.id);
      }
    }
  }

  return { since, commits, finished: [...finished], reopened: [...reopened], created: [...created] };
}

export function formatHistory(r: HistoryReport): string {
  const L: string[] = [`# since ${r.since}\n`];
  if (!r.commits.length) {
    L.push('no note changes committed in this window');
    return L.join('\n');
  }
  for (const c of r.commits) {
    L.push(`${c.date}  ${c.sha}  ${c.subject}`);
    for (const ch of c.changes) {
      if (ch.kind === 'created') L.push(`    + ${ch.id} — ${ch.title}`);
      else if (ch.kind === 'deleted') L.push(`    − ${ch.id} — ${ch.title}`);
      else L.push(`      ${ch.id}: ${ch.facet} ${ch.from ?? '—'} → ${ch.to ?? '—'}`);
    }
    L.push('');
  }
  L.push(`${r.finished.length} finished · ${r.reopened.length} reopened · ${r.created.length} created`);
  if (r.finished.length) L.push(`finished: ${r.finished.join(', ')}`);
  return L.join('\n');
}
