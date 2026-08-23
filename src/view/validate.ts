import { PSEUDO } from '../index/query.ts';
import { isRef } from '../schema/vocabulary.ts';
import { KEY_ORDER } from '../schema/frontmatter.ts';
import { BUILTIN_FACETS, STRUCTURAL } from '../schema/facets.ts';
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
 * A built-in's *name* is not on this list, because a vault may legitimately
 * declare one — to label it, colour it, or ask for it in triage. What it may not
 * do is change its shape, which is the separate check below.
 */
export const RESERVED: readonly string[] = [...KEY_ORDER, 'body', ...Object.keys(PSEUDO)].filter(
  // `project` names both a frontmatter block and a built-in facet, so it reaches
  // this list through `KEY_ORDER` and has to be lifted back out: the structural
  // check below is the one that judges it, and it judges it more precisely.
  (name) => !(name in BUILTIN_FACETS),
);

/**
 * Check the vocabulary's own names, and what a declaration of a built-in sets.
 *
 * Separate from `validate`, which checks *records* against the vocabulary: this
 * asks whether the vocabulary is sayable at all. Errors rather than warnings,
 * because both failures are silent — the axis works everywhere except where it
 * matters.
 *
 * It takes the file's raw top-level mapping rather than a loaded `Facets`: a
 * loaded one carries the built-ins, so it could not tell a declaration apart
 * from an injection, and it has already dropped the structural keys that make
 * the second check possible.
 */
export function validateVocabulary(
  declared: Record<string, unknown>,
  file: string,
): Issue[] {
  const issues: Issue[] = [];
  for (const [name, def] of Object.entries(declared)) {
    if (RESERVED.includes(name)) {
      issues.push({
        severity: 'error',
        file,
        field: name,
        message: `"${name}" is a reserved name — rename this facet`,
      });
      continue;
    }
    const builtin = BUILTIN_FACETS[name];
    if (!builtin || !def || typeof def !== 'object') continue;
    const set = Object.keys(def as Record<string, unknown>).filter((k) => STRUCTURAL.includes(k));
    if (set.length) {
      issues.push({
        severity: 'error',
        file,
        field: name,
        message:
          `"${name}" is built in and its shape is fixed — remove ${set.join(', ')}. ` +
          `Everything else here (label, expected) is yours to set.`,
      });
    }
  }
  return issues;
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
