import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { FacetDef, FacetType, Facets } from './types.ts';
export { isOrdered, isRef } from './vocabulary.ts';

const TYPES: readonly FacetType[] = ['label', 'ref', 'date', 'number'];

/**
 * The vocabulary every vault has, whether or not it writes a file.
 *
 * `project` is here rather than in `facets.yaml` because a declaration you must
 * validate as unchangeable is not a declaration — it invites editing and then
 * refuses it. Retyping this to `label` would strand the config chain, which walks
 * it as a relation, so the definition is not read from the file at all.
 *
 * It stays a *facet* nonetheless, injected into the map below. That is what keeps
 * it cheap: the filter rail, the panel's row order, the group and sort pickers,
 * drag-and-drop and the editor's choice of control are all loops over this map,
 * and lifting `project` out of it would mean bolting it back into every one of
 * them by hand. Being a facet is what stops it being a special case.
 *
 * They sort first, and permanently: a vault may declare one to set its label or
 * its triage expectation, but the position is the built-in's. That is the right
 * place for the axis every vault shares, and it stops a barely-used local facet
 * pushing it off the rail.
 */
export const BUILTIN_FACETS: Facets = {
  project: { label: 'Project', type: 'ref', values: [], open: true, single: false, builtin: true },
};

/**
 * The keys of a built-in a vault may not change. Everything else on it is fair
 * game.
 *
 * The reason `project` is built in at all is that its *shape* must hold: the
 * config chain walks it as a relation, so retyping it to `label` would strand
 * inheritance with nothing to say so. None of that is true of what it is called
 * or whether a card is expected to carry one — those are a vault's business.
 *
 * It declares no `hue`, and that is the point rather than an omission: `builtin`
 * is what the client reads, and the app's own axis draws in the app's own colour.
 * It used to ask for `blue`, which put the one axis every vault shares in a family
 * a vault's own axis could also claim — and the two places that drew a project
 * value had picked *purple* anyway, neither of them from this declaration. A vault
 * may still set `hue`, and on a reference axis that colours its canvas edge; see
 * `src/web/hue.ts`, which is the one place any of this is decided.
 *
 * So a declaration of a built-in is allowed and merges *under* this list.
 * `pj check` errors only when one of these keys is the thing being set.
 */
export const STRUCTURAL: readonly string[] = ['type', 'values', 'open', 'single'];

/**
 * Load the facet vocabulary. This file is the single place column order lives —
 * what list-order does in Trello, made explicit and shared by every view.
 *
 * It is also where the constraints live: `open` decides whether a new value is
 * accepted, `single` whether more than one may be held at once, and `type` what
 * the values *are* — a label from the declared list, a note id, a date or a
 * number.
 *
 * An absent or empty file is a valid vault: what comes back is the built-ins and
 * nothing else.
 */
export function loadFacets(file: string): Facets {
  if (!existsSync(file)) return { ...BUILTIN_FACETS };
  const raw = parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (!raw) return { ...BUILTIN_FACETS };
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
    // Two shapes, because `buckets: { overdue: -1, today: 0 }` reads as the
    // ordered number line it is and must stay that terse. A bucket that wants a
    // hue of its own spells itself out instead; the rest keep the shorthand.
    const buckets =
      raw && typeof raw === 'object'
        ? Object.entries(raw).flatMap(([name, v]) => {
            if (typeof v === 'number') return [{ name, upTo: v }];
            if (!v || typeof v !== 'object') return [];
            const b = v as Record<string, unknown>;
            if (typeof b.upTo !== 'number') return [];
            return [{ name, upTo: b.upTo, ...(typeof b.hue === 'string' ? { hue: b.hue } : {}) }];
          })
        : undefined;
    out[name] = {
      label: typeof d.label === 'string' ? d.label : name,
      type,
      values: declared,
      open: type !== 'label' || d.open === true,
      single: d.single === true,
      ...(buckets?.length ? { buckets } : {}),
      ...(typeof d.overflow === 'string' ? { overflow: d.overflow } : {}),
      ...(Array.isArray(d.closed) ? { closed: d.closed.map(String) } : {}),
      ...(d.expected === true ? { expected: true } : {}),
      ...(d.blocking === true ? { blocking: true } : {}),
      ...(typeof d.hue === 'string' ? { hue: d.hue } : {}),
      ...(typeof d.inverse === 'string' ? { inverse: d.inverse } : {}),
    };
  }
  // Built-ins lead the order, and win their structural keys. A vault may still
  // set the rest — its label, whether a card is expected to carry one — so a
  // declaration merges *under* the built-in's shape rather than being discarded.
  //
  // Only the keys the file actually *wrote*. A normalised definition carries a
  // value for everything, including a `label` defaulted to the facet's own name —
  // so merging the whole of it made `project: {expected: true}` silently rename
  // the axis to lowercase `project`. What a vault did not say is not a setting.
  const merged: Facets = { ...BUILTIN_FACETS, ...out };
  for (const [name, builtin] of Object.entries(BUILTIN_FACETS)) {
    const declared = out[name];
    if (!declared) {
      merged[name] = builtin;
      continue;
    }
    const wrote = Object.keys((raw[name] ?? {}) as Record<string, unknown>).filter(
      (k) => !STRUCTURAL.includes(k),
    );
    merged[name] = { ...builtin, ...pick(declared, wrote) };
  }
  return merged;
}

function pick(def: FacetDef, keys: readonly string[]): Partial<FacetDef> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = def[k as keyof FacetDef];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<FacetDef>;
}

/**
 * The file's raw top-level mapping, exactly as written.
 *
 * Distinct from `loadFacets`, which injects the built-ins and normalises every
 * definition — so a validator asking "did somebody declare a name they may not,
 * and what did they set on it" has to ask here. Reading the file twice is the
 * cost of that question being answerable at all; it is asked once, by `pj check`.
 */
export function declaredFacets(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  return (parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null) ?? {};
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
