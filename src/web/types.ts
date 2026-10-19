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

export type { NoteDTO, NoteDetailDTO } from '../view/dto.ts';
export type { QueryPayload } from '../view/payload.ts';
export type { ViewSpec } from '../view/spec.ts';
export type { Dir, Shape } from '../schema/vocabulary.ts';
export type { Meta, SavedViewSummary } from '../server/meta.ts';
export type { FacetDef, FacetType, Facets, ResolvedProject } from '../schema/types.ts';
export type { AxisCount, Focus, Group, Query, Rollup, ValueCount } from '../index/query.ts';
export type { Enrichment, Tone } from '../enrich/types.ts';
export type { Resolved } from '../server/enrich.ts';

import type { NoteDetailDTO } from '../view/dto.ts';
import type { ResolvedProject } from '../schema/types.ts';
import type { Ask, KernelNote } from '../kernel/state.ts';
import type { KernelWork } from '../kernel/worktree.ts';
export type { Ask, KernelNote } from '../kernel/state.ts';
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
  note: NoteDetailDTO;
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
  /** What the owner's kernel says about this note, or null when it has no intent there. */
  kernel: KernelNote | null;
  /** What the panel asks when the note's lifecycle and its intent part ways (`askOf`), or null. */
  ask: Ask | null;
  /** The vault has a kernel that answered: an intent can be opened about this note. */
  kernelOn: boolean;
}

/**
 * `POST /api/note/:id/work`, both answers: the kernel's worktree attempt for the
 * note's open intent, planned (`dryRun`) or started. One type because the plan
 * *is* the result minus what happened — `attempt`, `link` and the per-repo
 * `ok`/`error` are what a start adds. See `kernel/worktree.ts`.
 */
export type WorkResult = KernelWork;

/**
 * A candidate a sweep saw and nobody filed.
 *
 * Not a note, which is why it has its own shape and its own endpoint rather than
 * arriving through `/api/query` — the query compiler answers about notes.
 */
export interface Declined {
  fingerprint: string;
  channel: string | null;
  title: string | null;
  reason: string;
  at: string;
  /** `model` when the classifier decided, `person` when you did. */
  decidedBy: 'model' | 'person';
  /**
   * True when this was a note you had accepted, rather than an offer turned down.
   * Both are here and both are reversible; only an offer teaches the classifier.
   */
  wasJudged: boolean;
}

/**
 * One page of the declined pile.
 *
 * Paged because it only grows: every sweep that declines something adds a row and
 * nothing removes one but a rescue. `more` says there is another page behind this
 * one; `total` ignores the search, because it is what the sidebar counts, and
 * `matching` honours it, because it is what the pager counts.
 */
export interface DeclinedPage {
  rows: Declined[];
  more: boolean;
  total: number;
  /** How many match the search, ignoring the page — the pager's denominator. */
  matching: number;
  /** Of `total`, how many the classifier decided — the same population, so the two can be said together. */
  byModel: number;
}
