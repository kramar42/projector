import { COMPUTED } from '../index/query.ts';
import { HUES, isRef } from '../schema/vocabulary.ts';
import { KEY_ORDER } from '../schema/frontmatter.ts';
import { BUILTIN_FACETS, STRUCTURAL } from '../schema/facets.ts';
import type { Facets, Issue } from '../schema/types.ts';
import { RESERVED as RESERVED_KEYS, isKeyShaped, isReserved } from './keys.ts';
import { VIEW_KEYS, type ViewSpec } from './spec.ts';

/**
 * Validating the two things a note's own schema cannot judge: the vocabulary's
 * choice of *names*, and a saved view.
 *
 * Beside `ViewSpec` rather than in `src/schema/`, because neither is a schema
 * concern: both check against the facet vocabulary *and* against `COMPUTED`, so
 * putting them in `schema/` made the lowest layer import both `index/` and
 * `view/` — the floor reaching up two storeys. `src/schema/` is where a note's
 * shape is decided; a view is a query over notes, which is one level out.
 */

/**
 * Names a facet may not take.
 *
 * Two of these are *correctness* collisions rather than confusion. A computed axis
 * shares the facet namespace outright and wins it — `valuesOf` reaches for
 * `COMPUTED[facet]` first — so a facet named `type` or `blocked` would store
 * values, validate writes, draw a row in the panel, and then be ignored by every
 * query: writes succeeding while reads lie. And `title`, `updated` and `created`
 * are sortable note fields, so a facet wearing one of those names is either
 * unsortable or shadows the default sort.
 *
 * The rest of `KEY_ORDER` cannot collide — frontmatter namespaces facets under
 * `facets:`, and `--set` reaches them by dotted path — but they are reserved
 * anyway. A vocabulary is read far more often than it is written, and an axis
 * called `links` beside a note's links is a sentence you have to stop and parse.
 *
 * A built-in's *name* is not on this list, because a vault may legitimately
 * declare one — to label it, colour it, or ask for it in triage. What it may not
 * do is change its shape, which is the separate check below.
 */
export const RESERVED: readonly string[] = [...KEY_ORDER, 'body', ...Object.keys(COMPUTED)].filter(
  // `project` names both a frontmatter block and a built-in facet, so it reaches
  // this list through `KEY_ORDER` and has to be lifted back out: the structural
  // check below is the one that judges it, and it judges it more precisely.
  (name) => !(name in BUILTIN_FACETS),
);

