import { createContext, useContext } from 'react';
import { chipClass } from './hue.ts';
import type { Facets } from './types.ts';

/**
 * The vault's vocabulary, for the components that draw a value rather than edit
 * one.
 *
 * A chip needs one fact about its axis — which hue it draws in — and it appears
 * on a card face, in a table cell and on a canvas node, none of which otherwise
 * hold the vocabulary. Threading `facets` through four components so that a
 * `<span>` can pick a colour is prop drilling in its purest form; the alternative
 * was the nine-entry map of facet names this replaces.
 *
 * Deliberately read-only and deliberately tiny. Anything that *writes* a facet
 * already receives its `FacetDef` explicitly, because what a control may change
 * should be legible from its signature.
 */
const VocabularyContext = createContext<Facets>({});

export function VocabularyProvider({ facets, children }: { facets: Facets; children: React.ReactNode }) {
  return <VocabularyContext.Provider value={facets}>{children}</VocabularyContext.Provider>;
}

/** The whole vocabulary, for a control that needs more than one axis's hue. */
export function useVocabulary(): Facets {
  return useContext(VocabularyContext);
}

/**
 * The class a value draws in, for a component that has a facet's *name* and not
 * its definition.
 *
 * The decision itself is `hue.ts`'s — four registers, one place, shared with the
 * canvas edge — so this is a lookup and nothing more. It used to hold the rules,
 * which is how the edge and the chip came to disagree about what an undeclared
 * axis and a reference mean.
 */
export function useHue(facet: string, bucket?: string): string {
  return chipClass(useContext(VocabularyContext)[facet], bucket);
}
