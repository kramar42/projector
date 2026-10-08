/**
 * One scripted facet edit, as `pj set` spells it: `--facet` replaces an axis,
 * `--add` and `--remove` adjust it, and an axis left with no values is gone.
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

/** The facets a note would carry after `ops`, applied in order. Never mutates `current`. */
export function editFacets(current: Record<string, string[]>, ops: FacetOp[]): Record<string, string[]> {
  const facets: Record<string, string[]> = { ...current };
  for (const { op, facet, values } of ops) {
    if (op === 'facet') {
      if (values.length) facets[facet] = values;
      else delete facets[facet];
    } else if (op === 'add') {
      facets[facet] = [...new Set([...(facets[facet] ?? []), ...values])];
    } else {
      const kept = (facets[facet] ?? []).filter((x) => !values.includes(x));
      if (kept.length) facets[facet] = kept;
      else delete facets[facet];
    }
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