/**
 * Check the vocabulary's own names, and what a declaration of a built-in sets.
 *
 * Separate from `validate`, which checks *notes* against the vocabulary: this
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
  /**
   * Which axis claimed each letter, so the second claimant can be named.
   *
   * Cross-facet, so it cannot live in `inert` with the rest of the key checks: a
   * declaration is only wrong here *relative to another one*, and `bind` resolves
   * a letter through a single map — so two claims mean one axis silently wins by
   * declaration order and the other is unreachable. Exactly the shape of failure
   * this function is for.
   */
  const claimed = new Map<string, string>();
  for (const [name, def] of Object.entries(declared)) {
    if (def && typeof def === 'object') issues.push(...inert(name, def as Record<string, unknown>, file));
    const key = (def as Record<string, unknown> | null)?.key;
    if (typeof key === 'string' && isKeyShaped(key.toLowerCase())) {
      const lower = key.toLowerCase();
      const first = claimed.get(lower);
      if (first) {
        issues.push({
          severity: 'error',
          file,
          field: name,
          message: `"${name}" and "${first}" both ask for key "${lower}" — one letter, one axis`,
        });
      } else claimed.set(lower, name);
    }
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
 * Keys that are set and cannot take effect.
 *
 * The same failure this whole module exists for, one level in: a reserved *name*
 * fails silently, and so does a *key* that does not apply. `inverse:` on a label
 * facet draws no row, a `hue:` outside the palette falls through to grey, and a
 * `closed:` value the vocabulary does not declare can never be held — each of
 * them looks exactly like a setting that works.
 *
 * Read off the raw mapping rather than a loaded definition, because loading is
 * where the key gets dropped: by then there is nothing left to report.
 */
function inert(name: string, def: Record<string, unknown>, file: string): Issue[] {
  const out: Issue[] = [];
  const at = (message: string) =>
    out.push({ severity: 'error', file, field: name, message });

  // The raw mapping is missing exactly one thing: a built-in's shape, which is
  // not read from the file and cannot be written there. So the type is the file's
  // if it wrote one and the built-in's otherwise — without this, `project:
  // {inverse: Owners}` was reported as an inverse on a non-reference facet, which
  // is the built-in's own `type: ref` being invisible to the checker rather than
  // anything wrong with the vault.
  const type = def.type ?? BUILTIN_FACETS[name]?.type;
  if (typeof def.inverse === 'string' && type !== 'ref') {
    at(`"${name}" declares an inverse but is not a reference facet — nothing points back along it`);
  }
  /**
   * A keyboard address that cannot be typed, or that the map already owns.
   *
   * Errors rather than warnings, on this check's own standing argument: both
   * failures are silent. A key of `too long` is simply never matched, and a key
   * of `j` is *shadowed* — `bind` reads the map before the vocabulary, on purpose,
   * so the vault's declaration would sit there working everywhere except where it
   * matters. Which is the definition of the thing this function exists to catch.
   */
  if (def.key !== undefined) {
    const key = String(def.key).toLowerCase();
    if (!isKeyShaped(key)) {
      at(`"${name}" asks for key "${def.key}" — a key is one letter, a to z`);
    } else if (isReserved(key)) {
      at(
        `"${name}" asks for key "${key}", which the keyboard already uses — ` +
          `${RESERVED_KEYS.join(' ')} are taken, in both cases`,
      );
    }
  }
  for (const hue of [def.hue, ...bucketHues(def)]) {
    if (typeof hue === 'string' && hue !== 'none' && !HUES.includes(hue)) {
      at(`"${name}" asks for hue "${hue}", which is not a family — have ${HUES.join(', ')}`);
    }
  }
  const values = Array.isArray(def.values) ? def.values.map(String) : null;
  if (Array.isArray(def.closed) && values?.length) {
    const missing = def.closed.map(String).filter((v) => !values.includes(v));
    if (missing.length) {
      at(`"${name}" calls ${missing.join(', ')} closed, but does not declare ${missing.length > 1 ? 'them' : 'it'} as a value`);
    }
  }
  return out;
}

function bucketHues(def: Record<string, unknown>): unknown[] {
  const raw = def.buckets;
  if (!raw || typeof raw !== 'object') return [];
  return Object.values(raw as Record<string, unknown>).map((b) =>
    b && typeof b === 'object' ? (b as Record<string, unknown>).hue : undefined,
  );
}

/**
 * Validate saved views against the loaded vocabulary.
 *
 * A note is checked against `facets.yaml`; a view was not checked against
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
 * Views arrive already loaded, with the file each came from and — for a caller
 * that has it — the raw mapping, which is the only thing that still knows about
 * a key the reader dropped. This module knows how to judge a view, not where
 * views live.
 */
export function validateViews(
  views: { spec: ViewSpec; file: string; raw?: Record<string, unknown> }[],
  facets: Facets,
): Issue[] {
  const issues: Issue[] = [];
  // A stored axis or a computed one: `blocked` is no less askable than `status`
  // for being derived (C4), and a view may name either.
  const known = (name: string) => !!facets[name] || !!COMPUTED[name];
  const byName = new Map(views.map(({ spec }) => [spec.name ?? '', spec]));

  for (const { spec, file, raw } of views) {
    const at = (field: string, message: string) =>
      issues.push({ severity: 'error', file, id: spec.name, field, message });

    // A key the reader does not know is a line that parsed and did nothing — the
    // same silent failure as an axis that matches nothing, one level out. `raw`
    // is optional only so a caller holding a spec alone can still check the
    // axes; `pj check` passes it.
    for (const key of Object.keys(raw ?? {})) {
      if (!VIEW_KEYS.includes(key)) {
        at(key, `no view key "${key}" — this line parses and does nothing`);
      }
    }

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
      // `updated`, `created` and `title` are note fields rather than facets,
      // and the comparator sorts by them directly.
      if (name === 'updated' || name === 'created' || name === 'title') continue;
      axis(name, 'sort');
    }

    // --- composition ---
    //
    // Every one of these is the same failure this module exists for: a line that
    // parses and then does nothing. `specFromFile` drops a value it does not
    // recognise, so without a check here `expect: none` or `unlisted: yes` is a
    // rule that silently never runs.
    if (raw && 'expect' in raw && raw.expect !== 'empty') {
      at('expect', `expect is "${String(raw.expect)}" — the only assertion is "empty"`);
    }
    if (raw && 'unlisted' in raw && raw.unlisted !== true) {
      at('unlisted', `unlisted is "${String(raw.unlisted)}" — it is true or it is absent`);
    }

    if (spec.shape === 'lists' && !spec.lists?.length) {
      at('lists', 'shape is "lists" but no lists are named — the view would draw no columns');
    }
    if (spec.lists?.length && spec.shape !== 'lists') {
      at('shape', `lists are named but the shape is "${spec.shape}" — only "lists" draws them`);
    }

    if (spec.lists?.length) {
      // A composition has no query of its own. One that carries a filter reads
      // as though it narrowed its columns, and it does not: each child runs its
      // own query whole.
      for (const key of ['filter', 'q', 'focus', 'groupBy', 'sort', 'show'] as const) {
        if (raw && key in raw) {
          at(key, `a lists view draws its children's answers, so "${key}" here does nothing`);
        }
      }

      const titles = new Map<string, string>();
      for (const child of spec.lists) {
        const target = byName.get(child);
        if (!target) {
          at('lists', `no view "${child}" — a column naming one draws nothing, silently`);
          continue;
        }
        // One level. Resolving deeper would need a cycle check and an order to
        // reason about, and nothing wants a column that is itself columns.
        if (target.lists?.length) {
          at('lists', `"${child}" is itself a lists view — a composition is one level deep`);
        }
        // A column is one flat list: composition takes the child's *ids* and
        // draws them, so an axis it groups by is read by nobody. The same silent
        // failure as a filter on the parent, at the other end of the reference.
        if (target.query.groupBy?.length) {
          at('lists', `"${child}" groups by ${target.query.groupBy.join(', ')}, which a column cannot draw`);
        }
        // The column's name is the child's title, so two children sharing one
        // would draw as a single column that swallows the other's notes.
        const title = target.title ?? child;
        const clash = titles.get(title);
        if (clash) at('lists', `"${child}" and "${clash}" are both titled "${title}" — one column would swallow the other`);
        else titles.set(title, child);
      }
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
