import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { z } from 'zod';
import { KEY_ORDER, join, parseDoc, serialize, split } from './frontmatter.ts';
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
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lowercase slug'),
  title: z.string().min(1),
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

export function parseNote(file: string, text: string): ParseResult {
  const { yaml, body } = split(text);
  if (yaml === null) return { ok: false, file, errors: ['no frontmatter block'] };

  let raw: unknown;
  try {
    raw = parseDoc(yaml).toJS();
  } catch (err) {
    return { ok: false, file, errors: [`invalid YAML: ${(err as Error).message}`] };
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
      id: fm.id,
      title: fm.title,
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

/** Every `.md` under cards/, excluding assets/ and README.md. */
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
      if (name === 'assets' || name.startsWith('.')) continue;
      const full = pathJoin(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md') && name !== 'README.md') out.push(full);
    }
  };
  walk(cardsDir);
  return out.sort();
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
  // hand-written card the first time the app saved it, which is precisely the
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
