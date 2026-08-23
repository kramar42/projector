import { createContext, useContext } from 'react';
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
 * The class a value draws in: the bucket's hue if it declares one, else the
 * axis's, else none.
 *
 * A bucket wins because that is the point of declaring one — `overdue` is loud on
 * an axis that is otherwise quiet — and `hue: none` on a bucket is how a vault
 * says "this one recedes" against a hued axis.
 */
export function useHue(facet: string, bucket?: string): string {
  const facets = useContext(VocabularyContext);
  const def = facets[facet];
  const fromBucket = bucket ? def?.buckets?.find((b) => b.name === bucket)?.hue : undefined;
  const hue = fromBucket ?? def?.hue;
  if (!hue || hue === 'none') return 'facet-muted';
  // A bucket that asked for its own hue is making a point, so it draws filled
  // rather than tinted. An axis-wide hue is identity, not emphasis.
  return `facet-hue-${hue}${fromBucket ? ' is-filled' : ''}`;
}
