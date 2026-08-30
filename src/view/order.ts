/**
 * A column's cards in the order the saved view curates, then the rest.
 *
 * An id in `order` that no longer matches is skipped rather than held open, and a
 * card the order has never seen goes after the pinned ones — so a stored order
 * survives cards coming and going without needing to be rewritten.
 *
 * This belongs below the payload boundary: a board's query groups and a
 * calendar's client-side day placements are both columns, so both must apply
 * exactly the same arrangement rule.
 */
export function applyOrder(ids: string[], order: string[] | undefined): string[] {
  if (!order?.length) return ids;
  const have = new Set(ids);
  const pinned = order.filter((id) => have.has(id));
  const seen = new Set(pinned);
  return [...pinned, ...ids.filter((id) => !seen.has(id))];
}
