/**
 * Subsequence matching — fzf's rule, and deliberately not fzf's ranking.
 *
 * A needle matches when its characters appear in the haystack **in order**, with
 * anything in between: `nst` finds *needs status*, `gp` finds *group by*. That is
 * the half of a fuzzy finder worth having, because it lets a reader type the
 * shape of a word rather than its prefix.
 *
 * **No score.** fzf ranks its results — earlier matches, word boundaries, shorter
 * gaps — and this does not, on the same grounds the classifier gives for having
 * no score on the intake queue: a ranked list is a claim about which answer is
 * better, and the app does not make claims it cannot compute (C8). Results stay
 * in whatever order their source declared, so the same query always draws the
 * same list in the same order, and a reader who learned where something sits
 * keeps that knowledge.
 *
 * The walk is greedy and left-to-right, which finds *a* match rather than the
 * prettiest one. That is what makes it deterministic, and the positions it
 * returns are usable for highlighting because they are always the earliest ones.
 */

/**
 * Where each character of `needle` landed in `haystack`, or null for no match.
 *
 * Case-insensitive both ways. An empty needle matches everything with no
 * positions, which is what a filter box does before anyone has typed.
 */
export function subsequence(needle: string, haystack: string): number[] | null {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!n) return [];

  const at: number[] = [];
  let from = 0;
  for (const ch of n) {
    // Whitespace in the needle is intent, not a character to find: someone typing
    // "new card" means both words, and the space between them is how they said so.
    if (ch === ' ') continue;
    const found = h.indexOf(ch, from);
    if (found === -1) return null;
    at.push(found);
    from = found + 1;
  }
  return at;
}

/** The predicate, for callers that do not draw the match. */
export const fuzzy = (needle: string, haystack: string): boolean =>
  subsequence(needle, haystack) !== null;

/**
 * The best of several fields, so a row is matched by anything it shows.
 *
 * Any single field has to match on its own — the characters may not be spread
 * across a title and an id, which would match pairs no reader would call related.
 */
export const fuzzyAny = (needle: string, ...fields: (string | undefined)[]): boolean =>
  fields.some((f) => f !== undefined && fuzzy(needle, f));
