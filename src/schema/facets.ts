import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { FacetDef, Facets } from './types.ts';

/**
 * Load the facet vocabulary. This file is the single place column order lives —
 * what list-order does in Trello, made explicit and shared by every view.
 *
 * It is also where the constraints live: `open` decides whether a new value is
 * accepted, `single` whether more than one may be held at once, and `ref`
 * whether the values are record ids rather than labels.
 */
export function loadFacets(file: string): Facets {
  if (!existsSync(file)) return {};
  const raw = parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (!raw) return {};
  const out: Facets = {};
  for (const [name, def] of Object.entries(raw)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    const ref = d.ref === true;
    out[name] = {
      label: typeof d.label === 'string' ? d.label : name,
      // A reference facet's vocabulary is the vault, so a declared list is
      // always a mistake and is dropped rather than half-honoured.
      values: !ref && Array.isArray(d.values) ? d.values.map(String) : [],
      open: ref || d.open === true,
      single: d.single === true,
      ref,
    };
  }
  return out;
}

/** Column order for a facet: declared order first, then any extras seen in cards. */
export function orderValues(def: FacetDef | undefined, seen: Iterable<string>): string[] {
  const declared = def?.values ?? [];
  const extras = [...new Set(seen)].filter((v) => !declared.includes(v)).sort();
  return [...declared.filter((v) => v !== undefined), ...extras];
}

export function facetRank(def: FacetDef | undefined, value: string): number {
  const i = def?.values.indexOf(value) ?? -1;
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
