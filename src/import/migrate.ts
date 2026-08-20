import { readFileSync } from 'node:fs';
import { paths } from '../config.ts';
import { patchKey } from '../schema/frontmatter.ts';
import { writeCardFile } from '../schema/card.ts';
import { readAll } from '../index/indexer.ts';
import { parentsOf, projectRecords } from '../index/project.ts';
import type { Rec } from '../schema/types.ts';

/**
 * One-off: project membership used to be inferred from the parent chain and is
 * now an ordinary `project` facet.
 *
 * Purely additive. The `project` facet is written where it can be inferred, and
 * parent edges are left exactly as they are — they now mean decomposition, which
 * is what the canvas draws, and are independent of membership from here on.
 */
export interface MigrationReport {
  cardsGiven: { id: string; project: string[] }[];
  projectsLinked: { id: string; project: string[] }[];
  alreadySet: number;
  noProject: number;
}

/** Nearest project record at or above `id`, following parent edges. */
function inferProject(id: string, byId: Map<string, Rec>, registry: Map<string, Rec>): string | null {
  const keyOf = (rec: Rec) => rec.project?.key ?? rec.id;
  const seen = new Set<string>();
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      if (seen.has(cur)) continue;
      seen.add(cur);
      const rec = byId.get(cur);
      if (!rec) continue;
      if (cur !== id && rec.project) return keyOf(rec);
      next.push(...parentsOf(rec));
    }
    frontier = next;
  }
  // A project record with no project ancestor belongs to nothing above it.
  const self = byId.get(id);
  return self?.project && id !== self.id ? keyOf(self) : null;
}

export function migrateProjectFacet(dataRoot?: string, apply = false): MigrationReport {
  const p = paths(dataRoot);
  const { records } = readAll(p.cards);
  const registry = projectRecords(records);
  const report: MigrationReport = {
    cardsGiven: [],
    projectsLinked: [],
    alreadySet: 0,
    noProject: 0,
  };

  for (const rec of records.values()) {
    if (rec.facets.project?.length) {
      report.alreadySet++;
      continue;
    }
    const inferred = inferProject(rec.id, records, registry);
    if (!inferred) {
      report.noProject++;
      continue;
    }
    const facets = { ...rec.facets, project: [inferred] };
    if (apply) {
      writeCardFile(rec.file, patchKey(readFileSync(rec.file, 'utf8'), 'facets', facets));
    }
    (rec.project ? report.projectsLinked : report.cardsGiven).push({
      id: rec.id,
      project: [inferred],
    });
  }

  return report;
}
