import type { PatchCard } from '../api.ts';

/**
 * What the panel writes, and every decision it makes about writing.
 *
 * Type-only imports, so `node --test` loads this without `fetch`, `EventSource`
 * or `localStorage` — the same shape as `src/view/intents.ts`, and for the same
 * reason: what is testable is what is pure, and this is where the panel's
 * decisions were hiding.
 *
 * They were hiding inside `run(label, fn)`, which took a *thunk*. A thunk is
 * opaque, so the one thing every write must carry — the mtime it is gated on —
 * was the caller's job, written out at five call sites and forgotten at a sixth.
 * The forgotten one was the parent picker, which reached for the bulk endpoint;
 * `bulkFacet` takes no base mtime and never calls `guard`, so re-parenting from
 * the panel silently overwrote a concurrent agent edit while the chip row two
 * inches below it correctly refused (C3).
 *
 * The fix is not a rule. It is that a write is now a *value* with nowhere to put
 * an mtime, and the one function that stamps it is here.
 */

/**
 * Everything the panel can change about one card.
 *
 * No variant carries an mtime and none carries a label, so a call site has
 * nothing to supply and therefore nothing to forget. `facet` names ONE axis: the
 * whole map is not expressible from the browser, because the browser's copy is
 * as old as its last render (C4 — and no axis is named here either).
 */
/**
 * How a facet write means its values, mirroring the server's own vocabulary.
 *
 * `set` is the only mode that discards what it did not see, so it belongs to the
 * controls that genuinely replace an axis — a date, a single-valued toggle, a
 * parent. A multi-valued toggle is a *delta*, and saying so is what stops it
 * reverting a value an agent added between this render and the click.
 */
export type FacetMode = 'set' | 'add' | 'remove';

export type CardWrite =
  | { kind: 'facet'; name: string; values: string[]; mode: FacetMode }
  | { kind: 'title'; title: string }
  | { kind: 'links'; links: string[] }
  /** The frontmatter `project:` BLOCK, not the `project` ref facet. `null` removes it. */
  | { kind: 'projectBlock'; block: Record<string, unknown> | null }
  | { kind: 'body'; body: string }
  | { kind: 'frontmatter'; yaml: string }
  | { kind: 'delete' };

/** The busy word, in one place, so no control invents its own wording. */
export function labelFor(w: CardWrite): string {
  switch (w.kind) {
    case 'facet':
      return 'saving facets';
    case 'title':
      return 'renaming';
    case 'links':
      return 'saving links';
    case 'projectBlock':
      return w.block ? 'making a project' : 'un-projecting';
    case 'body':
      return 'saving body';
    case 'frontmatter':
      return 'saving frontmatter';
    case 'delete':
      return 'deleting';
  }
}

export type Plan =
  | { call: 'patch'; body: PatchCard }
  | { call: 'frontmatter'; yaml: string; baseMtime: number }
  | { call: 'delete' };

/**
 * The wire body for a write, gated on `base`.
 *
 * INVARIANT: every plan that can lose data carries `base`, stamped here and
 * nowhere else in the browser. `delete` is the one exception, because there is no
 * `guard` to satisfy on a file that is going away — and it is the *type* that
 * says so, rather than a comment asking to be noticed.
 *
 * There is no `bulk` variant, which is what makes "the panel writes one card"
 * structural rather than a habit.
 */
export function planWrite(w: CardWrite, base: number): Plan {
  switch (w.kind) {
    case 'facet':
      return {
        call: 'patch',
        body: { facet: { name: w.name, values: w.values, mode: w.mode }, baseMtime: base },
      };
    case 'title':
      return { call: 'patch', body: { title: w.title, baseMtime: base } };
    case 'links':
      return { call: 'patch', body: { links: w.links, baseMtime: base } };
    case 'projectBlock':
      return { call: 'patch', body: { project: w.block, baseMtime: base } };
    case 'body':
      return { call: 'patch', body: { body: w.body, baseMtime: base } };
    case 'frontmatter':
      return { call: 'frontmatter', yaml: w.yaml, baseMtime: base };
    case 'delete':
      return { call: 'delete' };
  }
}

// ------------------------------------------------------------------ the bases

