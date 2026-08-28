import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join as pathJoin, resolve } from 'node:path';
import { z } from 'zod';
import { KEY_ORDER, headingOf, join, parseDoc, serialize, split } from './frontmatter.ts';
import { parseLink } from './links.ts';
import type { ProjectBlock, Note } from './types.ts';

/**
 * The fixed skeleton only. Facet *values* are dynamic — they come from
 * facets.yaml at runtime — so no static schema can check them; that lives in
 * `validate.ts` against the loaded vocabulary.
 */
const repoSchema = z.object({
  path: z.string().min(1),
  base: z.string().min(1).optional(),
});

const projectSchema = z.object({
  repos: z.array(repoSchema).optional(),
  jira: z.string().optional(),
  branch: z.string().optional(),
  instructions: z.string().optional(),
});

export const frontmatterSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).optional(),
  facets: z.record(z.string(), z.unknown()).optional(),
  links: z.array(z.string()).optional(),
  project: projectSchema.optional(),
  source_fingerprint: z.string().optional(),
  absorbed_fingerprints: z.array(z.string()).optional(),
  // Any scalar. These two are the app's own fields wearing names a foreign tool
  // may already have used for something else — Logseq writes
  // `created: 20210330234143398` — and rejecting the *note* over a stamp it
  // cannot read is the whole file lost to one field. `asDate` decides what it
  // can make of the value; anything it cannot read is simply absent, which is a
  // state every note without frontmatter is already in.
  created: z.unknown().optional(),
  updated: z.unknown().optional(),
});

export type ParseResult =
  | { ok: true; rec: Note }
  | { ok: false; file: string; errors: string[] };

/**
 * Facet values are always arrays. A scalar in the file is lifted to `[scalar]`.
 *
 * No facet is named here, and that is the point: the parser, the filter, the
 * histogram and the grouping all treat every axis identically, so a new facet
 * needs no code. A facet the vocabulary does not declare is preserved, not
 * dropped — the file is the source of truth (C1), not this parser's opinion.
 */
function normaliseFacets(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue;
    const arr = Array.isArray(v) ? v : [v];
    const vals = arr.filter((x) => x != null).map((x) => String(x).trim()).filter(Boolean);
    if (vals.length) out[k] = vals;
  }
  return out;
}

/**
 * The date a value states, or nothing.
 *
 * Both ISO 8601 date forms are read: extended (`2026-08-27`) and basic
 * (`20260827`, optionally carrying a time after it). Basic is not a courtesy to
 * any particular tool — it is the same standard written without separators, and
 * it is what a note exported from a system that stamped milliseconds looks like.
 * Whatever follows the date is dropped, because only the date is kept.
 *
 * Anything else reads as absent rather than as garbage. A wrong date is worse
 * than no date: `staleness` is computed from `updated`, and a note claiming to
 * be from the year 2021033 would sort ahead of everything real for ever.
 */
