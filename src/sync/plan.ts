/**
 * What syncing a view to a folder would write, worked out before anything is
 * written.
 *
 * The command that applies this is the one write in the system whose target is
 * *outside* the vault, and the only one whose mistake is not recoverable by
 * editing a file: a note shared once has been read. So it is planned and printed
 * first, and applying is a second decision — the propose-and-stop every skill
 * already keeps for the same reason, one step further out.
 *
 * Membership is the view's own query, deliberately. The alternative was a
 * hand-kept list of what to share, which is a second copy of a project to
 * maintain and would be wrong the first week. What guards a computed membership
 * is not a smaller query, it is the plan being read: a note entering the set is a
 * line in the report, marked as new, before it is a file on somebody's disk.
 *
 * It runs one way today and the word is still `sync`, because the direction that
 * is missing is the one the render is built for: the same notes always produce
 * the same bytes, so a difference between the folder and a fresh render is
 * somebody's edit and nothing else. That is what a sync back will read — and it
 * is already what `MANIFEST` is read for here, one step short of merging.
 *
 * **A sync owns only what it wrote.** The first version computed removals as
 * *everything in the folder this run did not produce*, which is a different
 * sentence than it looks: it deleted files a person had put there. That is not a
 * hypothetical — it took a hand-written front page, a 63-line document and a
 * 269-line asset out of a real folder on the first run after somebody edited it.
 * So the paths a run writes are recorded, and everything below turns on that
 * record: a path nobody recorded is not ours to overwrite and not ours to
 * delete, and a recorded path whose bytes have since changed is somebody's edit
 * and stops the write rather than losing it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { docPath } from '../vault.ts';
import { paths } from '../config.ts';
import { bodyImages, bodyLinks, hrefTarget, pathTarget } from '../schema/body.ts';
import { renderShared, type Companions } from './render.ts';
import type { Note } from '../schema/types.ts';

/**
 * Where a run records what it wrote into one folder.
 *
 * In the vault, under `.projector/`, and emphatically not in the folder itself —
 * which is where it started, and was wrong for a reason worth keeping written
 * down: the target is a repository other people work in, and a file named after
 * one person's tool does not belong in everyone's checkout. The reasoning that
 * put it there ("then a fresh clone can read it") assumed a reader that does not
 * exist. Only this machine runs the sync, so the record is this machine's.
 *
 * Keyed by view *and* target, because neither alone identifies a sync: one view
 * can be written to two folders, and one folder can be fed by two views. The
 * hash is of the resolved target path, and the path is repeated inside the file
 * so it can be read without recomputing anything.
 */
export function recordFor(root: string, view: string, target: string): string {
  const key = createHash('sha256').update(target, 'utf8').digest('hex').slice(0, 8);
  return join(paths(root).syncRecords, `${view}-${key}.json`);
}

/**
 * The folder's front page.
 *
 * Seeded when there is none and then left alone for good — including by the
 * prune, which is the subtlety: it is a path a run once wrote and stops
 * producing, and every *other* path in that position is a note that left the view
 * and should go. This one is the folder's own page by then, so it is the one
 * recorded path that is never a removal candidate.
 */
const INDEX = 'README.md';

/**
 * What a run does with one path.
 *
 * `unmanaged` and `conflict` are the two the manifest exists for, and they are
 * different questions with the same answer. *Unmanaged*: no run ever recorded
 * this path, so somebody else made it — a front page written by hand, a document
 * dropped in the folder. *Conflict*: a run did write it, and the bytes have
 * changed since, so somebody edited the shared copy. Neither is written, both are
 * reported, and `--adopt` is how you say the sync should own it anyway.
 */
export type FileState = 'new' | 'changed' | 'same' | 'unmanaged' | 'conflict';

/** One file the plan would write, and what the target already has to say about it. */
export interface PlannedFile {
  /** Where it goes, relative to the target folder. */
  path: string;
  content: string;
  state: FileState;
}

/**
 * Everything one sync needs, and all of it from the invocation.
 *
 * The destination is an argument rather than a key in the view file: a view is a
 * query and nothing else, and where its answer gets written is a property of the
 * run. Which also means nothing in the vault records that a view is shared —
 * `--exclude` is spelled out every time, and that is the honest shape for a
 * command whose target is somebody else's disk.
 */
