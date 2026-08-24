import type { NoteDTO } from './types.ts';

/**
 * The two decisions behind "something changed and it was not you".
 *
 * Both are here rather than beside their callers because both are the whole of the
 * feature's correctness and neither needs a browser. The change stream, the
 * `EventSource`, the pseudo-element that flushes — none of that can be wrong in a
 * way a reader would notice if these two are right, and all of it is untestable
 * without a DOM this repo deliberately does not have.
 */

/**
 * How long a write of ours stays ours.
 *
 * There is no request to correlate a change event against: the route announces the
 * write immediately and the watcher announces the same bytes again once its 120ms
 * write-finish settles, so an id arrives twice and the second time is late. Two
 * seconds covers that with room to spare.
 *
 * The cost of being generous is the case worth being careful about — an agent
 * writing the same note within two seconds of you is read as yours and passes
 * unmarked. That is the honest trade, and it is the right way round: the failure is
 * a missed mark, where the opposite failure is announcing every one of your own
 * clicks back to you, which would make the signal noise within a minute of use.
 */
export const SELF_WRITE_TTL_MS = 2000;

/**
 * How long the flush lasts, and therefore how long a region stays touched.
 *
 * One number for both, because they are one thing: the class exists so the flush
 * can run, so keeping it after the animation ends is not a longer signal, it is a
 * released animation sitting on its base style. That was a real bug — the overlay
 * had no resting `opacity`, so on release it snapped back to fully lit and stayed
 * there until the class came off three seconds later. Reading as: flush, ease out,
 * flush again, vanish.
 *
 * `test/theme.test.ts` asserts the stylesheet's animation is this many milliseconds,
 * because CSS cannot read this file and the two silently disagreeing is exactly the
 * failure above.
 */
export const FLUSH_MS = 2600;

/**
 * Of these changed notes, which were changed by somebody else.
 *
 * Takes its state and its clock rather than reaching for either, because this is
 * the rule the whole feature rests on: get it wrong in the generous direction and
 * the app flashes at you while you work. `writtenAt` is mutated — an expired stamp
 * is dropped on the way past, which is the only pruning this needs since a stamp
 * can only be read after a change event and a change event is the only thing that
 * writes one.
 */
export function foreignOf(
  ids: readonly string[],
  writtenAt: Map<string, number>,
  now: number,
): string[] {
  return ids.filter((id) => {
    const at = writtenAt.get(id);
    if (at === undefined) return true;
    if (now - at <= SELF_WRITE_TTL_MS) return false;
    writtenAt.delete(id);
    return true;
  });
}

/**
 * Which parts of a note moved between two reads of it.
 *
 * Keys, not prose. An earlier version of this drew a line naming the fields that
 * had changed, and it was wrong twice: it cost a layout shift in a fixed header,
 * and it asked the reader to read a sentence about a value that was already on
 * screen in front of them. What the caller does with these is light the regions
 * they name, so the reader's eye lands on the new value and there is nothing to
 * read at all.
 *
 * Axes are named, values are not, and that is the same decision one level down: a
 * changed axis says *look at this row*, and which chip is lit is what the reader
 * should find rather than be told.
 *
 * `null` before means the first read of a note, which is not a change.
 */
export function whatMoved(before: NoteDTO | null, after: NoteDTO): string[] {
  if (!before) return [];
  const moved: string[] = [];
  if (before.title !== after.title) moved.push('title');

  // Both directions: an axis the other side does not have moved as surely as one
  // whose values differ, and an agent clearing a facet is the case that would
  // otherwise go unmarked.
  for (const axis of new Set([...Object.keys(before.facets), ...Object.keys(after.facets)])) {
    if (join(before.facets[axis]) !== join(after.facets[axis])) moved.push(axis);
  }

  if (before.body !== after.body) moved.push('body');
  if (join(before.links.map((l) => l.raw)) !== join(after.links.map((l) => l.raw))) {
    moved.push('links');
  }
  return moved;
}

/**
 * Compare a facet's values as a unit, order included.
 *
 * NUL because it cannot occur in a value a human or an agent typed, where a comma
 * or a space can: joining on either would read `['a b']` and `['a', 'b']` as the
 * same axis, so an agent splitting one value into two would go unmarked.
 */
function join(values: string[] | undefined): string {
  return (values ?? []).join('\u0000');
}
