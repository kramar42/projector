import { PSEUDO } from '../index/query.ts';
import { isRef } from '../schema/vocabulary.ts';
import type { Facets, Issue } from '../schema/types.ts';
import type { ViewSpec } from './spec.ts';

/**
 * Validating a saved view.
 *
 * Beside `ViewSpec` rather than in `src/schema/`, because a view is not a schema
 * concern: this checks a spec against the facet vocabulary *and* against `PSEUDO`,
 * so putting it in `schema/` made the lowest layer import both `index/` and
 * `view/` — the floor reaching up two storeys. `src/schema/` is where a card's
 * shape is decided; a view is a query over cards, which is one level out.
 */

/**
 * Validate saved views against the loaded vocabulary.
 *
 * A card is checked against `facets.yaml`; a view was not checked against
 * anything. `pj next` filtered on `kind` — a facet P7 deleted — for two days,
 * and moving that query into `views/*.yaml` only relocates the failure unless
 * something reads it: a filter naming an axis the vocabulary lost matches
 * nothing, and matching nothing is not an error anywhere else in the stack.
 *
 * Every position that holds a facet name is checked, because a validator with
 * two blind spots has the same hole in two fewer places. `focus.via` is the one
 * that needs more than existence: it is *walked*, so a label facet parses
 * happily and then traverses nothing.
 *
 * Views arrive already loaded, with the file each came from. This module knows
 * how to judge a view, not where views live.
 */
export function validateViews(
  views: { spec: ViewSpec; file: string }[],
  facets: Facets,
): Issue[] {
  const issues: Issue[] = [];
  // A stored axis or a computed one: `blocked` is no less askable than `status`
  // for being derived (C4), and a view may name either.
  const known = (name: string) => !!facets[name] || !!PSEUDO[name];

  for (const { spec, file } of views) {
    const at = (field: string, message: string) =>
      issues.push({ severity: 'error', file, id: spec.name, field, message });

    const axis = (name: string, field: string) => {
      if (!known(name)) {
        at(field, `no facet or computed axis "${name}" — a view naming one matches nothing, silently`);
      }
    };

    for (const name of Object.keys(spec.query.filter ?? {})) axis(name, `filter.${name}`);
    for (const name of spec.query.groupBy ?? []) axis(name, 'groupBy');
    for (const name of spec.show) axis(name, 'show');

    for (const key of spec.query.sort ?? []) {
      const name = key.split(':')[0] ?? '';
      // `updated`, `created` and `title` are record fields rather than facets,
      // and the comparator sorts by them directly.
      if (name === 'updated' || name === 'created' || name === 'title') continue;
      axis(name, 'sort');
    }

    const via = spec.query.focus?.via;
    if (via !== undefined) {
      if (!isRef(facets[via])) {
        at(
          'focus.via',
          `focus walks "${via}", which is not a reference facet — the traversal would find nothing`,
        );
      }
    }
  }

  return issues;
}