export interface SyncOptions {
  root: string;
  /** The folder the view is written into, already resolved. */
  target: string;
  /**
   * Which view this is, which is half of the record's identity — see `recordFor`.
   *
   * The plan needs it only for that. Everything else about the view arrives
   * already answered, in `ordered`.
   */
  view: string;
  /**
   * Notes held back, as facet values.
   *
   * A facet rather than a flag in code, because no facet is privileged (C4) and
   * the vault owns its own vocabulary: one vault says `private: [true]` and
   * another `audience: [internal]`, and neither word appears in this file.
   */
  exclude?: Record<string, string[]>;
  /** For a `jira:` ref's href. Configuration, not a fetch. */
  jiraBase: string | null;
  /**
   * Claim every path this run produces, whatever the folder says about it.
   *
   * The escape hatch for the two states the record introduces, and the only way
   * to resolve either: a folder that predates the record (nothing is recorded, so
   * everything reads `unmanaged`), or a shared copy whose edits have already been
   * taken back into the vault and should now be overwritten. Explicit, per run,
   * and never a default — the whole point of the record is that it says no.
   */
  adopt?: boolean;
  /**
   * The note the index leads with, and the name the folder goes under.
   *
   * Both come off the view rather than being invented here: a focused view
   * already declares its centre, and that centre is what a reader coming cold
   * should open first. Without them the index is the view's *sort* order, which
   * is the order you last touched things — right for the person working and
   * useless for the person arriving.
   */
  lead?: string;
  title?: string;
}

export interface SyncPlan {
  target: string;
  /** Where this sync's record is kept — in the vault, never in the target. */
  record: string;
  files: PlannedFile[];
  /** Files a previous run wrote that this view no longer names — an unshare must unshare. */
  remove: string[];
  /**
   * Recorded files this view no longer names whose bytes have since changed.
   *
   * Left in place rather than removed, and reported: an unshare must unshare, but
   * not by throwing away the only copy of somebody's edit. Take it back into the
   * vault, or delete it by hand once you have read it.
   */
  orphaned: string[];
  /** Notes the query selected and the exclusion held back, with the value that did it. */
  held: { id: string; title: string; because: string }[];
  /**
   * Notes the shared ones point at that are not themselves shared, and who points
   * at them.
   *
   * Every one of these is a link the reader does not get — unwrapped to its own
   * text, which is the only honest outcome — so this list is the strongest signal
   * that a set is drawn too small. It is reported rather than acted on: a note
   * with eight references into it probably belongs in the view, and a note with
   * one is probably an aside. Neither is a judgement a planner should make.
   */
  cut: { id: string; title: string; from: string[] }[];
}

/** The name a shared note goes under: flat, and its id, so a link is predictable. */
const fileFor = (id: string): string => `${id}.md`;

/**
 * Which assets travel with a note: the ones it *links*.
 *
 * Being mentioned in the prose is not enough, and that asymmetry is the feature.
 * An asset is a working document — an inventory, a transcript, a dump — written
 * for whoever was in the middle of the problem. Promoting one to a `links:` entry
 * is a decision somebody made about that file; a path typed inside a sentence is
 * not. So the note that is worthless without its asset directory carries it,
 * and the note that merely says where the evidence lives keeps the evidence home.
 */
function assetsOf(note: Note, root: string): Map<string, string> {
  const out = new Map<string, string>();
  const assets = paths(root).assets;
  const travels = (at: string | null) => {
    if (at === null || !at.startsWith(assets + sep)) return;
    if (!existsSync(at) || !statSync(at).isFile()) return;
    out.set(at, `assets/${relative(assets, at)}`);
  };
  for (const link of note.links) {
    if (link.kind === 'doc') travels(docPath(link.ref, root));
  }
  // An image is the exception to the rule above, and for the same reason it is
  // the exception in the renderer: it is displayed, not followed. A body that
  // shows a picture has to arrive with the picture, whether or not anybody
  // thought to also list it as a link.
  for (const image of bodyImages(note.body)) travels(pathTarget(image.href, note.file));
  return out;
}

/** Every file already in the target, so the plan can say new, changed or gone. */
function present(target: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(target, full), readFileSync(full, 'utf8'));
    }
  };
  if (existsSync(target)) walk(target);
  return out;
}

/**
 * The paths a previous run wrote, and what it wrote there.
 *
 * A missing or unreadable record means *nothing is ours*, which is the safe
 * reading rather than the convenient one: a folder somebody has been keeping by
 * hand looks exactly like a folder a run has never touched, and treating either
 * as ours is how the files went missing.
 */
function recorded(at: string): Map<string, string> {
  try {
    const raw = JSON.parse(readFileSync(at, 'utf8')) as { files?: Record<string, string> };
    return new Map(Object.entries(raw.files ?? {}));
  } catch {
    return new Map();
  }
}

/** A path's content as this run last wrote it, keyed by path. Sorted, so the file is a stable diff. */
function manifestOf(target: string, files: ReadonlyMap<string, string>): string {
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  return `${JSON.stringify(
    {
      note: 'Written by `pj sync`. It records what one folder was given, so a later run prunes only its own files and refuses to overwrite an edit. Delete it and the next run treats every file there as somebody else\'s.',
      target,
      files: Object.fromEntries(entries.map(([path, content]) => [path, digest(content)])),
    },
    null,
    2,
  )}\n`;
}

