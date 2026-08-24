import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { paths, resolvePath } from '../config.ts';
import { frontmatterSchema, listNoteFiles, loadNote, renderNote, writeNoteFile } from '../schema/note.ts';
import { join as joinFm, parseDoc, patchKey, patchYamlFile, serialize, split } from '../schema/frontmatter.ts';
import { loadFacets } from '../schema/facets.ts';
import { isRef } from '../schema/facets.ts';
import { wouldCycle } from '../index/refs.ts';
import { merged } from '../schema/merge.ts';
import { parseLink } from '../schema/links.ts';
import { readAll } from '../index/indexer.ts';
import { viewFileFor } from './views.ts';
import type { Note } from '../schema/types.ts';
import { loadFacets as loadDefs } from '../schema/facets.ts';
import { slugify, uniqueId } from '../schema/slug.ts';
import { nextValues, type AxisMove, type DragMode } from '../view/dropOutcome.ts';

/**
 * Every write in the app funnels through this module.
 *
 * Two rules hold throughout: a frontmatter-only change never touches body bytes,
 * and no write proceeds when the file changed on disk since the client read it —
 * an agent editing the same card must never be silently overwritten (C1, C3).
 */

export class Conflict extends Error {
  mtime: number;
  constructor(mtime: number) {
    super('file changed on disk');
    this.mtime = mtime;
  }
}

export class Invalid extends Error {}

function fileFor(root: string, id: string): string {
  const p = paths(root);
  const direct = join(p.notes, `${id}.md`);
  if (existsSync(direct)) return direct;
  // The filename may drift from the id, so fall back to a scan.
  for (const f of listNoteFiles(p.notes)) {
    const res = loadNote(f);
    if (res.ok && res.rec.id === id) return f;
  }
  throw new Invalid(`no card with id "${id}"`);
}

export function mtimeOf(file: string): number {
  return Math.floor(statSync(file).mtimeMs);
}

/**
 * The facets on disk *now*, for a record we are about to write.
 *
 * Every loop below writes the whole `facets:` key, so the map it writes has to
 * come from a read of that record's own file rather than from the snapshot the
 * loop opened with. Otherwise a write to record twelve is derived from a read
 * taken before record one was written — and, worse, any axis another writer
 * touched in the meantime is reverted, silently, because the whole key goes back.
 *
 * This is the rule `patchNote` has always followed for the single-record case
 * ("Read *after* the guard, so this sees the file the guard just approved rather
 * than the one the client last rendered"). The loops did not follow it, and one of
 * them carried a comment claiming they did.
 *
 * Falls back to the snapshot when the file will not parse, which is the same thing
 * the indexer does with an unreadable note and the only answer available.
 */
function facetsNow(rec: { file: string; facets: Record<string, string[]> }): Record<string, string[]> {
  const res = loadNote(rec.file);
  return res.ok ? res.rec.facets : rec.facets;
}

/**
 * How far the file may have moved and still be the one the caller read.
 *
 * The stated reason used to be filesystem rounding, and that is measurably not
 * it: two back-to-back writes on this machine's APFS differ by 0.254ms, so the
 * tolerance is four thousand times the resolution it was said to be absorbing.
 *
 * What it actually absorbs is **this app's own in-flight writes**, and they are
 * deliberate. The panel's `press` is fire-and-forget by design — its status
 * machine exists so that overlapping writes report correctly rather than being
 * serialised — so clicking a priority chip and then a status chip inside a second
 * dispatches two requests whose bases were both computed before either returned.
 * The second carries the pre-write mtime. At zero tolerance that is a 409 against
 * the user's own preceding click, which is the exact failure `baseOf` is written
 * to prevent, reported as "probably a Claude session".
 *
 * So it is a real mechanism with a wrong label, not a wrong value. Removing it
 * needs the panel's writes serialised first, and serialising them contradicts the
 * status machine and the test that pins it. The cost of keeping it is a window in
 * which a foreign write passes unrefused — narrow, and narrowed further by what
 * the writes are: `patchNote` re-reads the axis and folds a delta into it, so the
 * common case merges rather than losing anything. The paths that replace wholesale
 * — the frontmatter pane, the project block, the links array — are the ones this
 * window can genuinely cost, and they are the rare ones.
 */
const SELF_WRITE_WINDOW_MS = 1000;

function guard(file: string, baseMtime?: number): void {
  // An absent base is not an unguarded write, it is a caller declining the guard —
  // which every CLI path and every bulk op does, because neither has anywhere to
  // put one. See ARCHITECTURE.md's write-path table for who does what.
  if (baseMtime === undefined) return;
  const current = mtimeOf(file);
  if (Math.abs(current - baseMtime) > SELF_WRITE_WINDOW_MS) throw new Conflict(current);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Apply several frontmatter keys in one atomic write, bumping `updated`. */
function patchAll(file: string, patch: Record<string, unknown>): void {
  let text = readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(patch)) text = patchKey(text, key, value);
  text = patchKey(text, 'updated', today());
  writeNoteFile(file, text);
}

