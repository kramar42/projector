import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isKnownKind } from './links.ts';
import { isRef } from './facets.ts';
import type { Facets, Issue, Note } from './types.ts';
import { INSTRUCTIONS_FILE, isProject } from '../index/project.ts';
import { wouldCycle } from '../index/refs.ts';
import { paths, resolvePath } from '../config.ts';
import { resolveDoc } from '../vault.ts';

/**
 * Validate every note against the loaded vocabulary and the graph.
 *
 * Collects every problem rather than stopping at the first — a note file is
 * something you fix in one pass, so the report has to be complete.
 */
export function validate(
  notes: Map<string, Note>,
  facets: Facets,
  dataRoot: string,
  extra: {
    unreadable?: { file: string; errors: string[] }[];
    duplicates?: { id: string; files: string[] }[];
  } = {},
): Issue[] {
  const issues: Issue[] = [];

  for (const u of extra.unreadable ?? []) {
    for (const message of u.errors) issues.push({ severity: 'error', file: u.file, message });
  }
  for (const d of extra.duplicates ?? []) {
    issues.push({
      severity: 'error',
      file: d.files.join(', '),
      id: d.id,
      field: 'id',
      message: `duplicate id "${d.id}" in ${d.files.length} files`,
    });
  }

  for (const rec of notes.values()) {
    const at = (field: string, message: string, severity: Issue['severity'] = 'error') =>
      issues.push({ severity, file: rec.file, id: rec.id, field, message });

    // --- facets ---
    for (const [facet, values] of Object.entries(rec.facets)) {
      const def = facets[facet];
      if (!def) {
        at(`facets.${facet}`, `unknown facet "${facet}" — add it to facets.yaml or remove it`);
        continue;
      }
      if (!def.open) {
        for (const v of values) {
          if (!def.values.includes(v)) {
            at(
              `facets.${facet}`,
              `"${v}" is not an allowed value for "${facet}" (allowed: ${def.values.join(', ')})`,
            );
          }
        }
      }
      // A single-valued facet held twice is not a note in two columns, it is a
      // note in no coherent state — and a derived signal reading one of the
      // two values disagrees with the board showing the other.
      if (def.single && values.length > 1) {
        at(
          `facets.${facet}`,
          `"${facet}" holds one value at a time, and this has ${values.length}: ${values.join(', ')}`,
        );
      }
      // A reference facet's values are note ids. A value that resolves to
      // nothing is a warning rather than an error — an agent may write a note
      // before the one it points at exists.
      // A typed facet's values have to *be* what the type says, or every
      // comparison downstream is guessing.
      if (def.type === 'date') {
        for (const v of values) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
            at(`facets.${facet}`, `"${facet}" is a date facet, and "${v}" is not YYYY-MM-DD`);
          }
        }
      }
      if (def.type === 'number') {
        for (const v of values) {
          if (!Number.isFinite(Number(v))) {
            at(`facets.${facet}`, `"${facet}" is a number facet, and "${v}" is not a number`);
          }
        }
      }
      if (isRef(def)) {
        for (const v of values) {
          if (v === rec.id) at(`facets.${facet}`, `"${facet}" points at its own note`);
          else if (!notes.has(v)) {
            at(`facets.${facet}`, `"${facet}" names "${v}", which is not a note`, 'warning');
          } else if (wouldCycle(rec.id, v, (cur) => notes.get(cur)?.facets[facet] ?? [])) {
            at(`facets.${facet}`, `"${facet}" forms a cycle through "${v}"`);
          }
        }
      }
    }

    /**
     * One edge, stored twice.
     *
     * Two reference facets on one note naming the *same* note is the only
     * relation problem a validator can judge without holding an opinion about how
     * you file: whichever of the two you drop, nothing is lost, because the
     * remaining one already records that this note points at that one. Every
     * consequence follows from that — the canvas draws one shape under two edge
     * colours, and the panel lists the note under both relations' derived rows,
     * so the reader sees a structure that is really one fact wearing two hats.
     *
     * Deliberately *not* the check it grew out of, which was "a decomposition
     * relation should not name a project note". That one is policy — it needs to
     * know which of a vault's relations mean containment, and the note that being
     * blocked by a whole project is perfectly reasonable is what kills it. The
     * removed "this note has no project" warning below is the same lesson: a
     * validator judges whether a *file* is coherent, and a view judges how you
     * work.
     *
     * Facet-agnostic for the reason `vocabulary.test.ts` asserts: naming a
     * relation here would be an axis one vault gets a check for and every other
     * vault cannot have.
     */
    const named = new Map<string, string[]>();
    for (const [facet, values] of Object.entries(rec.facets)) {
      const def = facets[facet];
      if (!def || !isRef(def)) continue;
      for (const v of values) named.set(v, [...(named.get(v) ?? []), facet]);
    }
    for (const [target, via] of named) {
      if (via.length < 2 || !notes.has(target)) continue;
      const labels = via.map((f) => `"${f}"`).join(' and ');
      at(
        `facets.${via.join(', facets.')}`,
        `${labels} both name "${target}" — one edge stored twice, so one of them ` +
          `adds nothing the other does not already say`,
        'warning',
      );
    }


    // --- links ---
    for (const l of rec.links) {
      if (!l.kind) at('links', `unrecognised link "${l.raw}"`, 'warning');
      else if (!isKnownKind(l.kind)) at('links', `unknown link kind "${l.kind}"`, 'warning');
      if (l.kind === 'doc') {
        const { path, tried } = resolveDoc(l.ref, dataRoot);
        if (!path) {
          at('links', `doc not found: ${l.ref} (looked in ${tried.join(', ')})`, 'warning');
        }
      }
    }

    // --- project block ---
    if (isProject(rec)) {
      for (const repo of rec.project?.repos ?? []) {
        const p = resolvePath(repo.path, dataRoot);
        if (!existsSync(p)) at('project.repos', `repo path not found: ${repo.path}`, 'warning');
      }
      // Instructions moved out of the frontmatter and into a file. An error
      // rather than a warning, and named here rather than left to the schema to
      // strip, because the failure it prevents is silent: the key parses, the
      // vault loads, the board draws — and members stop inheriting the rules they
      // are supposed to work under, with nothing anywhere saying so.
      if (rec.project?.instructions !== undefined) {
        // At the vault root there is no folder to put the file in yet, so the fix
        // is the move that creates one — which is the whole shape of a project now.
        const notes = paths(dataRoot).notes;
        const atRoot = resolve(dirname(rec.file)) === resolve(notes);
        at(
          'project.instructions',
          `instructions are a file now — move them to ` +
            (atRoot
              ? `${rec.id}/${INSTRUCTIONS_FILE}, and this note to ${rec.id}/README.md`
              : join(relative(notes, dirname(rec.file)), INSTRUCTIONS_FILE)),
        );
      }
    }

  }

  // There is deliberately no "this note has no project" warning here any more.
  //
  // It was one, exempting a project note and reporting the rest. The exemption
  // was policy — a project is configuration rather than work — and policy moved
  // to the view that asks the question, which is where you can see and change
  // it. A validator has no view, so generalising the warning meant reporting
  // every root project in the vault: twelve of nineteen, all of them correct as
  // filed. `views/triage.yaml` answers this now — a `lists:` composition whose
  // columns are the rule views, each free to carry the `type:` condition a
  // validator has nowhere to say — and `pj check` is left judging whether a
  // *file* is valid.

  // A project value has to name a note that actually carries configuration.
  // Stronger than the generic reference check above, which only asks whether the
  // value names a note at all.
  const projectKeys = new Set<string>();
  for (const rec of notes.values()) {
    if (rec.project) projectKeys.add(rec.id);
  }
  for (const rec of notes.values()) {
    for (const v of rec.facets.project ?? []) {
      if (!projectKeys.has(v)) {
        issues.push({
          severity: 'warning',
          file: rec.file,
          id: rec.id,
          field: 'facets.project',
          message: `project "${v}" has no note carrying a matching project: block`,
        });
      }
    }
  }

  return issues;
}

export function formatIssues(issues: Issue[], dataRoot: string): string {
  if (!issues.length) return 'ok — no problems found';
  const rel = (f: string) => f.replace(dataRoot + '/', '');
  const errs = issues.filter((i) => i.severity === 'error');
  const warns = issues.filter((i) => i.severity === 'warning');
  const lines: string[] = [];
  for (const i of [...errs, ...warns]) {
    const tag = i.severity === 'error' ? 'ERROR  ' : 'warning';
    const where = i.field ? `${rel(i.file)} [${i.field}]` : rel(i.file);
    lines.push(`${tag} ${where}: ${i.message}`);
  }
  lines.push('');
  lines.push(`${errs.length} error(s), ${warns.length} warning(s)`);
  return lines.join('\n');
}

