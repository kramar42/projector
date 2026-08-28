import { NONE, blockingFacets } from '../schema/vocabulary.ts';
import type { Facets } from '../schema/types.ts';
import type { ViewSpec } from './spec.ts';

/**
 * Why there is nothing on screen.
 *
 * An empty result has more than one cause and they had one rendering. "No notes
 * match" is true of a filter that is too tight, of a search that found nothing,
 * and of an axis **no note in the vault carries** — three different problems
 * whose next moves are, in order: widen the filter, try another word, and go and
 * set the axis on something.
 *
 * The wording is present tense throughout, which is a correction rather than a
 * style: `axisPopulation` counts what notes carry *now*, and the first draft said
 * "has ever been on", claiming a history the count cannot see. An axis emptied by
 * being drained reads identically to one never used, and on the intake queue that
 * is precisely what happens. The third one is the one that had no way
 * of being said, and the one that makes a view read as broken rather than empty:
 * a board grouped by an unused axis draws its declared columns and every one of
 * them is blank, which looks exactly like a query that excluded everything.
 *
 * Here rather than in a view because all three shapes ask it and the answer must
 * not depend on which one asked, and because a sentence chosen in a component is
 * a sentence no test can reach.
 *
 * **What this deliberately does not do is guess.** Every branch below is a fact
 * the payload already carries — a count, a declaration, a filter key. There is no
 * ranking and no heuristic, so two readers with the same screen get the same
 * sentence (C8).
 */

/**
 * The two payloads, described structurally rather than imported.
 *
 * `Meta` lives under `src/server/` and `src/view/` does not import from there —
 * the CLI builds these answers too. Structural types cost nothing here and keep
 * the direction of the dependency the way the rest of this directory has it.
 */
export interface EmptyVocabulary {
  facets: Facets;
  /**
   * Per stored axis, how many notes in the **vault** carry a value on it. Absent
   * means none ever has. Deliberately vault-wide rather than the universe:
   * "nobody has ever set this" is a fact about the vault, and a reader asking why
   * a column is blank is not asking about their own search box.
   */
  axisPopulation: Record<string, number>;
  /** `counts.notes` is every note in the vault. */
  counts: Record<string, number>;
}

export interface EmptyResult {
  spec: ViewSpec;
  /** What the query returned, and what it had to choose from before filtering. */
  total: number;
  universe: number;
}

interface EmptyContext {
  facets: Facets;
  population: Record<string, number>;
  spec: ViewSpec;
  total: number;
  universe: number;
  vaultNotes: number;
}

const contextOf = (meta: EmptyVocabulary, data: EmptyResult): EmptyContext => ({
  facets: meta.facets,
  population: meta.axisPopulation,
  spec: data.spec,
  total: data.total,
  universe: data.universe,
  vaultNotes: meta.counts.notes ?? 0,
});

export interface EmptyReason {
  text: string;
  /** The axis at fault, when there is one — so a caller can point at its row. */
  axis?: string;
}

/**
 * The axis a filter key is really about.
 *
 * `blocked` is computed, and every value it takes other than `clear` is the
 * *name of a blocking facet* — that is not a coincidence to be pattern-matched
 * but how the axis is defined (`values: [...blockingFacets(facets), 'clear']`).
 * So a `blocked: [waiting_on]` result that came back empty is not a fact about
 * the computed axis, which every note has a value on; it is a fact about
 * `waiting_on`, which nothing carries. Following that one hop is the whole of
 * what lets the aging view say "nobody is waiting on anyone" instead of drawing
 * a blank table and teaching that the axis is decorative.
 *
 * Only this hop exists, because only this computed axis is defined in terms of
 * other axes. The other three compute over a note's own fields.
 */
function sourceAxis(key: string, values: string[], facets: Facets): string | null {
  if (key !== 'blocked') return facets[key] ? key : null;
  const blocking = new Set(blockingFacets(facets));
  const named = values.filter((v) => blocking.has(v));
  // One and only one: `blocked: [waiting_on, blocked_by]` asks a question with
  // two possible answers, and naming one of them would be a guess.
  return named.length === 1 ? named[0]! : null;
}