// ---------------------------------------------------------------- validation

/**
 * Replace the body, leaving the frontmatter block byte-identical.
 *
 * Does not bump `updated`: the caller decides, because a body change is usually
 * one half of a write and two bumps mean two writes for one edit.
 */
function putBody(file: string, body: string): void {
  const { yaml } = split(readFileSync(file, 'utf8'));
  writeNoteFile(file, `---\n${yaml}---\n${body}`);
}

/**
 * Validate facet names and values against the vocabulary before writing.
 *
 * A closed facet rejects unknown values, a single-valued one rejects a second,
 * and a reference facet rejects a cycle. Every facet is writable and every facet
 * is checked the same way — `project` included. There is no special kind.
 *
 * `notes` is only needed for reference facets, so it is optional: a caller
 * writing labels does not have to read the vault first.
 */
export function checkFacets(
  root: string,
  id: string,
  facets: Record<string, string[]>,
  notes?: Map<string, Note>,
): void {
  const defs = loadFacets(paths(root).facets);
  for (const [name, values] of Object.entries(facets)) {
    const def = defs[name];
    if (!def) throw new Invalid(`unknown facet "${name}"`);
    if (!def.open) {
      for (const v of values) {
        if (!def.values.includes(v)) {
          throw new Invalid(`"${v}" is not allowed for "${name}" (allowed: ${def.values.join(', ')})`);
        }
      }
    }
    if (def.single && values.length > 1) {
      throw new Invalid(`"${name}" holds one value at a time, and this sets ${values.length}`);
    }
    // A typed value has to *be* what the type says, or every comparison
    // downstream is guessing. This is where `checkDue` used to live, hardcoded
    // to one field name.
    if (def.type === 'date') {
      for (const v of values) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
          throw new Invalid(`"${name}" is a date facet, and "${v}" is not YYYY-MM-DD`);
        }
      }
    }
    if (def.type === 'number') {
      for (const v of values) {
        if (!Number.isFinite(Number(v))) throw new Invalid(`"${name}" is a number facet, and "${v}" is not a number`);
      }
    }
    if (isRef(def) && notes) {
      for (const v of values) {
        if (v === id) throw new Invalid(`"${name}" cannot point at its own note`);
        if (wouldCycle(id, v, (cur) => notes.get(cur)?.facets[name] ?? [])) {
          throw new Invalid(`"${v}" already reaches "${id}" through "${name}" — that would make a cycle`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- operations

/**
 * One facet's values merged into a map, dropping the axis when it empties.
 *
 * An emptied facet is deleted rather than stored as `[]`, which is the rule the
 * frontmatter writer expects — it was spelled out at `bulkMove` and `bulkFacet`
 * and is now needed a third time, which is three chances for one rule to drift.
 * Pure, so it is asserted directly rather than through a filesystem.
 */
export function withFacet(
  current: Record<string, string[]>,
  name: string,
  values: string[],
): Record<string, string[]> {
  const next = { ...current };
  if (values.length) next[name] = values;
  else delete next[name];
  return next;
}

/** How a caller means its values: replace the axis, or name a delta on it. */
export type FacetMode = 'set' | 'add' | 'remove';

/**
 * One axis's next values, from what is on disk and what the caller asked for.
 *
 * `set` is the only mode that discards what it did not see. `add` and `remove`
 * name a *delta*, which is what a toggle actually is — and the difference is not
 * cosmetic: a chip click that says "the axis is now [k8s, temporal]" reverts a
 * value an agent added since the click's own render, silently and inside the
 * guard's tolerance. One that says "remove kafka" cannot.
 */
export function applyMode(current: string[], values: string[], mode: FacetMode): string[] {
  if (mode === 'set') return [...values];
  if (mode === 'add') return [...new Set([...current, ...values])];
  return current.filter((v) => !values.includes(v));
}

export interface PatchCardInput {
  title?: string;
  /**
   * The whole map, replaced. `pj set` expresses every removal by omitting a key
   * — `--facet f=`, a fully-consumed `--remove`, `--parent none` — so this
   * meaning must not change. A caller sending one axis wants `facet` below.
   */
  facets?: Record<string, string[]>;
  /**
   * One axis, merged over what is on disk *inside* the guard.
   *
   * The browser cannot know the whole map without re-reading the file, and the
   * copy it holds is as old as its last render — sending it back reverts any
   * other axis an agent changed in the meantime, silently, because the write
   * still satisfies `guard`'s tolerance. Naming the one axis is what makes the
   * panel's write as narrow as the edit that caused it (C3).
   *
   * `mode` narrows it the last step. Naming the axis still leaves the client
   * asserting what that *whole axis* now holds, which is as old as its last
   * render — so a toggle on `tech` reverts a value an agent added to `tech` a
   * moment earlier, inside the guard's tolerance, with nothing to report.
   * `add`/`remove` name the delta instead, and a toggle *is* a delta.
   */
  facet?: { name: string; values: string[]; mode?: FacetMode };
  /**
   * Fingerprints this card answers for beyond its own origin, as a delta.
   *
   * The delta form rather than the whole list for the same reason `facet` takes
   * one: a caller adding the fingerprint of a message it just linked knows that
   * one fingerprint, not the set, and asserting the set would drop whatever a
   * merge put there in the meantime.
   *
   * They land in `absorbed_fingerprints`, never in `source_fingerprint` — a card
   * extended by a message did not come from it, and overwriting its origin would
   * lose where it actually came from.
   */
  absorb?: { values: string[]; mode?: 'add' | 'remove' };
  links?: string[];
  body?: string;
  project?: Record<string, unknown> | null;
  baseMtime?: number;
}

export function patchNote(root: string, id: string, input: PatchCardInput): { mtime: number } {
  const file = fileFor(root, id);
  guard(file, input.baseMtime);

  if (input.facets) checkFacets(root, id, input.facets, readAll(paths(root).notes).notes);
  if (input.title !== undefined && !input.title.trim()) throw new Invalid('title cannot be empty');

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.facets !== undefined) {
    // Drop empty facets rather than storing an empty array.
    const clean = Object.fromEntries(Object.entries(input.facets).filter(([, v]) => v.length));
    patch.facets = Object.keys(clean).length ? clean : undefined;
  }
  if (input.facet) {
    // Read *after* the guard, so this sees the file the guard just approved
    // rather than the one the client last rendered. Everything the client does
    // not name survives, which is the whole point of the narrow form.
    const { notes } = readAll(paths(root).notes);
    const { name, values, mode = 'set' } = input.facet;
    const current = notes.get(id)?.facets ?? {};
    const next = applyMode(current[name] ?? [], values, mode);
    const merged = withFacet(current, name, next);
    checkFacets(root, id, next.length ? { [name]: next } : {}, notes);
    patch.facets = Object.keys(merged).length ? merged : undefined;
  }
  if (input.absorb) {
    const { notes } = readAll(paths(root).notes);
    const rec = notes.get(id);
    if (!rec) throw new Invalid(`no note with id "${id}"`);
    const { values, mode = 'add' } = input.absorb;
    const held = rec.absorbed_fingerprints ?? [];

    if (mode === 'remove') {
      // Symmetric with `pj link --remove`, and for the same reason: a removal
      // that reports success while doing nothing is how you find out a month
      // later that the fingerprint is still on the other card, silently keeping
      // it out of every sweep.
      const missing = values.filter((v) => !held.includes(v));
      if (missing.length) throw new Invalid(`${id} does not answer for ${missing.join(', ')}`);
      const kept = held.filter((v) => !values.includes(v));
      patch.absorbed_fingerprints = kept.length ? kept : undefined;
    } else {
      for (const v of values) {
        if (rec.source_fingerprint === v) throw new Invalid(`${id} already came from ${v}`);
        // A fingerprint answers for exactly one card. Letting two claim it means
        // whichever the sweep asks about first decides, and the other silently
        // stops being re-proposed — so refuse and name the holder instead.
        for (const other of notes.values()) {
          if (other.id === id) continue;
          const otherHeld = [other.source_fingerprint, ...(other.absorbed_fingerprints ?? [])];
          if (otherHeld.includes(v)) throw new Invalid(`${v} is already answered for by ${other.id}`);
        }
      }
      const next = [...held];
      for (const v of values) if (!next.includes(v)) next.push(v);
      patch.absorbed_fingerprints = next.length ? next : undefined;
    }
  }
  if (input.links !== undefined) patch.links = input.links.length ? input.links : undefined;
  if (input.project !== undefined) patch.project = input.project ?? undefined;

  if (Object.keys(patch).length) patchAll(file, patch);

  if (input.body !== undefined) {
    // The body is written verbatim; only this call path and `mergeNotes` may
    // touch it.
    putBody(file, input.body);
    patchAll(file, {});
  }

  return { mtime: mtimeOf(file) };
}

export function createNote(
  root: string,
  input: {
    title: string;
    /** Overrides the slug derived from the title. Refused if already taken. */
    id?: string;
    facets?: Record<string, string[]>;
    body?: string;
    links?: string[];
    /**
     * A stable hash of whatever this card came from. A sweep that runs twice
     * must converge rather than refill the inbox, so a fingerprint already
     * present short-circuits instead of creating a duplicate.
     */
    fingerprint?: string;
  },
): { id: string; existed?: boolean } {
  const title = input.title.trim();
  if (!title) throw new Invalid('title cannot be empty');
  const p = paths(root);
  mkdirSync(p.notes, { recursive: true });
  const { notes } = readAll(p.notes);

  if (input.fingerprint) {
    for (const rec of notes.values()) {
      // A fingerprint absorbed by a merge answers for the note that absorbed it.
      // Without this half, folding a captured note into another one hands the
      // next sweep a fingerprint nothing claims, and it creates the note again.
      const held = [rec.source_fingerprint, ...(rec.absorbed_fingerprints ?? [])];
      if (held.includes(input.fingerprint)) return { id: rec.id, existed: true };
    }
  }
  const id = input.id ?? uniqueId(slugify(title), new Set(notes.keys()));
  if (input.id) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.id)) throw new Invalid(`"${input.id}" is not a lowercase slug`);
    // Never silently pick a different id than the caller asked for: something is
    // about to reference this one by name.
    if (notes.has(input.id)) throw new Invalid(`id "${input.id}" is already taken`);
  }
  // No relation gets a parameter of its own. `parent` had one, on both this and
  // the CLI, and it was `--facet parent=` spelled twice — so a vault calling its
  // containment relation anything else had a flag for a facet it does not have.
  const facets = input.facets ?? {};
  if (Object.keys(facets).length) checkFacets(root, id, facets, notes);

  const text = renderNote({
    id,
    title,
    facets,
    links: (input.links ?? []).map(parseLink),
    source_fingerprint: input.fingerprint,
    created: today(),
    updated: today(),
    body: input.body ? `\n${input.body}\n` : '\n',
  });
  writeNoteFile(join(p.notes, `${id}.md`), text);
  return { id };
}

