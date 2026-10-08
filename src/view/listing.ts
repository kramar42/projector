import { findView } from '../server/views.ts';
import { SPEC_PARAMS, parseSpec, specToParams, withSavedOnly, type ViewSpec } from './spec.ts';
import type { QueryPayload } from './payload.ts';

/**
 * `pj ls`, minus the flag parsing: which spec a request names, and how its answer prints.
 *
 * It lived inside the CLI, so it had one caller and one surface. The MCP server is a
 * second, and a second copy of "a saved view, overridden by these parameters" is
 * exactly how `pj ls --view actionable` and the same question asked from a chat
 * would come to disagree (C9). One module, two adapters: argv and tool arguments.
 */

/** The parameters a request adds on top of a saved view — `f.<facet>` plus `SPEC_PARAMS`. */
export type Overrides = Record<string, string>;

/**
 * The spec a request resolves to: the saved view, then each override on top.
 *
 * `view` is a name, never a guess — an unknown one is an error rather than an
 * empty answer, since "no view called that" and "nothing matches" must not print
 * alike.
 */
export function resolveListing(
  root: string,
  view: string | undefined,
  overrides: Overrides,
): { spec: ViewSpec; saved: ViewSpec | null } | { error: string } {
  const params: Record<string, string> = {};
  let saved: ViewSpec | null = null;
  if (view) {
    saved = findView(root, view) ?? null;
    if (!saved) return { error: `no view "${view}"` };
    Object.assign(params, specToParams(saved));
  }
  for (const [key, value] of Object.entries(overrides)) {
    // `view` names the base, so it is not also an override of it.
    if (key === 'view') continue;
    if (key.startsWith('f.') || (SPEC_PARAMS as readonly string[]).includes(key)) params[key] = value;
  }
  // The saved view's file-only halves — its composition and its curated order —
  // which the query round-trip does not carry. See `withSavedOnly`.
  const spec = withSavedOnly(parseSpec(params), saved);
  spec.name = view;
  return { spec, saved };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * The listing as text.
 *
 * `facets` names the axes printed after each title. The CLI passes none and so
 * prints exactly what it always has; the MCP server passes the view's own `show`,
 * because a reader that cannot open the board has no other way to see what the
 * view surfaces.
 */
export function renderListing(payload: QueryPayload, spec: ViewSpec, facets: string[] = []): string {
  const out: string[] = [];
  const title = (id: string) => payload.notes[id]?.title ?? '';
  const chips = (id: string) => {
    const note = payload.notes[id];
    if (!note || !facets.length) return '';
    const parts = facets
      .map((f) => [f, note.facets[f] ?? note.computed[f] ?? []] as const)
      .filter(([, v]) => v.length)
      .map(([f, v]) => `${f}=${v.join(',')}`);
    return parts.length ? `  [${parts.join(' ')}]` : '';
  };
  const mark = (id: string) => {
    const note = payload.notes[id];
    // A container is a note something points at, not a kind it declares.
    return note?.isProject ? 'P' : (note?.refCount ?? 0) > 0 ? '+' : ' ';
  };
  const line = (id: string) => `   ${mark(id)} ${pad(id, 32)} ${title(id)}${chips(id)}`;

  if (!payload.groups) {
    for (const id of payload.ids) out.push(`${pad(id, 34)} ${title(id)}${chips(id)}`);
    out.push(`\n${payload.total} note(s) of ${payload.universe}`);
    return out.join('\n');
  }

  const axes = spec.query.groupBy ?? [];
  // A composition has columns without an axis, so it says what it is instead of
  // naming the grouping it does not have.
  out.push(
    spec.lists?.length
      ? `# ${spec.lists.length} list(s)\n`
      : `# grouped by ${axes.join(' × ')}\n`,
  );
  for (const g of payload.groups) {
    out.push(`## ${g.lane ? `${g.lane} / ` : ''}${g.value} (${g.ids.length})`);
    for (const id of g.ids) out.push(line(id));
    out.push('');
  }
  const extra = payload.placements - payload.total;
  out.push(
    `${payload.total} note(s) of ${payload.universe} in ${payload.groups.length} group(s)` +
      (extra > 0 ? ` — ${extra} appear in more than one group` : ''),
  );
  return out.join('\n');
}
