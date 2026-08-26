/**
 * Putting a write back.
 *
 * The app had no undo at all, which was survivable while every write cost a
 * deliberate drag or a click on a named control. A keyboard changes that
 * arithmetic: `3` is one keystroke, it lands on whatever the cursor is on, and
 * the difference between meaning it and not is a finger.
 *
 * It is cheap here because of a decision made for another reason. `dropOutcome`
 * expresses a facet change as **a delta with a mode** rather than as the values
 * it results in — `add` these, `remove` those — precisely so that twelve cards
 * dragged together could each get their own answer. A delta is invertible without
 * knowing anything at all about what it was applied to, so most of the table
 * below needs no prior state and cannot be wrong about it.
 *
 * ## What is not here
 *
 * `delete` and `merge` remove files, and nothing in the client is holding their
 * contents to put back — the confirm dialog and git are that story, and both say
 * so in those words. The body and frontmatter editors have CodeMirror's own undo,
 * which is finer-grained than this could ever be and already bound to the same
 * key inside the editor. Neither is a gap: they are the two places where the
 * answer to "can I take that back" was already yes, by another route.
 */

export type FacetMode = 'set' | 'add' | 'remove';

/** One facet write, as `api.bulk` takes it. */
export interface FacetWrite {
  ids: string[];
  facet: string;
  values: string[];
  mode: FacetMode;
}

/**
 * A step on the stack: how to do it again, and how to take it back.
 *
 * Both directions are stored rather than one being derived on demand, because
 * only one of them can be derived at a time. The inverse of a `set` needs the
 * state *before* the write; the inverse of *that* needs the state before the
 * undo, which is the original write. So each is computed while its own "before"
 * is still in hand, and redo is simply the forward list applied again.
 *
 * A list on each side, not a single write, because one `set` across a selection
 * can need several: twelve cards that held different values need one write per
 * distinct prior state to be put back.
 */
export interface Step {
  /** What the reader did. Applied again by redo. */
  forward: FacetWrite[];
  /** What puts it back. Empty when nothing could. */
  back: FacetWrite[];
  /** For the banner, in the reader's words rather than the wire's. */
  label: string;
}

/**
 * The writes that undo one write.
 *
 * `before` is asked per note, so this makes no assumption that a selection was
 * uniform — which it routinely is not. It is the same reason `nextValues` is
 * applied per note on the server rather than the client sending final values.
 */
export function inverseOf(
  write: FacetWrite,
  before: (id: string) => readonly string[],
): FacetWrite[] {
  const { ids, facet, values, mode } = write;
  if (!ids.length || !values.length && mode !== 'set') return [];

  // A delta inverts to the opposite delta, exactly, with no prior state read.
  // This is also the only branch that is safe against a concurrent write: it
  // composes with whatever else has happened to the axis since.
  if (mode === 'add') return [{ ids, facet, values, mode: 'remove' }];
  if (mode === 'remove') return [{ ids, facet, values, mode: 'add' }];

  /**
   * `set` replaced the axis, so putting it back means restoring each note's own
   * values — grouped, so notes that agreed travel in one request rather than one
   * request per note. A twelve-card selection with three distinct prior states is
   * three writes, and most selections are one.
   */
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    // `JSON.stringify` rather than a joined string: an `open: true` axis accepts
    // whatever a person types, so any separator is a value some vault can hold —
    // and two notes that differ only in where a separator fell would be grouped
    // together and restored to each other's values.
    const key = JSON.stringify([...before(id)].sort());
    const group = groups.get(key);
    if (group) group.push(id);
    else groups.set(key, [id]);
  }
  return [...groups].map(([key, group]) => ({
    ids: group,
    facet,
    values: JSON.parse(key) as string[],
    mode: 'set' as const,
  }));
}

/**
 * The two stacks.
 *
 * Capped, because this is a convenience and not a record — the vault is in git,
 * which is the actual answer to "what did this look like on Tuesday".
 */
export const DEPTH = 50;

export interface History {
  done: Step[];
  undone: Step[];
}

export const emptyHistory = (): History => ({ done: [], undone: [] });

/**
 * Record a step. A new write abandons the redo stack, as it does in every editor:
 * a "forward" that leads somewhere you did not come from is worse than no
 * forward at all.
 */
export function recorded(history: History, step: Step): History {
  const done = [...history.done, step];
  return { done: done.slice(-DEPTH), undone: [] };
}

/** What `u` should apply, and the stacks after it. `null` when there is nothing. */
export function undone(history: History): { step: Step; history: History } | null {
  const step = history.done[history.done.length - 1];
  if (!step) return null;
  return {
    step,
    history: { done: history.done.slice(0, -1), undone: [...history.undone, step] },
  };
}

/** What `U` should apply, and the stacks after it. */
export function redone(history: History): { step: Step; history: History } | null {
  const step = history.undone[history.undone.length - 1];
  if (!step) return null;
  return {
    step,
    history: { done: [...history.done, step], undone: history.undone.slice(0, -1) },
  };
}