/** The names of every facet that holds note ids. */
function refFacetsOf(root: string): string[] {
  return Object.entries(loadDefs(paths(root).facets))
    .filter(([, def]) => isRef(def))
    .map(([name]) => name);
}

/**
 * How one note's references change when a set of ids stops existing separately.
 *
 * `onto` is where they went — the survivor of a merge — or `null` when they went
 * nowhere, which is a delete. Both are one rewrite, which is why this is one
 * function: a value naming a departed id becomes `onto` or disappears, the result
 * is deduplicated, and a value that would end up naming the holder itself is
 * dropped, because a note cannot reference itself and `checkFacets` refuses to
 * let it say so.
 *
 * `null` when nothing changed, so a caller writes only the files it must. Pure,
 * so the three ways this can go wrong are asserted without a filesystem.
 */
export function repointed(
  facets: Record<string, string[]>,
  refFacets: readonly string[],
  gone: ReadonlySet<string>,
  onto: string | null,
  holder: string,
): { facets: Record<string, string[]>; changed: number } | null {
  const out = { ...facets };
  let changed = 0;
  for (const name of refFacets) {
    const before = out[name] ?? [];
    const moving = before.filter((v) => gone.has(v)).length;
    if (!moving) continue;
    changed += moving;
    const after = [
      ...new Set(before.map((v) => (gone.has(v) ? onto : v)).filter((v): v is string => v !== null)),
    ].filter((v) => v !== holder);
    if (after.length) out[name] = after;
    else delete out[name];
  }
  return changed ? { facets: out, changed } : null;
}