/** An axis the vocabulary declares and no note in the vault has ever carried. */
function unused(axis: string, ctx: EmptyContext): boolean {
  return Boolean(ctx.facets[axis]) && !(ctx.population[axis] ?? 0);
}

const nameOf = (axis: string, facets: Facets) => facets[axis]?.label ?? axis;

/**
 * The one sentence to draw when a result is empty, or null when it is not.
 *
 * Ordered by how specific the answer is, not by how likely: a reader who can be
 * told the exact axis should never instead be told that their filter is tight.
 */
export function emptyReason(meta: EmptyVocabulary, data: EmptyResult): EmptyReason | null {
  const ctx = contextOf(meta, data);
  if (ctx.total > 0) return null;

  /*
   * A view that says what its own emptiness means outranks every deduction here.
   *
   * Everything below explains an empty result as a *problem* — the filter, the
   * search, an unused axis — and on a queue or a rule board it is the goal. The
   * intake board is the sharp case: drain it and the last thing the loop ever
   * says to you is that nothing matched, at the one moment something did.
   *
   * It also outranks the unused-axis branch on purpose, and that is not a
   * preference. `intake` is carried only by unjudged cards, so judging the last
   * one leaves the axis with no rows and the deduction below would say the axis
   * is unused — which is false in the way that matters: it was in use a moment
   * ago and you are the reason it is not.
   */
  if (ctx.spec.whenEmpty) return { text: ctx.spec.whenEmpty };

  if (!ctx.vaultNotes) {
    return { text: 'This vault has no notes yet.' };
  }

  // The specific answer: the query names an axis nothing has ever carried.
  for (const [key, values] of Object.entries(ctx.spec.query.filter ?? {})) {
    if (!values.length) continue;
    // `(none)` asks for the *absence* of a value, which an unused axis satisfies
    // for every note in the vault — so an empty result there is never this.
    if (values.every((v) => v === NONE)) continue;
    const axis = sourceAxis(key, values, ctx.facets);
    if (axis && unused(axis, ctx)) {
      return {
        axis,
        text: `No note carries a value on ${nameOf(axis, ctx.facets)} — the axis is declared and unused.`,
      };
    }
  }

  // The general ones. `universe` is what focus and the search left, so the gap
  // between it and `total` is exactly what the facet filter is hiding.
  if (ctx.universe > 0) return { text: 'No note matches this filter.' };
  if (ctx.spec.query.q) return { text: `No note matches “${ctx.spec.query.q}”.` };
  if (ctx.spec.query.focus) return { text: 'Nothing is reachable from here.' };
  return { text: 'No notes match.' };
}

/**
 * The board's other empty, which is not an empty result at all.
 *
 * Group a board by an axis nothing carries and the query returns every note —
 * all of them in `(none)`, with each declared column drawn and blank. `total` is
 * healthy, so `emptyReason` correctly says nothing, and the screen still reads as
 * a failure. The columns stay: they are the only drag target that can give the
 * axis its first value, and removing them would mean finding a control before
 * being able to use the axis at all. What the board gains is a line saying so.
 *
 * **The line states the fact and not the gesture.** `.board-nudge` already says
 * "drag between columns to set …" underneath, and a banner adding "drag a card in
 * to be the first" put two instructions about one drag on one board. The division
 * that leaves is the one the board already had: the nudge says how to operate it,
 * this says what is true of it.
 */
export function unusedGrouping(meta: EmptyVocabulary, data: EmptyResult): EmptyReason | null {
  const ctx = contextOf(meta, data);
  const axis = ctx.spec.query.groupBy?.[0];
  if (!axis || !unused(axis, ctx)) return null;
  return {
    axis,
    text: `No note carries a value on ${nameOf(axis, ctx.facets)}, so every column here is empty.`,
  };
}
