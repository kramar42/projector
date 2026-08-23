import { PSEUDO } from '../index/query.ts';
import { isRef } from '../schema/vocabulary.ts';
import { KEY_ORDER } from '../schema/frontmatter.ts';
import { BUILTIN_FACETS } from '../schema/facets.ts';
import type { Facets, Issue } from '../schema/types.ts';
import type { ViewSpec } from './spec.ts';

/**
 * Validating the two things a card's own schema cannot judge: the vocabulary's
 * choice of *names*, and a saved view.
 *
 * Beside `ViewSpec` rather than in `src/schema/`, because neither is a schema
 * concern: both check against the facet vocabulary *and* against `PSEUDO`, so
 * putting them in `schema/` made the lowest layer import both `index/` and
 * `view/` — the floor reaching up two storeys. `src/schema/` is where a card's
 * shape is decided; a view is a query over cards, which is one level out.
 */

/**
 * Names a facet may not take.
 *
 * Two of these are *correctness* collisions rather than confusion. A pseudo-facet
 * shares the facet namespace outright and wins it — `valuesOf` reaches for
 * `PSEUDO[facet]` first — so a facet named `type` or `blocked` would store
 * values, validate writes, draw a row in the panel, and then be ignored by every
 * query: writes succeeding while reads lie. And `title`, `updated` and `created`
 * are sortable record fields, so a facet wearing one of those names is either
 * unsortable or shadows the default sort.
 *
 * The rest of `KEY_ORDER` cannot collide — frontmatter namespaces facets under
 * `facets:`, and `--set` reaches them by dotted path — but they are reserved
 * anyway. A vocabulary is read far more often than it is written, and an axis
 * called `links` beside a card's links is a sentence you have to stop and parse.
 *
 * A built-in facet is reserved for the strongest reason of the three: its
 * definition is not read from the file, so a declaration would be inert — and
 * silently so, which is the failure this whole list exists to prevent.
 */
export const RESERVED: readonly string[] = [
  ...KEY_ORDER,
  'body',
  ...Object.keys(BUILTIN_FACETS),
  ...Object.keys(PSEUDO),
];

/**
 * Check the vocabulary's own names.
 *
 * Separate from `validate`, which checks *records* against the vocabulary: this
 * asks whether the vocabulary is sayable at all. An error rather than a warning,
 * because the failure it prevents is silent — the axis works everywhere except
 * where it matters.
 *
 * It takes the names the *file* declares rather than a loaded `Facets`, because
 * a loaded one carries the built-ins too and would report every vault for a
 * declaration nobody wrote.
 */
export function validateVocabulary(declared: readonly string[], file: string): Issue[] {
  return declared
    .filter((name) => RESERVED.includes(name))
    .map((name) => ({
      severity: 'error' as const,
      file,
      field: name,
      message: `"${name}" is a reserved name — rename this facet`,
    }));
}

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