export function asDate(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(v).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** A usable id: the shape every id the app writes already has. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A name, lowercased, with every run of anything else becoming a dash.
 *
 * Deliberately not `slugify`, which drops stop words and truncates at six — good
 * for turning a sentence into a name, wrong here, where the id's whole job is to
 * correspond to the file you can see. `notes-on-the-2026-plan.md` keeps every
 * word.
 */
const nameToId = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'note';

/**
 * A note's id when its file does not carry one: its filename — except for a
 * `README.md`, which takes the name of the folder it sits in.
 *
 * The exception is what makes a project a folder. `platform/README.md` is the
 * note `platform`, so the folder name *is* the id and there is nothing else to
 * keep in step with it (C11). Without it every README in the vault derives the
 * same id, `readme`, and a vault with three project folders has three notes
 * claiming one name — which `readAll` reports as duplicates and drops two of.
 *
 * `root` is where the vault's notes begin, and the README directly inside it is
 * the vault's own front page rather than any folder's: its id stays `readme`,
 * since the alternative is an id that changes when the vault directory is
 * renamed. Callers with no vault in hand — `pj log`, reading blobs out of git —
 * pass the relative root the paths are already measured against.
 *
 * A derived id is only stable while the *path* is. That is the trade a bare note
 * makes, and it ends the moment the note gains any structure: every write
 * materialises the id it was being called by, so a rename after that renames a
 * file rather than a note. For a folder project this now includes the folder —
 * renaming `platform/` renames the note, exactly as renaming `platform.md` did.
 */
export function idFromFile(file: string, root?: string): string {
  if (basename(file) === 'README.md' && root !== undefined) {
    const dir = dirname(file);
    if (resolve(dir) !== resolve(root)) return nameToId(basename(dir));
  }
  return nameToId(basename(file, '.md'));
}

/** What a file with no `title:` and no heading is called: the same name its id came from. */
function nameOf(file: string, root?: string): string {
  if (basename(file) === 'README.md' && root !== undefined) {
    const dir = dirname(file);
    if (resolve(dir) !== resolve(root)) return basename(dir);
  }
  return basename(file, '.md');
}

/**
 * Parse a note file.
 *
 * **A markdown file is a note.** No frontmatter is not an error — it is a note
 * that has not said anything about itself yet, so the file says it instead: the
 * filename is the id and a leading heading is the title. That is what makes a
 * folder of ordinary markdown — an Obsidian vault, a directory of meeting notes —
 * something you can open rather than something you have to import.
 *
 * The same fallback applies key by key rather than only to a file with no
 * frontmatter at all, because the file that most needs it has frontmatter for
 * something else. An Obsidian note carrying `tags:` and no `id:` is the ordinary
 * case, not a malformed note.
 *
 * **A key it cannot use is a key it does not have.** The fallback covers a bad
 * value as well as a missing one, because the two are the same situation from the
 * note's side: an `id:` that is not slug-shaped, and a `created:` or `updated:`
 * that is not a date, are read as absent rather than fatal. Five years of notes
 * exported from another tool arrive carrying exactly this — a stamp in a foreign
 * format under a name this app also uses — and rejecting the note would hide a
 * quarter of a vault while the app reported itself as working.
 *
 * The cost is named: a mistyped `idd:` no longer fails `pj check`, it quietly
 * derives an id instead. That is the price of a format with no required keys, and
 * it is the right way round — a vault should open, and a typo should cost you a
 * name rather than a file.
 */
export function parseNote(file: string, text: string, root?: string): ParseResult {
  const { yaml, body } = split(text);

  let raw: unknown = {};
  if (yaml !== null) {
    try {
      raw = parseDoc(yaml).toJS() ?? {};
    } catch (err) {
      return { ok: false, file, errors: [`invalid YAML: ${(err as Error).message}`] };
    }
  }

  const parsed = frontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      file,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const fm = parsed.data;
  return {
    ok: true,
    rec: {
      // A stated id that is not slug-shaped is treated as no id at all. This is
      // the rule the paragraph above already describes for a mistyped `idd:`,
      // applied to a mistyped *value* — an imported note titling itself
      // `id: book highlights summary` costs the name it was going by, not the
      // note. The derived id is what every reference to it already resolves
      // through, since nothing could have pointed at a non-slug.
      id: fm.id && SLUG.test(fm.id) ? fm.id : idFromFile(file, root),
      title: fm.title ?? headingOf(body) ?? nameOf(file, root),
      facets: normaliseFacets(fm.facets),
      links: (fm.links ?? []).map(parseLink),
      project: fm.project as ProjectBlock | undefined,
      source_fingerprint: fm.source_fingerprint,
      absorbed_fingerprints: fm.absorbed_fingerprints,
      created: asDate(fm.created),
      updated: asDate(fm.updated),
      body,
      file,
    },
  };
}

export function loadNote(file: string, root?: string): ParseResult {
  return parseNote(file, readFileSync(file, 'utf8'), root);
}

/**
 * What the note walk does not descend into, and neither is an exception to what a
 * note is.
 *
 * Anything dotted is the app's own state — `.projector/` above all. `assets` is
 * the one tree projector *writes into and deletes from*, wholesale, when a note
 * is removed or merged: a markdown file in there would be deleted along with the
 * images it sits among, so it is not offered as a note in the first place.
 *
 * `README.md` used to be skipped too, and no longer is. The reason it was there —
 * a folder full of markdown attracts a README — is exactly the reason it should
 * be a note now that the folder full of markdown *is* the vault.
 *
 * `AGENTS.md` is the other way round, and for the same reason `facets.yaml` is
 * not a note: it is **configuration**, and configuration is not content. It
 * carries a project's instructions, which were a `project:` key until they got
 * their own file, and a key in the frontmatter block was never a note either. If
 * it were indexed, every project folder would also contribute a note called
 * `agents`, all of them claiming one id — and the instructions would then be both
 * a note body and inherited config, which is the one thing C11 forbids.
 */
const skipped = (name: string): boolean =>
  name === 'assets' || name === 'AGENTS.md' || name.startsWith('.');

/** Every `.md` in the vault, at any depth. */
export function listNoteFiles(cardsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skipped(name)) continue;
      const full = pathJoin(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) out.push(full);
    }
  };
  walk(cardsDir);
  return out.sort();
}

/**
 * Whether a vault-relative path is a note, without a filesystem to walk.
 *
 * `pj log` needs this: it reads paths out of `git log`, where the vault is the
 * whole repository and the diff carries `.projector/facets.yaml` alongside the
 * notes. Sharing `skipped` with the walk is the point — a path git names and a
 * path the indexer finds have to be the same set, or the log narrates changes to
 * files that are not notes.
 */
export function isNotePath(rel: string): boolean {
  return rel.endsWith('.md') && !rel.split('/').some(skipped);
}

export function renderNote(rec: Omit<Note, 'file'>): string {
  const fm: Record<string, unknown> = {
    id: rec.id,
    title: rec.title,
  };
  if (Object.keys(rec.facets).length) fm.facets = rec.facets;
  if (rec.links.length) fm.links = rec.links.map((l) => l.raw);
  if (rec.project) fm.project = rec.project;
  if (rec.source_fingerprint) fm.source_fingerprint = rec.source_fingerprint;
  if (rec.absorbed_fingerprints?.length) fm.absorbed_fingerprints = rec.absorbed_fingerprints;
  if (rec.created) fm.created = rec.created;
  if (rec.updated) fm.updated = rec.updated;

  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (k in fm) ordered[k] = fm[k];
  // The body is written exactly as given. Normalising it here — prepending a
  // newline to "tidy" the output — would insert a blank line into every
  // hand-written note the first time the app saved it, which is precisely the
  // silent rewriting C1 and C3 exist to prevent. Callers that want a blank line
  // after the frontmatter include it in `body`.
  return join(serialize(ordered), rec.body);
}

/** Write atomically: temp file then rename, so a reader never sees a half file. */
export function writeNoteFile(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}
