import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { FacetDef, FacetType, Facets } from './types.ts';

const TYPES: readonly FacetType[] = ['label', 'ref', 'date', 'number'];

/** A reference facet holds record ids, so it is traversable as well as filterable. */
export function isRef(def: FacetDef | undefined): boolean {
  return def?.type === 'ref';
}

/** An ordered facet compares its values rather than matching them. */
export function isOrdered(def: FacetDef | undefined): boolean {
  return def?.type === 'date' || def?.type === 'number';
}

/**
 * Load the facet vocabulary. This file is the single place column order lives —
 * what list-order does in Trello, made explicit and shared by every view.
 *
 * It is also where the constraints live: `open` decides whether a new value is
 * accepted, `single` whether more than one may be held at once, and `type` what
 * the values *are* — a label from the declared list, a record id, a date or a
 * number.
 */
export function loadFacets(file: string): Facets {
  if (!existsSync(file)) return {};
  const raw = parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (!raw) return {};
  const out: Facets = {};
  for (const [name, def] of Object.entries(raw)) {
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    const type = (TYPES as readonly string[]).includes(String(d.type))
      ? (d.type as FacetType)
      : 'label';
    // Only a `label` has a declared vocabulary: a reference's is the vault, and
    // an ordered facet's is unbounded. A list on either is dropped rather than
    // half-honoured.
    const declared = type === 'label' && Array.isArray(d.values) ? d.values.map(String) : [];
    const raw = d.buckets as Record<string, unknown> | undefined;
    const buckets =
      raw && typeof raw === 'object'
        ? Object.entries(raw)
            .filter(([, v]) => typeof v === 'number')
            .map(([name, v]) => ({ name, upTo: v as number }))
        : undefined;
    out[name] = {
      label: typeof d.label === 'string' ? d.label : name,
      type,
      values: declared,
      open: type !== 'label' || d.open === true,
      single: d.single === true,
      ...(buckets?.length ? { buckets } : {}),
      ...(typeof d.overflow === 'string' ? { overflow: d.overflow } : {}),
    };
  }
  return out;
}

/**
 * Column order for a facet: declared order first, then any extras seen in cards.
 *
 * A **bucketed** facet declares its order through `buckets` rather than
 * `values` — the boundaries are written in order and `overflow` comes last, so
 * `overdue · today · week · later` is what the axis reads. Without this the
 * order fell through to alphabetical, which put `later` first.
 */
export function orderValues(def: FacetDef | undefined, seen: Iterable<string>): string[] {
  const declared = def?.buckets?.length
    ? [...def.buckets.map((b) => b.name), def.overflow ?? []].flat()
    : (def?.values ?? []);
  const extras = [...new Set(seen)].filter((v) => !declared.includes(v)).sort();
  return [...declared, ...extras];
}

export function facetRank(def: FacetDef | undefined, value: string): number {
  const i = orderValues(def, []).indexOf(value);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * The bucket a value falls in, or the value itself when the facet declares none.
 *
 * `today` is passed rather than read, so a query is reproducible and a test does
 * not depend on the day it runs.
 */
export function bucketOf(def: FacetDef | undefined, value: string, today: string): string {
  if (!def?.buckets?.length) return value;
  const n = def.type === 'date' ? daysBetween(today, value) : Number(value);
  if (n === null || Number.isNaN(n)) return value;
  for (const b of def.buckets) if (n <= b.upTo) return b.name;
  return def.overflow ?? def.buckets.at(-1)!.name;
}

const DAY = 86_400_000;

/** Whole days from `from` to `to`, or null if either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / DAY);
}

/** Compare two raw values the way the type means them. */
export function compareValues(def: FacetDef | undefined, a: string, b: string): number {
  if (def?.type === 'number') return Number(a) - Number(b);
  // A `YYYY-MM-DD` date sorts correctly as text, which is the whole reason for
  // insisting on that format rather than accepting anything Date.parse takes.
  return a.localeCompare(b);
}