/** Content identity, short. Not security — only "are these the bytes we left". */
function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * The index, so the folder is a document rather than twenty loose files.
 *
 * Two decisions, and both are read off the view rather than chosen here.
 *
 * **The lead** is the view's focus. A reader arriving cold needs one door, and a
 * focused view has already named it — the note everything else was gathered
 * around. It is pulled out of the list rather than sorted to the top, because
 * *first in a list of twenty-one* is not the same as *the way in*, and only one
 * of those two things is what a newcomer needs said out loud.
 *
 * **Everything after it** stays in the view's own order (C9: a view is a query
 * *and* a sort). Re-sorting here would be this function inventing a reading
 * order the author never expressed; if the order reads wrong, the view's `sort:`
 * is where it is wrong, and fixing it there fixes both the folder and the board.
 *
 * No date, no count, nothing that changes when nothing changed: the target is a
 * git repository and `git log` already answers when this was current. A
 * "generated on" line would make every sync a diff.
 */
function indexOf(notes: readonly Note[], options: SyncOptions): string {
  const lead = notes.find((n) => n.id === options.lead);
  const lines = [`# ${options.title?.trim() || 'Contents'}`, ''];
  if (lead) {
    lines.push(`Start with [${lead.title}](${fileFor(lead.id)}).`, '');
  }
  for (const note of notes) {
    if (note.id === lead?.id) continue;
    lines.push(`- [${note.title}](${fileFor(note.id)})`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Plan a sync: what the folder would contain, and what it would stop containing.
 *
 * `ordered` is the view's result, already sorted — this does not re-run the
 * query, because the whole point is that the shared set *is* what the view
 * shows (C9). Held notes are removed here rather than by the query so the report
 * can name them: a note you deliberately keep back is worth seeing in the plan,
 * where a note the query never selected is not.
 */
export function planSync(
  ordered: readonly Note[],
  all: ReadonlyMap<string, Note>,
  options: SyncOptions,
): SyncPlan {
  const held: SyncPlan['held'] = [];
  const sharing: Note[] = [];
  for (const note of ordered) {
    const because = Object.entries(options.exclude ?? {})
      .flatMap(([facet, values]) =>
        (note.facets[facet] ?? []).filter((v) => values.includes(v)).map((v) => `${facet}: ${v}`),
      )
      .join(', ');
    if (because) held.push({ id: note.id, title: note.title, because });
    else sharing.push(note);
  }

  const ids = new Set(sharing.map((n) => n.id));
  // Every note in the vault, not only the shared ones: the renderer has to tell
  // "a note nobody is sharing" from "not a note at all", and the report
  // has to name the first kind.
  const byFile = new Map([...all.values()].map((n) => [n.file, n]));
  const assets = new Map<string, string>();
  for (const note of sharing) {
    for (const [from, to] of assetsOf(note, options.root)) assets.set(from, to);
  }

  const companions: Companions = {
    fileOf: (id) => (ids.has(id) ? fileFor(id) : null),
    noteAt: (path) => byFile.get(path)?.id ?? null,
    assetAt: (path) => assets.get(path) ?? null,
    docAt: (ref) => docPath(ref, options.root),
    jiraBase: options.jiraBase,
  };

  const already = present(options.target);
  const mine = recorded(recordFor(options.root, options.view, options.target));

  const written = new Map<string, string>();
  // The front page is written for a folder that has none, and never again.
  //
  // A generated list of titles is a reasonable *first* page and a poor permanent
  // one: the useful version groups the notes, says what each is in a line, and
  // carries a verified date per note — none of which is derivable, all of which
  // is knowledge somebody has. So the generator seeds an empty folder and then
  // gets out of the way. (The `unmanaged` rule below would protect a hand-written
  // README anyway; this states the intent rather than relying on the mechanism.)
  if (!already.has(INDEX)) written.set(INDEX, indexOf(sharing, options));
  for (const note of sharing) written.set(fileFor(note.id), renderShared(note, companions));
  for (const [from, to] of assets) written.set(to, readFileSync(from, 'utf8'));

  const files: PlannedFile[] = [...written].map(([path, content]) => {
    const disk = already.get(path);
    if (disk === undefined) return { path, content, state: 'new' as const };
    if (options.adopt) {
      return { path, content, state: disk === content ? ('same' as const) : ('changed' as const) };
    }
    const was = mine.get(path);
    // Nobody recorded writing it, so it is not ours to replace.
    if (was === undefined) return { path, content, state: 'unmanaged' as const };
    // Ours, but not as we left it.
    if (was !== digest(disk)) return { path, content, state: 'conflict' as const };
    return { path, content, state: disk === content ? ('same' as const) : ('changed' as const) };
  });

  const cut = new Map<string, { id: string; title: string; from: string[] }>();
  for (const note of sharing) {
    for (const link of bodyLinks(note.body)) {
      const at = hrefTarget(link.href, note.file);
      const to = at === null ? undefined : byFile.get(at);
      if (!to || ids.has(to.id)) continue;
      const seen = cut.get(to.id) ?? { id: to.id, title: to.title, from: [] };
      if (!seen.from.includes(note.id)) seen.from.push(note.id);
      cut.set(to.id, seen);
    }
  }

  // Only what a run recorded writing, and only where the bytes are still the ones
  // it left. Everything else in the folder belongs to whoever put it there.
  const stale = [...mine.keys()].filter(
    (path) => path !== INDEX && !written.has(path) && already.has(path),
  );
  return {
    target: options.target,
    record: recordFor(options.root, options.view, options.target),
    files,
    remove: stale.filter((path) => mine.get(path) === digest(already.get(path)!)).sort(),
    orphaned: stale.filter((path) => mine.get(path) !== digest(already.get(path)!)).sort(),
    held,
    cut: [...cut.values()].sort((a, b) => b.from.length - a.from.length || a.id.localeCompare(b.id)),
  };
}

/**
 * The plan as a person reads it, which is the half that does the guarding.
 *
 * Ordered by what would surprise you: what is new, then what changed, then what
 * would be removed, then what it refuses to touch, then the notes held back and
 * the links being cut. `same` is counted and not listed — a sync that writes
 * nothing new should say so in one line rather than in twenty.
 */
export function renderPlan(plan: SyncPlan, view: string): string {
  const lines = [`syncing view "${view}" into ${plan.target}`, ''];
  const by = (state: PlannedFile['state']) => plan.files.filter((f) => f.state === state);
  for (const file of by('new')) lines.push(`  new      ${file.path}`);
  for (const file of by('changed')) lines.push(`  changed  ${file.path}`);
  for (const path of plan.remove) lines.push(`  remove   ${path}`);
  const same = by('same').length;
  if (same) lines.push(`  ${same} file(s) already up to date`);

  // Before the softer reports, because these are the lines that say a write is
  // *not* happening — and the reason somebody re-runs the command.
  const guarded = [...by('unmanaged'), ...by('conflict')];
  if (guarded.length) {
    lines.push('', 'left alone — this sync does not own these:');
    for (const file of by('unmanaged')) lines.push(`  unmanaged  ${file.path}  (written by somebody else)`);
    for (const file of by('conflict')) lines.push(`  conflict   ${file.path}  (edited since this sync wrote it)`);
    lines.push('', 'Take those edits back into the vault, or pass --adopt to overwrite them.');
  }
  if (plan.orphaned.length) {
    lines.push('', 'no longer shared, but edited here — not removed:');
    for (const path of plan.orphaned) lines.push(`  kept     ${path}`);
  }

  if (plan.held.length) {
    lines.push('', 'held back:');
    for (const h of plan.held) lines.push(`  ${h.id} — ${h.because}`);
  }
  if (plan.cut.length) {
    lines.push('', 'referenced but not shared — these links become plain text:');
    for (const c of plan.cut) {
      lines.push(`  ${c.id} — named by ${c.from.length}: ${c.from.join(', ')}`);
    }
  }
  const writes = by('new').length + by('changed').length + plan.remove.length;
  lines.push('');
  lines.push(writes ? `${writes} change(s). Nothing written — pass --apply.` : 'nothing to do.');
  return lines.join('\n');
}

/**
 * Write the plan.
 *
 * Removals happen last and only of files this view wrote before, which is the one
 * safety property that matters here: the target is outside the vault, and a
 * folder somebody else also keeps files in must not be swept by a sync. A
 * dotfile is never touched — that is how the target stays a git repository.
 */
export function applySync(plan: SyncPlan): { written: number; removed: number; skipped: number } {
  let written = 0;
  let skipped = 0;
  // What the record will say afterwards. It carries every path this sync owns —
  // the ones just written and the ones already correct — and deliberately not the
  // ones it declined to touch, since those are somebody else's and must keep
  // reading `unmanaged` on the next run.
  const owned = new Map<string, string>();
  for (const file of plan.files) {
    if (file.state === 'unmanaged' || file.state === 'conflict') {
      skipped++;
      continue;
    }
    owned.set(file.path, file.content);
    if (file.state === 'same') continue;
    const full = join(plan.target, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, 'utf8');
    written++;
  }
  for (const path of plan.remove) {
    rmSync(join(plan.target, path), { force: true });
  }
  // Last, and only if something was actually owned: a record written before the
  // files would claim paths that a crash never wrote.
  if (owned.size) {
    mkdirSync(dirname(plan.record), { recursive: true });
    writeFileSync(plan.record, manifestOf(plan.target, owned), 'utf8');
  }
  return { written, removed: plan.remove.length, skipped };
}
