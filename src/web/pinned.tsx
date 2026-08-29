import { createContext, useContext, useMemo } from 'react';

/**
 * Which notes are pinned, for the surfaces that only need to *say* so.
 *
 * A context rather than a prop, for `TouchedProvider`'s reason: four shapes draw
 * a record mark — a board tile, a calendar cell, a canvas node and a table row —
 * and threading one set through four view components and `CardBody` would be
 * five signatures widened to carry a fact none of them acts on.
 *
 * It carries **membership and nothing else**. The pins themselves live in the
 * URL (`?pins=`) and every write to them goes through `App`, so this cannot be
 * the place a pin is made or lost — a reader that could also write would be a
 * second route to a piece of URL state, which is the thing `query.ts` is careful
 * to keep single.
 */
const PinnedContext = createContext<(id: string) => boolean>(() => false);

export function PinnedProvider({ pins, children }: { pins: string[]; children: React.ReactNode }) {
  // On the joined string rather than the array, so the identity survives a
  // render that rebuilt an equal list — which every URL read does.
  const key = pins.join(',');
  const has = useMemo(() => {
    const set = new Set(key ? key.split(',') : []);
    return (id: string) => set.has(id);
  }, [key]);
  return <PinnedContext.Provider value={has}>{children}</PinnedContext.Provider>;
}

/** Is this note pinned? What a mark asks to know which colour it is. */
export function useIsPinned(): (id: string) => boolean {
  return useContext(PinnedContext);
}
