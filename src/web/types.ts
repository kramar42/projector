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

/**
 * `POST /api/note/:id/work`, both answers.
 *
 * One type for the plan and the result because the plan *is* the result minus
 * what happened: `workspace`, `branch` and `repos` are the same three facts
 * either way, and everything optional below is what a commit adds. Two types
 * would have let a caller read `opening` off a plan that never created one.
 */
export interface WorkResult {
  workspace: string;
  branch: string;
  repos: { path: string; base?: string }[];
  /** The briefing text, on a plan only — the commit writes it to a file instead. */
  briefing?: string;
  /** One entry per declared repo, on a commit only. */
  results?: { name: string; path: string; created: boolean; error: string | null }[];
  /**
   * Where to go, on a commit only — and whether that is a new session at all.
   * `running` is a live session the desktop app cannot be pointed at, so it
   * carries no link: there is nothing to open and saying so is the answer.
   */
  opening?:
    | { how: 'new'; link: string }
    | { how: 'reopen'; link: string; session: WorkSession }
    | { how: 'running'; session: WorkSession };
  /** Whether the note now carries `workspace:<path>`, and why not if it does not. */
  recorded?: boolean;
  recordError?: string | null;
  briefingPath?: string;
}

/** A session already working in the workspace, as the panel reports it. */
export interface WorkSession {
  uuid: string;
  state: 'working' | 'stalled' | 'waiting' | 'closed';
  opening: string;
  lastAt: string;
}

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
 * one; `total` ignores the search, because it is what the sidebar counts.
 */
export interface DeclinedPage {
  rows: Declined[];
  more: boolean;
  total: number;
}
