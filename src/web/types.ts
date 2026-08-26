/**
 * What the client consumes, re-exported rather than restated.
 *
 * This file used to be 183 lines of hand-copied interfaces, and four of its
 * fields had quietly drifted from the server's — `rollups` optional here and
 * required there, `views[].title` required here and optional there, and two
 * nullability pairs that ran the other way. Nothing checked one against the
 * other, because there was nothing to check: the client could not import
 * `src/view/spec.ts` at all while it pulled `node:fs` in through the facet
 * loader.
 *
 * It can now, so the types come from where they are produced. A drift becomes a
 * type error. The barrel stays because one place naming what crosses the wire is
 * worth keeping — it just re-exports instead of transcribing.
 */

export type { NoteDTO } from '../view/dto.ts';
export type { QueryPayload } from '../view/payload.ts';
export type { ViewSpec } from '../view/spec.ts';
export type { Dir, Shape } from '../schema/vocabulary.ts';
export type { Meta, SavedViewSummary } from '../server/meta.ts';
export type { FacetDef, FacetType, Facets, ResolvedProject } from '../schema/types.ts';
export type { AxisCount, Focus, Group, Query, Rollup, ValueCount } from '../index/query.ts';
export type { Enrichment, Tone } from '../enrich/types.ts';
export type { Resolved } from '../server/enrich.ts';

import type { NoteDTO } from '../view/dto.ts';
import type { ResolvedProject } from '../schema/types.ts';
import type { QueryPayload } from '../view/payload.ts';
import type { ViewSpec as Spec } from '../view/spec.ts';

/**
 * The query response, as the client sees it.
 *
 * An alias rather than a copy: `queryPayload` builds this, and there is no second
 * opinion about what it contains.
 */
export type QueryResponse = QueryPayload;

/**
 * A control names what it wants of the spec; `App` turns the result into the URL
 * overrides that carry it. Here rather than in the sidebar because the sidebar is
 * several files now and they would otherwise import each other in a circle.
 */
export type Edit = (fn: (spec: Spec) => Spec, replace?: boolean) => void;

/** One note and everything the panel needs around it — `GET /api/note/:id`. */
export interface NoteDetail {
  note: NoteDTO;
  file: string;
  /** File mtime at read time; sent back on a write so a concurrent edit 409s. */
  mtime: number;
  /** The raw frontmatter, from the same read as `mtime` — one file, one answer. */
  yaml: string;
  /**
   * Every note this card's reference facets point at, resolved.
   *
   * Keyed by id, because that is what a reference facet stores and therefore
   * what the editor has in hand. It replaces a `parents` list that answered the
   * same question for one facet only — which is what let `parent` acquire a
   * second, better-looking control while `blocked_by` and `project` kept drawing
   * raw ids.
   */
  refs: Record<string, { title: string; isProject: boolean; refCount: number }>;
  /**
   * The notes naming this one, keyed by the relation they named it through —
   * and only for the relations whose vocabulary gave the other end a word.
   *
   * It was two fields, `children` and `blocks`, which is the same map with its
   * two keys written into the type.
   */
  inbound: Record<string, { id: string; title: string; done: boolean; isProject: boolean; refCount: number }[]>;
  project: ResolvedProject | null;
}
