import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { basename, join as pathJoin } from 'node:path';
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
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase slug').optional(),
  title: z.string().min(1).optional(),
  facets: z.record(z.string(), z.unknown()).optional(),
  links: z.array(z.string()).optional(),
  project: projectSchema.optional(),
  source_fingerprint: z.string().optional(),
  absorbed_fingerprints: z.array(z.string()).optional(),
  created: z.union([z.string(), z.date()]).optional(),
  updated: z.union([z.string(), z.date()]).optional(),
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

function asDate(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * A note's id when its file does not carry one: the filename, lowercased, with
 * every run of anything else becoming a dash.
 *
 * Deliberately not `slugify`, which drops stop words and truncates at six — good
 * for turning a sentence into a name, wrong here, where the id's whole job is to
 * correspond to the file you can see. `notes-on-the-2026-plan.md` keeps every
 * word.
 *
 * A derived id is only stable while the filename is. That is the trade a bare
 * note makes, and it ends the moment the note gains any structure: every write
 * materialises the id it was being called by, so a rename after that renames a
 * file rather than a note.
 */
export function idFromFile(file: string): string {
  const stem = basename(file, '.md');
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'note';
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
 * The cost is named: a mistyped `idd:` no longer fails `pj check`, it quietly
 * derives an id instead. That is the price of a format with no required keys, and
 * it is the right way round — a vault should open, and a typo should cost you a
 * name rather than a file.
 */
export function parseNote(file: string, text: string): ParseResult {
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
      id: fm.id ?? idFromFile(file),
      title: fm.title ?? headingOf(body) ?? basename(file, '.md'),
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

export function loadNote(file: string): ParseResult {
  return parseNote(file, readFileSync(file, 'utf8'));
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
 */
const skipped = (name: string): boolean => name === 'assets' || name.startsWith('.');

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
