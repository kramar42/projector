/**
 * The trail behind `H` and `L`, as two stacks and nothing else.
 *
 * A sibling of `undo.ts`, in the same shape and for the same reason: the stack
 * arithmetic is pure, it is the part that gets subtly wrong, and it lived inside
 * a hook where nothing could reach it. Every rule below was already implemented
 * in `useCursor` and asserted by nothing — including the one that made `H` look
 * broken for a year, which is that a jump *from nowhere* records nothing.
 *
 * ## What a jump is
 *
 * This module does not decide. `useCursor` exposes `step` and `jump` and the
 * dispatcher picks, because the question is "could you see where you were
 * going", which is a fact about a surface rather than about a stack. The line it
 * draws is written on `Cursor` in `cursor.ts`: one step along an ordering you can
 * see is a step, and everything else — a click, a followed reference, the pin
 * ring, `gg` / `G` — is a jump.
 *
 * ## Why it is a jumplist and not a history
 *
 * Vim's answer, kept. If every step were a stop, walking a column of forty would
 * bury the one place you actually want to get back to — and a cap small enough
 * to make "record everything" affordable is a cap that one screenful of `j`
 * empties, which is precisely when you have been reading around the note you
 * want back.
 */

/**
 * Fifty, matching `undo.ts` — and it costs fifty strings, because steps are
 * excluded. A design that recorded every step would need this small enough to
 * hurt.
 */
export const DEPTH = 50;

export interface Trail {
  behind: string[];
  ahead: string[];
}

export const emptyTrail = (): Trail => ({ behind: [], ahead: [] });

/**
 * Record leaving `from` for `to`.
 *
 * Two refusals, and both are load-bearing:
 *
 * `from === to` records nothing, so clicking the card you are already on does
 * not put a note on the trail that walking back from would not move you.
 *
 * `from === null` records nothing either, because there is nowhere to come back
 * to. This is the case that made a shared link feel broken: a cold `?note=` load
 * left the cursor unset, so the first reference you followed pushed nothing and
 * `H` did nothing. The fix is upstream — the link seeds the cursor — but the
 * rule belongs here, because a first jump in a fresh session is legitimately a
 * jump from nowhere.
 */
export function jumped(trail: Trail, from: string | null, to: string): Trail {
  if (from === to) return trail;
  const behind = from === null ? trail.behind : [...trail.behind, from];
  // A new jump abandons the forward stack, exactly as a browser's does — the
  // alternative is a "forward" that leads somewhere you never went from here.
  return { behind: behind.slice(-DEPTH), ahead: [] };
}

/**
 * Where `H` lands, and the stacks after it. `null` when there is nothing behind.
 *
 * `from` is where we are now, and it goes onto the opposite stack so `L` returns
 * — passed in rather than read from the trail because the cursor is the authority
 * on where it is, and a trail that also tracked the present would be a second
 * copy of it to keep in step.
 */
export function back(trail: Trail, from: string | null): { to: string; trail: Trail } | null {
  return walked(trail.behind, trail.ahead, from, (behind, ahead) => ({ behind, ahead }));
}

/** Where `L` lands, and the stacks after it. `null` when there is nothing ahead. */
export function forward(trail: Trail, from: string | null): { to: string; trail: Trail } | null {
  return walked(trail.ahead, trail.behind, from, (ahead, behind) => ({ behind, ahead }));
}

/**
 * One direction, written once.
 *
 * `H` and `L` are the same move with the stacks swapped, and the pair spelled out
 * twice is the pair that comes to disagree about the empty case.
 */
function walked(
  from: string[],
  onto: string[],
  at: string | null,
  build: (from: string[], onto: string[]) => Trail,
): { to: string; trail: Trail } | null {
  const to = from[from.length - 1];
  if (to === undefined) return null;
  return {
    to,
    // Where we stood joins the other stack, so the move is reversible. Nothing
    // joins it when we stood nowhere, for `jumped`'s reason.
    trail: build(from.slice(0, -1), at === null ? onto : [...onto, at]),
  };
}
