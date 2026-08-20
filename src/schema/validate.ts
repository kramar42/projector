import { existsSync } from 'node:fs';
import { isKnownKind } from './links.ts';
import { EDGE_TYPES, type Facets, type Issue, type Rec } from './types.ts';
import { ancestorChains, isProject, parentsOf } from '../index/project.ts';
import { resolvePath } from '../config.ts';
import { resolveDoc } from '../vault.ts';

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
      if (def.scope?.under) {
        const under = def.scope.under;
        const inScope = ancestorChains(rec.id, records).some((chain) => chain.includes(under));
        if (!inScope) {
          at(
            `facets.${facet}`,
            `"${facet}" is scoped to records beneath "${under}", and this record is not beneath it`,
          );
        }
      }
    }

    // --- edges ---
    for (const e of rec.edges) {
      if (!(EDGE_TYPES as readonly string[]).includes(e.type)) {
        at('edges', `unknown edge type "${e.type}"`);
      }
      if (e.to === rec.id) at('edges', `edge points at itself`);
      else if (!records.has(e.to)) {
        at('edges', `edge target "${e.to}" does not resolve to any record`, 'warning');
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

    // --- cycles ---
    if (hasCycle(rec.id, records)) at('edges', 'parent edges form a cycle');
  }

  // A card with no project groups under (none) and inherits nothing. Note this
  // is about the `project` facet, not about parent edges: the two are
  // independent, and a card may legitimately have either, both or neither.
  const projectKeys = new Set<string>();
  for (const rec of records.values()) {
    if (rec.project) projectKeys.add(rec.project.key ?? rec.id);
  }
  for (const rec of records.values()) {
    if (rec.kind !== 'card') continue;
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

function hasCycle(start: string, records: Map<string, Rec>): boolean {
  const seen = new Set<string>();
  const stack = [start];
  let first = true;
  while (stack.length) {
    const cur = stack.pop()!;
    if (!first && cur === start) return true;
    first = false;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const rec = records.get(cur);
    if (rec) stack.push(...parentsOf(rec));
  }
  return false;
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
