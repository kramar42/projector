import { createContext, useContext, useMemo } from 'react';

/**
 * Which notes are pinned, and the one App-owned route that can release one.
 *
 * A context rather than a prop, for `TouchedProvider`'s reason: four shapes draw
 * a record mark — a board tile, a calendar cell, a canvas node and a table row —
 * and threading one set through four view components and `CardBody` would be
 * five signatures widened to carry a fact none of them acts on.
 *
 * The pins themselves still live in the URL (`?pins=`), and `App` still owns
 * every write. Passing its `onUnpin` down here lets the pin drawn on a card be a
 * truthful control without threading the URL setter through every view shape.
 */
interface PinnedValue {
  has(id: string): boolean;
  unpin(id: string): void;
}

const PinnedContext = createContext<PinnedValue>({ has: () => false, unpin: () => {} });

export function PinnedProvider({
  pins,
  onUnpin,
  children,
}: {
  pins: string[];
  onUnpin: (id: string) => void;
  children: React.ReactNode;
}) {
  // On the joined string rather than the array, so the identity survives a
  // render that rebuilt an equal list — which every URL read does.
  const key = pins.join(',');
  const value = useMemo<PinnedValue>(() => {
    const set = new Set(key ? key.split(',') : []);
    return { has: (id) => set.has(id), unpin: onUnpin };
  }, [key, onUnpin]);
  return <PinnedContext.Provider value={value}>{children}</PinnedContext.Provider>;
}

/** Is this note pinned? */
export function useIsPinned(): (id: string) => boolean {
  return useContext(PinnedContext).has;
}

/** Release a pin through the provider's App-owned URL writer. */
export function useUnpin(): (id: string) => void {
  return useContext(PinnedContext).unpin;
}