/**
 * Delete a card file, and drop every reference that pointed at it so the graph
 * does not keep dangling values. The files are in git, so this is recoverable.
 */
export function deleteNote(root: string, id: string): { removedEdges: number } {
  const file = fileFor(root, id);
  const p = paths(root);
  const { notes } = readAll(p.notes);
  const refFacets = refFacetsOf(root);
  const gone = new Set([id]);
  let removedEdges = 0;

  for (const rec of notes.values()) {
    if (rec.id === id) continue;
    // These are files the caller never named and never read, and the write below
    // replaces the whole `facets:` key on each of them — so the map has to be the
    // one on disk. See `facetsNow`.
    const plan = repointed(facetsNow(rec), refFacets, gone, null, rec.id);
    if (!plan) continue;
    removedEdges += plan.changed;
    patchAll(rec.file, { facets: Object.keys(plan.facets).length ? plan.facets : undefined });
  }

  rmSync(file);
  // Assets belong to the card; nothing else references them.
  const assets = join(p.assets, id);
  if (existsSync(assets)) rmSync(assets, { recursive: true });
  return { removedEdges };
}

/**
 * Move an absorbed note's assets into the survivor's folder.
 *
 * Filenames are content hashes, so a name already present is the same bytes and
 * the absorbed copy is simply dropped. `schema/merge.ts` rewrote the body's paths
 * to match — that rewrite and this move are one decision in two places, and
 * neither is correct alone.
 */
