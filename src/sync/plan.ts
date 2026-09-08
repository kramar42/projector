/**
 * What syncing a view to a folder would write, worked out before anything is
 * written.
 *
 * The command that applies this is the one write in the system whose target is
 * *outside* the vault, and the only one whose mistake is not recoverable by
 * editing a file: a note shared once has been read. So it is planned and printed
 * first, and applying is a second decision — the shape `pj-capture` and
 * `pj-triage` already use for the same reason, one step further out.
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
 * somebody's edit and nothing else. That is what a sync back will read.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { docPath } from '../vault.ts';
import { paths } from '../config.ts';
import { bodyImages, bodyLinks, hrefTarget, pathTarget } from '../schema/body.ts';
import { renderShared, type Companions } from './render.ts';
import type { Note } from '../schema/types.ts';

/** One file the plan would write, and whether the target already has it. */
export interface PlannedFile {
  /** Where it goes, relative to the target folder. */
  path: string;
  content: string;
  state: 'new' | 'changed' | 'same';
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
   * Notes held back, as facet values.
   *
   * A facet rather than a flag in code, because no facet is privileged (C4) and
   * the vault owns its own vocabulary: one vault says `private: [true]` and
   * another `audience: [internal]`, and neither word appears in this file.
   */
  exclude?: Record<string, string[]>;
  /** For a `jira:` ref's href. Configuration, not a fetch. */
  jiraBase: string | null;
}

export interface SyncPlan {
  target: string;
  files: PlannedFile[];
  /** Files in the target this view no longer names — an unshare must unshare. */
  remove: string[];
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
 * The index, so the folder is a document rather than twenty loose files.
 *
 * In the view's own order: a view is a query *and* a sort (C9), and the order it
 * draws in is the order its author reads it in. Generated from the same list the
 * files come from, so it cannot list something that is not there.
 */
function indexOf(notes: readonly Note[]): string {
  const lines = ['# Contents', ''];
  for (const note of notes) lines.push(`- [${note.title}](${fileFor(note.id)})`);
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
  const written = new Map<string, string>([['README.md', indexOf(sharing)]]);
  for (const note of sharing) written.set(fileFor(note.id), renderShared(note, companions));
  for (const [from, to] of assets) written.set(to, readFileSync(from, 'utf8'));

  const files: PlannedFile[] = [...written].map(([path, content]) => ({
    path,
    content,
    state: !already.has(path) ? 'new' : already.get(path) === content ? 'same' : 'changed',
  }));

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

  return {
    target: options.target,
    files,
    remove: [...already.keys()].filter((path) => !written.has(path)).sort(),
    held,
    cut: [...cut.values()].sort((a, b) => b.from.length - a.from.length || a.id.localeCompare(b.id)),
  };
}

/**
 * The plan as a person reads it, which is the half that does the guarding.
 *
 * Ordered by what would surprise you: what is new, then what changed, then what
 * would be removed, then the notes held back and the links being cut. `same` is
 * counted and not listed — a sync that writes nothing new should say so in one
 * line rather than in twenty.
 */
export function renderPlan(plan: SyncPlan, view: string): string {
  const lines = [`syncing view "${view}" into ${plan.target}`, ''];
  const by = (state: PlannedFile['state']) => plan.files.filter((f) => f.state === state);
  for (const file of by('new')) lines.push(`  new      ${file.path}`);
  for (const file of by('changed')) lines.push(`  changed  ${file.path}`);
  for (const path of plan.remove) lines.push(`  remove   ${path}`);
  const same = by('same').length;
  if (same) lines.push(`  ${same} file(s) already up to date`);

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
export function applySync(plan: SyncPlan): { written: number; removed: number } {
  let written = 0;
  for (const file of plan.files) {
    if (file.state === 'same') continue;
    const full = join(plan.target, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, 'utf8');
    written++;
  }
  for (const path of plan.remove) {
    rmSync(join(plan.target, path), { force: true });
  }
  return { written, removed: plan.remove.length };
}