/**
 * The mtime a write is gated on: the freshest thing known about the file.
 *
 * `read` is the last completed GET, `wrote` is what the last successful write
 * returned. **Max**, not last-wins. Both halves matter and each is a bug that has
 * a shape: taking only the read means a second chip click inside the reload
 * window carries a pre-write mtime and 409s against the user's own preceding
 * change — reported, absurdly, as "probably a Claude session". Taking the write
 * unconditionally is worse: once it is set it never yields to a fresher read, so
 * an agent editing the card makes the panel permanently unwritable, and the
 * conflict banner's Reload cannot clear it.
 */
export function baseOf(read: number | null, wrote: number | null): number | null {
  if (read === null) return wrote;
  if (wrote === null) return read;
  return Math.max(read, wrote);
}

/**
 * The mtime a **body** write is gated on: the base as of the last moment the
 * editor had nothing unsaved.
 *
 * While held it does not move, and that is the only thing standing between a
 * dirty editor and silently destroying an agent's work. The editor declines to
 * adopt an incoming `value` while dirty, so the document on screen belongs to an
 * older read — and the write has to say so, or it sails through `guard` carrying
 * a freshness it does not have. The two rules are one rule: both key on the
 * editor's own `dirty`, and there is only one of those.
 *
 * Idempotent, so assigning it during a StrictMode double render changes nothing.
 */
export function heldBase(prev: number | null, base: number | null, held: boolean): number | null {
  return held ? prev : base;
}

// ---------------------------------------------------------------- one failure

/** A failure. `conflict` is read off the error, never stored as a second flag. */
export interface Failure {
  message: string;
  conflict: boolean;
}

/**
 * Read structurally rather than with `instanceof`, so this file stays type-only
 * and the tests never load `api.ts`. `ApiError` is the only producer.
 */
export function classify(err: unknown): Failure {
  const e = err as { message?: string; conflict?: boolean } | null;
  return { message: e?.message ?? String(err), conflict: e?.conflict === true };
}

/**
 * One fact about writing, replacing `busy` + `problem` + `conflict`.
 *
 * Those three were two states for one thing and could disagree: a write cleared
 * `problem` but never `conflict`, so a rejected value — a cycle, an empty title —
 * rendered under "Changed on disk. Something else, probably a Claude session,
 * wrote this file", offering a Reload that fixed nothing. `conflict` was never an
 * independent fact; it is a projection of "the last failure was a 409" (C11).
 */
export interface WriteStatus {
  /** Writes started and not yet settled, oldest first. */
  pending: { seq: number; label: string }[];
  /** The last failure not yet superseded by a newer attempt. */
  failure: Failure | null;
}

export const idleStatus = (): WriteStatus => ({ pending: [], failure: null });

export type WriteEvent =
  | { t: 'start'; seq: number; label: string }
  | { t: 'settled'; seq: number; failure: Failure | null }
  | { t: 'dismiss' };

/**
 * ORDERING, because writes are not serialised and a chip row invites overlap:
 *
 *  - `start` clears any standing failure — a new attempt replaces the last answer.
 *  - only a `settled` carrying a failure sets one. A success never clears another
 *    write's failure, so a failure is superseded or reported, never dropped.
 *  - a `settled` for a seq that is not pending is a no-op. A write can settle
 *    after the panel has moved on, which is the same race `useLive` needed its
 *    `gen` counter for.
 */
export function nextStatus(prev: WriteStatus, ev: WriteEvent): WriteStatus {
  if (ev.t === 'dismiss') return { ...prev, failure: null };
  if (ev.t === 'start') {
    return { pending: [...prev.pending, { seq: ev.seq, label: ev.label }], failure: null };
  }
  if (!prev.pending.some((p) => p.seq === ev.seq)) return prev;
  return {
    pending: prev.pending.filter((p) => p.seq !== ev.seq),
    failure: ev.failure ?? prev.failure,
  };
}

/** What the header says while a write is in flight: the newest one started. */
export function busyLabel(s: WriteStatus): string | null {
  return s.pending.length ? s.pending[s.pending.length - 1]!.label : null;
}

/**
 * The single render decision for a failure. One fact in, one banner out — there
 * is no second opinion left to disagree with, and `canReload` is what makes the
 * offer of a Reload button a property of the failure rather than of the markup.
 */
export function bannerFor(
  s: WriteStatus,
): { tone: 'conflict' | 'bad'; message: string; canReload: boolean } | null {
  if (!s.failure) return null;
  return s.failure.conflict
    ? { tone: 'conflict', message: s.failure.message, canReload: true }
    : { tone: 'bad', message: s.failure.message, canReload: false };
}