function adoptAssets(root: string, from: string, to: string): void {
  const p = paths(root);
  const src = join(p.assets, from);
  if (!existsSync(src)) return;
  const dst = join(p.assets, to);
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const at = join(dst, name);
    if (existsSync(at)) rmSync(join(src, name));
    else renameSync(join(src, name), at);
  }
  rmSync(src, { recursive: true });
}

/**
 * Fold several notes into one and remove them.
 *
 * The composition is `schema/merge.ts`'s. What happens here is everything that
 * needs the vault: repointing every reference that named an absorbed note,
 * checking the graph the merge *would* produce, and only then writing.
 *
 * **Nothing is written until every check has passed.** A merge touches the
 * survivor, every note that referenced an absorbed one, and the absorbed files
 * themselves — so a refusal halfway through leaves a vault in a state nobody
 * asked for, and unlike a single-note write there is no one file to point at. The
 * plan is built in full, checked against a projection of the result, and applied
 * last.
 *
 * There is no `baseMtime`, for the same reason `bulkMove` has none: a caller
 * holding twelve notes has no single mtime to offer. What stands in for it is that
 * the *composition* happens here, from a read taken inside this call. A client
 * that composed the body itself would be sending prose as old as its last render,
 * and would quietly revert whatever an agent wrote in between — which is the
 * failure `PatchCardInput.facet` exists to make unrepresentable, and a body is
 * worth more than an axis.
 */
export function mergeNotes(
  root: string,
  into: string,
  from: readonly string[],
): { merged: number; repointed: number } {
  const p = paths(root);
  const { notes } = readAll(p.notes);
  const target = notes.get(into);
  if (!target) throw new Invalid(`no note with id "${into}"`);

  const sources: Note[] = [];
  for (const id of new Set(from)) {
    // The survivor is picked *out of* the selection, so finding it in the list is
    // the ordinary case rather than a mistake.
    if (id === into) continue;
    const rec = notes.get(id);
    if (!rec) throw new Invalid(`no note with id "${id}"`);
    sources.push(rec);
  }
  if (!sources.length) throw new Invalid('a merge needs a note to merge in besides the one it merges into');

  const refFacets = refFacetsOf(root);
  const out = merged(target, sources, loadDefs(p.facets));
  const gone = new Set(sources.map((s) => s.id));

  const plans: { rec: Note; facets: Record<string, string[]>; changed: number }[] = [];
  for (const rec of notes.values()) {
    if (rec.id === into || gone.has(rec.id)) continue;
    const plan = repointed(rec.facets, refFacets, gone, into, rec.id);
    if (plan) plans.push({ rec, ...plan });
  }

  /**
   * The vault as this merge would leave it.
   *
   * Every reference rule is a question about the whole graph, and repointing
   * changes it in places the survivor cannot see: `A → C → B`, merging B into A,
   * leaves `C → A` beside `A → C` — a cycle no single write would ever have been
   * allowed to make. Asking the notes as they stand now would miss it entirely.
   */
  const after = new Map<string, Note>();
  for (const rec of notes.values()) {
    if (gone.has(rec.id)) continue;
    after.set(rec.id, rec.id === into ? { ...rec, facets: out.facets } : rec);
  }
  for (const plan of plans) after.set(plan.rec.id, { ...plan.rec, facets: plan.facets });

  // Only the axes the merge moved, following `bulkMove`: a survivor already
  // carrying a value the vocabulary has since dropped is not this write's doing,
  // and refusing the merge over it would be a dead end with no way out of it.
  const touched: Record<string, string[]> = {};
  for (const name of refFacets) {
    const next = out.facets[name] ?? [];
    if (next.length && !same(target.facets[name] ?? [], next)) touched[name] = next;
  }
  checkFacets(root, into, touched, after);

  for (const plan of plans) {
    for (const name of refFacets) {
      for (const value of plan.facets[name] ?? []) {
        if (wouldCycle(plan.rec.id, value, (cur) => after.get(cur)?.facets[name] ?? [])) {
          throw new Invalid(
            `merging into "${into}" would make "${plan.rec.id}" reach itself through "${name}" — ` +
              'clear that reference first, or merge the other way round',
          );
        }
      }
    }
  }

  // Checked. From here it writes.
  for (const plan of plans) {
    // Re-planned against the file rather than the snapshot, for the reason
    // `facetsNow` gives: this loop writes the whole `facets:` key on notes the
    // caller never named. The transform is the same one just validated; only its
    // input is fresher.
    const fresh = repointed(facetsNow(plan.rec), refFacets, gone, into, plan.rec.id);
    if (!fresh) continue;
    patchAll(plan.rec.file, { facets: Object.keys(fresh.facets).length ? fresh.facets : undefined });
  }

  const file = fileFor(root, into);
  // The body first, so the frontmatter write is what stamps `updated` — one bump
  // for one merge, rather than one per field it happens to touch.
  putBody(file, out.body);
  patchAll(file, {
    facets: Object.keys(out.facets).length ? out.facets : undefined,
    links: out.links.length ? out.links : undefined,
    absorbed_fingerprints: out.absorbed.length ? out.absorbed : undefined,
    ...(out.project ? { project: out.project } : {}),
  });

  for (const s of sources) {
    adoptAssets(root, s.id, into);
    // Not `deleteNote`: its reference sweep would strip the very values this
    // merge just repointed at the survivor, and its asset sweep would delete the
    // files just adopted. What is left of a delete here is removing the file.
    rmSync(s.file);
  }

  return { merged: sources.length, repointed: plans.reduce((n, plan) => n + plan.changed, 0) };
}

