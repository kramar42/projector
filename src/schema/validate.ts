import { existsSync } from 'node:fs';
import { isKnownKind } from './links.ts';
import { isRef } from './facets.ts';
import type { Facets, Issue, Rec } from './types.ts';
import { isProject } from '../index/project.ts';
import { wouldCycle } from '../index/refs.ts';
import { resolvePath } from '../config.ts';
import { resolveDoc } from '../vault.ts';
import { PSEUDO } from '../index/query.ts';
import type { ViewSpec } from '../view/spec.ts';

/**
 * Validate every record against the loaded vocabulary and the graph.
 *
 * Collects every problem rather than stopping at the first — a card file is
 * something you fix in one pass, so the report has to be complete.
 */
export function validate(
  records: Map<string, Rec>,
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

  for (const rec of records.values()) {
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
      // A single-valued facet held twice is not a record in two columns, it is a
      // record in no coherent state — and a derived signal reading one of the
      // two values disagrees with the board showing the other.
      if (def.single && values.length > 1) {
        at(
          `facets.${facet}`,
          `"${facet}" holds one value at a time, and this has ${values.length}: ${values.join(', ')}`,
        );
      }
      // A reference facet's values are record ids. A value that resolves to
      // nothing is a warning rather than an error — an agent may write a card
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
          if (v === rec.id) at(`facets.${facet}`, `"${facet}" points at its own record`);
          else if (!records.has(v)) {
            at(`facets.${facet}`, `"${facet}" names "${v}", which is not a record`, 'warning');
          } else if (wouldCycle(rec.id, v, (cur) => records.get(cur)?.facets[facet] ?? [])) {
            at(`facets.${facet}`, `"${facet}" forms a cycle through "${v}"`);
          }
        }
      }
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
    }

  }

  // A card with no project groups under (none) and inherits nothing. Note this
  // is about the `project` facet, not about parent edges: the two are
  // independent, and a card may legitimately have either, both or neither.
  const projectKeys = new Set<string>();
  for (const rec of records.values()) {
    if (rec.project) projectKeys.add(rec.id);
  }
  for (const rec of records.values()) {
    const mine = rec.facets.project ?? [];
    // A project record is its own context, so a root project belongs to nothing
    // above it and that is not a problem to report.
    if (!mine.length && !rec.project) {
      issues.push({
        severity: 'warning',
        file: rec.file,
        id: rec.id,
        field: 'facets.project',
        message: 'no project — groups under (none) and inherits no repos or instructions',
      });
      continue;
    }
    for (const v of mine) {
      if (!projectKeys.has(v)) {
        issues.push({
          severity: 'warning',
          file: rec.file,
          id: rec.id,
          field: 'facets.project',
          message: `project "${v}" has no record carrying a matching project: block`,
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

/**
 * Validate saved views against the loaded vocabulary.
 *
 * A card is checked against `facets.yaml`; a view was not checked against
 * anything. `pj next` filtered on `kind` — a facet P7 deleted — for two days,
 * and moving that query into `views/*.yaml` only relocates the failure unless
 * something reads it: a filter naming an axis the vocabulary lost matches
 * nothing, and matching nothing is not an error anywhere else in the stack.
 *
 * Every position that holds a facet name is checked, because a validator with
 * two blind spots has the same hole in two fewer places. `focus.via` is the one
 * that needs more than existence: it is *walked*, so a label facet parses
 * happily and then traverses nothing.
 *
 * Views arrive already loaded, with the file each came from. This module knows
 * how to judge a view, not where views live.
 */
export function validateViews(
  views: { spec: ViewSpec; file: string }[],
  facets: Facets,
): Issue[] {
  const issues: Issue[] = [];
  // A stored axis or a computed one: `blocked` is no less askable than `status`
  // for being derived (C4), and a view may name either.
  const known = (name: string) => !!facets[name] || !!PSEUDO[name];

  for (const { spec, file } of views) {
    const at = (field: string, message: string) =>
      issues.push({ severity: 'error', file, id: spec.name, field, message });

    const axis = (name: string, field: string) => {
      if (!known(name)) {
        at(field, `no facet or computed axis "${name}" — a view naming one matches nothing, silently`);
      }
    };

    for (const name of Object.keys(spec.query.filter ?? {})) axis(name, `filter.${name}`);
    for (const name of spec.query.groupBy ?? []) axis(name, 'groupBy');
    for (const name of spec.show) axis(name, 'show');

    for (const key of spec.query.sort ?? []) {
      const name = key.split(':')[0] ?? '';
      // `updated`, `created` and `title` are record fields rather than facets,
      // and the comparator sorts by them directly.
      if (name === 'updated' || name === 'created' || name === 'title') continue;
      axis(name, 'sort');
    }

    const via = spec.query.focus?.via;
    if (via !== undefined) {
      if (!isRef(facets[via])) {
        at(
          'focus.via',
          `focus walks "${via}", which is not a reference facet — the traversal would find nothing`,
        );
      }
    }
  }

  return issues;
}
