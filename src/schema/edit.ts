/**
 * One scripted facet edit, as `pj set` spells it: `--facet` replaces an axis,
 * `--add` and `--remove` adjust it, and an axis left with no values is gone —
 * except one the note carried, which comes back as `[]`.
 *
 * Here rather than inline in the CLI because the MCP server's `propose` has to
 * predict what a `pj set` would leave on the note, and a second copy of these
 * three rules is a prediction that can be wrong about the command it prints.
 */
export interface FacetOp {
  op: 'facet' | 'add' | 'remove';
  facet: string;
  values: string[];
}

/**
 * The facets a note would carry after `ops`, applied in order. Never mutates `current`.
 *
 * An axis the note carried and the edit emptied is kept as `[]` rather than
 * dropped, because to `patchNote` a whole map that omits an axis is a client that
 * never knew about it, not a removal — and for `intake` the difference is whether
 * the card is accepted out of `inbox/`, as the board's `+` does. The writer drops
 * empty axes, so for every other axis the file comes out the same either way.
 */
export function editFacets(current: Record<string, string[]>, ops: FacetOp[]): Record<string, string[]> {
  const facets: Record<string, string[]> = { ...current };
  const emptied = (facet: string) => {
    if (facet in current) facets[facet] = [];
    else delete facets[facet];
  };
  for (const { op, facet, values } of ops) {
    if (op === 'facet') {
      if (values.length) facets[facet] = values;
      else emptied(facet);
    } else if (op === 'add') {
      facets[facet] = [...new Set([...(facets[facet] ?? []), ...values])];
    } else {
      const kept = (facets[facet] ?? []).filter((x) => !values.includes(x));
      if (kept.length) facets[facet] = kept;
      else emptied(facet);
    }
  }
  return facets;
}

/**
 * Every `--facet` of one command as one map. An axis named twice holds the values
 * of both, in order and once each: `--facet project=a --facet project=b` is
 * `project: [a, b]`, never a silent `[b]`.
 */
export function parseFacetSpecs(specs: readonly string[]): Record<string, string[]> {
  const facets: Record<string, string[]> = {};
  for (const spec of specs) {
    const [f, values] = parseFacetSpec(spec);
    facets[f] = [...new Set([...(facets[f] ?? []), ...values])];
  }
  return facets;
}

/** `f=v,v` as the CLI writes it; a bare `f` or `f=` is the facet with no values. */
export function parseFacetSpec(spec: string): [string, string[]] {
  const i = spec.indexOf('=');
  const f = i === -1 ? spec : spec.slice(0, i);
  const v = i === -1 ? '' : spec.slice(i + 1);
  return [f, v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []];
}