/**
 * Move notes along one or more facets, one card at a time.
 *
 * Distinct from `bulkFacet` because the two are different operations that happen
 * to write the same field. "Make these twelve cards say `now`" is uniform, and
 * that is what `bulkFacet` does. "Move these twelve from `now` to `month`, keeping
 * whatever else each of them says" is *per card* — every card's answer depends on
 * its own values, and a uniform `values` array cannot express one.
 *
 * The board used to compute the single-card answer with `nextValues` and then
 * throw it away whenever more than one card was selected, sending uniform values
 * instead. So the same gesture produced different results by selection count:
 * shift-dragging `now`→`month` removed `now` for one card and `month` for two.
 * One transform, applied here, is what makes that unrepresentable.
 *
 * It also writes only the named facets *of the payload* — but the write itself is
 * the whole `facets:` key, so "cannot be reverted" was true of the wire form and
 * false of the file. It is true now: each record's map is folded from a read of its
 * own file taken immediately before its write, not from the snapshot this loop
 * opened with. `readAll` measures around 31ms on a 191-note vault, and every write
 * in the loop widens the gap further, so the stale window was real rather than
 * theoretical. See `facetsNow`.
 */
export function bulkMove(
  root: string,
  ids: string[],
  moves: readonly AxisMove[],
  mode: DragMode,
): { changed: number } {
  const { notes } = readAll(paths(root).notes);
  let changed = 0;
  for (const id of ids) {
    const rec = notes.get(id);
    if (!rec) continue;
    // A drag across a matrix board crosses two axes and is still one gesture, so
    // both endpoints fold into one map and one write. Writing per axis would bump
    // `updated` twice and let the second write land on a card the first changed —
    // and would leave the card half moved when the second value is refused.
    // Not `rec.facets`: that is the pre-loop snapshot. See `facetsNow`.
    let facets = facetsNow(rec);
    const check: Record<string, string[]> = {};
    let touched = false;
    for (const { facet, from, to } of moves) {
      const current = facets[facet] ?? [];
      const next = nextValues(current, from, to, mode);
      if (same(current, next)) continue;
      // A cleared axis has nothing to validate — `withFacet` drops the key.
      if (next.length) check[facet] = next;
      facets = withFacet(facets, facet, next);
      touched = true;
    }
    if (!touched) continue;
    // Every axis is checked before any of them is written.
    checkFacets(root, id, check, notes);
    patchAll(rec.file, { facets: Object.keys(facets).length ? facets : undefined });
    changed++;
  }
  return { changed };
}

/** Set one facet's values on many notes at once. */
export function bulkFacet(
  root: string,
  ids: string[],
  facet: string,
  values: string[],
  mode: FacetMode,
): { changed: number } {
  const { notes } = readAll(paths(root).notes);
  let changed = 0;
  for (const id of ids) {
    const rec = notes.get(id);
    if (!rec) continue;
    // Read this record's own file, not the pre-loop snapshot. See `facetsNow`.
    const now = facetsNow(rec);
    const current = now[facet] ?? [];
    const next = applyMode(current, values, mode);
    if (same(current, next)) continue;
    const facets = withFacet(now, facet, next);
    checkFacets(root, id, next.length ? { [facet]: next } : {}, notes);
    patchAll(rec.file, { facets: Object.keys(facets).length ? facets : undefined });
    changed++;
  }
  return { changed };
}

export function bulkDelete(root: string, ids: string[]): { deleted: number } {
  let deleted = 0;
  for (const id of ids) {
    try {
      deleteNote(root, id);
      deleted++;
    } catch {
      /* already gone */
    }
  }
  return { deleted };
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Set frontmatter fields by dotted path, with YAML values.
 *
 *   project.jira=SUPPORT
 *   project.repos=[{path: ~/Code/work/infra, base: main}]
 *   project={}                 → this is what "make it a project" is
 *   project=                   → and this is "stop being one"
 *
 * One mechanism rather than a verb per structure. `project:` is a block, not a
 * facet, so no amount of facet machinery reaches it — and a flat `key=value`
 * cannot express a list of maps, so the value is parsed as YAML. That also makes
 * `facets.priority=[now]` work, which is `--facet` spelled generally.
 *
 * Only the top-level keys actually touched are rewritten, so comments and hand
 * formatting elsewhere in the file survive (C1).
 */
export function patchFields(
  root: string,
  id: string,
  sets: Record<string, string>,
  baseMtime?: number,
): { mtime: number } {
  const file = fileFor(root, id);
  guard(file, baseMtime);

  const text = readFileSync(file, 'utf8');
  const { yaml } = split(text);
  const fm = (parseDoc(yaml ?? '').toJS() ?? {}) as Record<string, unknown>;
  const touched = new Set<string>();

  for (const [path, raw] of Object.entries(sets)) {
    const parts = path.split('.').filter(Boolean);
    if (!parts.length) throw new Invalid('a --set needs a field name');
    const top = parts[0]!;
    if (top === 'id') throw new Invalid('id cannot be changed — other notes reference it');
    touched.add(top);

    let value: unknown;
    if (raw === '') value = undefined;
    else {
      try {
        value = parseDoc(raw).toJS();
      } catch (err) {
        throw new Invalid(`${path}: not valid YAML — ${(err as Error).message}`);
      }
    }

    // Walk to the parent of the leaf, creating plain objects on the way.
    let cursor: Record<string, unknown> = fm;
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (next === undefined || next === null) cursor[part] = {};
      else if (typeof next !== 'object' || Array.isArray(next)) {
        throw new Invalid(`${path}: "${part}" is not a mapping`);
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    const leaf = parts.at(-1)!;
    if (value === undefined) delete cursor[leaf];
    else cursor[leaf] = value;
  }

  // The same checks as any other write, against the result rather than the input.
  const check = frontmatterSchema.safeParse({ ...fm, id });
  if (!check.success) {
    throw new Invalid(
      check.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  const facets: Record<string, string[]> = {};
  for (const [k, v] of Object.entries((check.data.facets ?? {}) as Record<string, unknown>)) {
    facets[k] = (Array.isArray(v) ? v : [v]).filter((x) => x != null).map(String);
  }
  checkFacets(root, id, facets, readAll(paths(root).notes).notes);

  for (const key of touched) patchAll(file, { [key]: fm[key] });
  return { mtime: mtimeOf(file) };
}

/**
 * Replace a card's whole frontmatter from raw YAML.
 *
 * Validated before anything is written: it must parse, satisfy the skeleton
 * schema, and pass the same facet checks as any other write. `id` is refused
 * because other cards' edges point at it — renaming would silently orphan them.
 */
export function putFrontmatter(
  root: string,
  id: string,
  yamlText: string,
  baseMtime?: number,
): { mtime: number; warnings: string[] } {
  const file = fileFor(root, id);
  guard(file, baseMtime);

  const text = readFileSync(file, 'utf8');
  const { body } = split(text);

  let parsed: unknown;
  try {
    parsed = parseDoc(yamlText).toJS();
  } catch (err) {
    throw new Invalid(`invalid YAML: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Invalid('frontmatter must be a mapping');

  const draft = parsed as Record<string, unknown>;
  if (draft.id !== undefined && draft.id !== id) {
    throw new Invalid(
      `id cannot be changed here — other notes' edges point at "${id}". Delete and recreate instead.`,
    );
  }
  draft.id = id;

  const check = frontmatterSchema.safeParse(draft);
  if (!check.success) {
    throw new Invalid(
      check.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }

  const { notes } = readAll(paths(root).notes);
  const facets: Record<string, string[]> = {};
  for (const [k, v] of Object.entries((check.data.facets ?? {}) as Record<string, unknown>)) {
    const arr = Array.isArray(v) ? v : [v];
    facets[k] = arr.filter((x) => x != null).map(String);
  }
  checkFacets(root, id, facets, notes);

  // Self-reference and cycles are already refused by `checkFacets`; a value
  // naming a note that does not exist yet is only a warning, because an agent
  // may write a card before the one it points at.
  const warnings: string[] = [];
  const defs = loadDefs(paths(root).facets);
  for (const [name, values] of Object.entries(facets)) {
    if (!isRef(defs[name])) continue;
    for (const v of values) {
      if (!notes.has(v)) warnings.push(`"${name}" names "${v}", which is not a note yet`);
    }
  }

  // Re-render through the canonical serializer so key order and flow style match
  // every other file, then restore the body untouched.
  writeNoteFile(file, joinFm(serialize(check.data), body));
  return { mtime: mtimeOf(file), warnings };
}

// ---------------------------------------------------------------- canvas

/** Persist canvas node positions and sizes. Cards are untouched — views own arrangement. */
/**
 * Arrangement: node positions, and card order within a column.
 *
 * Both are hand-curated, so both live in a named view and nowhere else (C9) —
 * which is what makes naming a view the act that buys manual arrangement. Cards
 * own identity and content; views own arrangement.
 */
export function saveArrangement(
  root: string,
  name: string,
  arrangement: { nodes?: Record<string, { x?: number; y?: number }>; order?: Record<string, string[]> },
): void {
  const p = paths(root);
  const file = viewFileFor(root, name);
  if (!existsSync(file)) throw new Invalid(`no view "${name}"`);
  const text0 = readFileSync(file, 'utf8');
  const before = (parse(text0) ?? {}) as { nodes?: Record<string, unknown>; order?: Record<string, unknown> };

  const patch: Record<string, unknown> = {};
  let live: Set<string> | null = null;
  /** Ids whose card is gone. The set is built at most once, and only if needed. */
  const dead = (ids: string[]): Set<string> => {
    const out = new Set<string>();
    for (const id of ids) {
      if (existsSync(join(p.notes, `${id}.md`))) continue;
      if (!live) {
        live = new Set<string>();
        for (const f of listNoteFiles(p.notes)) {
          const res = loadNote(f);
          if (res.ok) live.add(res.rec.id);
        }
      }
      if (!live.has(id)) out.add(id);
    }
    return out;
  };

  if (arrangement.nodes) {
    // Merge, never replace. The client sends the nodes it currently renders, and
    // that is a filtered subset — replacing would silently discard the position
    // of everything the filter happened to hide.
    const merged: Record<string, { x?: number; y?: number }> = {
      ...((before.nodes ?? {}) as Record<string, { x?: number; y?: number }>),
    };
    for (const [id, n] of Object.entries(arrangement.nodes)) {
      merged[id] = {
        ...(n.x !== undefined ? { x: Math.round(n.x) } : {}),
        ...(n.y !== undefined ? { y: Math.round(n.y) } : {}),
      };
    }
    for (const id of dead(Object.keys(merged))) delete merged[id];
    patch.nodes = merged;
    // No `layout: manual` beside it. It was written here and preserved by
    // `saveView`, and read by nothing: a canvas decides it is hand-arranged from
    // `nodes` being present, which is the same fact one hop earlier. A stored
    // value duplicating a derivable one is the rule that retired `kind` (C11).
  }

  if (arrangement.order) {
    const merged: Record<string, string[]> = {
      ...((before.order ?? {}) as Record<string, string[]>),
    };
    // Per column, for the same reason: you reorder the column you are looking at.
    for (const [column, ids] of Object.entries(arrangement.order)) {
      const gone = dead(ids);
      const kept = ids.filter((id) => !gone.has(id));
      if (kept.length) merged[column] = kept;
      else delete merged[column];
    }
    patch.order = merged;
  }

  if (!Object.keys(patch).length) return;
  // A view file is plain YAML, so it needs the YAML patcher, not the frontmatter one.
  const text = patchYamlFile(text0, patch);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/**
 * Write a saved view — *save current as…*, and updating one in place.
 *
 * Only the query half is written: arrangement belongs to whatever the view
 * already holds, so saving a new query over an existing name keeps its positions
 * rather than throwing them away.
 */
export function saveView(root: string, name: string, body: Record<string, unknown>): { name: string } {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Invalid('a view needs a name');
  const p = paths(root);
  mkdirSync(p.views, { recursive: true });
  const file = viewFileFor(root, slug);

  let merged: Record<string, unknown> = body;
  if (existsSync(file)) {
    const before = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
    merged = { ...body };
    if (before.nodes) merged.nodes = before.nodes;
    if (before.order) merged.order = before.order;
  }

  // Through the YAML patcher rather than a bare stringify, so a view the app
  // wrote is formatted like one written by hand — short sequences inline. A file
  // you cannot tell from a hand-edited one is the point of keeping them as files.
  const text = patchYamlFile('', merged);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
  return { name: slug };
}

/** Delete a saved view. The cards it selected are untouched. */
export function deleteView(root: string, name: string): void {
  const file = viewFileFor(root, name);
  if (!existsSync(file)) throw new Invalid(`no view "${name}"`);
  rmSync(file);
}

// ---------------------------------------------------------------- assets

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/** Save a pasted image beside its card and return the relative markdown path. */
export function saveAsset(root: string, id: string, mime: string, bytes: Buffer): { path: string } {
  const ext = EXT[mime];
  if (!ext) throw new Invalid(`unsupported image type "${mime}"`);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const dir = join(paths(root).assets, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${hash}.${ext}`);
  if (!existsSync(file)) writeFileSync(file, bytes);
  return { path: `assets/${id}/${hash}.${ext}` };
}

export { fileFor, resolvePath, dirname };
