export interface ProjectRepo {
  /** Absolute, `~`-prefixed, or relative to the data directory. */
  path: string;
  base?: string;
}

/**
 * Project configuration, carried by any record. A record's project key is its
 * `id` — there is deliberately no separate `key`, because a second name for the
 * same thing is a second thing to keep in step, and the `project` facet stores
 * record ids exactly like every other reference in the model.
 */
export interface ProjectBlock {
  repos?: ProjectRepo[];
  jira?: string;
  branch?: string;
  /**
   * How work on this project is done, inherited by its members.
   *
   * Configuration, so it lives with the rest of it. It used to be a `##
   * Instructions` heading in the record's body, matched by regex — the one place
   * prose was load-bearing, where renaming a heading silently stopped
   * inheritance with nothing to check against.
   */
  instructions?: string;
}

/** A parsed link reference. `raw` is preserved verbatim so writes round-trip. */
export interface Link {
  kind: string;
  ref: string;
  raw: string;
}

/**
 * One record file. Facet values are always arrays, uniformly.
 *
 * There is no `kind` and no `edges`. A record is not a class of thing: whether it
 * is work is whether it carries a lifecycle, and whether it contains anything is
 * whether anything references it — both readable from the record itself, so
 * neither is stored (C11). Every relation is a facet declared `type: ref`, which
 * is why `parent` filters and groups exactly as `priority` does.
 */
export interface Rec {
  id: string;
  title: string;
  facets: Record<string, string[]>;
  links: Link[];
  project?: ProjectBlock;
  source_fingerprint?: string;
  created?: string;
  updated?: string;
  /** Everything below the frontmatter, byte-preserved. */
  body: string;
  file: string;
}

/** Project config after merging every `project:` block on the membership chain. */
export interface ResolvedProject {
  /** The id of the nearest project record. */
  key: string;
  repos: ProjectRepo[];
  jira?: string;
  branch?: string;
  /** Root-first, so the most specific advice reads last. */
  instructions: string[];
  /** Project record ids from root to nearest, for briefing provenance. */
  chain: string[];
}

/**
 * What a facet's values *are*.
 *
 * Storage is uniform — every value is a string in the file and a `string[]` in
 * memory — and the type governs interpretation. That is what keeps this cheap:
 * the engine reads a facet in exactly two places, `valuesOf` and `rankOf`.
 *
 * - `label`  a member of a declared vocabulary. Sorts in declared order.
 * - `ref`    a record id in this vault, so the facet is also traversable.
 * - `date`   `YYYY-MM-DD`. Sorts chronologically, filters by bucket or by range.
 * - `number` sorts numerically rather than as text.
 */
export type FacetType = 'label' | 'ref' | 'date' | 'number';

export interface FacetDef {
  label: string;
  type: FacetType;
  values: string[];
  open: boolean;
  /**
   * At most one value. Storage stays uniform — every facet is a `string[]` and
   * the whole engine reads it that way — so this is a *vocabulary* constraint,
   * living exactly where `open` and `values` live.
   *
   * It exists because `status: [planning, done]` is not a card in two columns,
   * it is a card in no coherent state, and a model whose primary writer is an
   * agent making plain file writes (C3) has to be able to say so.
   */
  single: boolean;
  /**
   * Named ranges an ordered facet presents itself as, in order.
   *
   * A date has as many values as there are days, so a filter panel listing them
   * is useless and a board grouped by one gets a column per day. What an axis
   * wants from an ordered value is a bucket: **an ordered facet presents buckets
   * and compares raw.** Filtering and grouping see the names; sorting and range
   * filters see the value.
   *
   * The number is an inclusive upper bound — days from today for a `date`, the
   * value itself for a `number` — and anything past the last one falls in
   * `overflow`.
   */
  buckets?: { name: string; upTo: number; hue?: string }[];
  /** What a value past the last bucket is called. */
  overflow?: string;
  /**
   * The values that mean *no further work expected*, whatever the outcome.
   *
   * Outcome-neutral on purpose: it has to cover abandonment as well as success,
   * so `archived` belongs beside `done` while `on-hold` does not — held work is
   * still work, and still blocks whatever waits on it. `complete`, `resolved`
   * and `done` all imply success, which is why the key is not called any of them.
   *
   * A sibling list rather than an annotation on each value, because `values:` is
   * load-bearing as flat column order and must not grow entries.
   */
  closed?: string[];
  /**
   * A well-filed card in this vault carries this axis.
   *
   * Not enforced on write — a card missing one is a gap, not an error, which is
   * the distinction `validate` already draws between a warning and an error. It
   * is what the `triage` axis is computed from, and it has to be declared: it
   * cannot be inferred from `single` or from a closed vocabulary, because
   * `energy` and `owner` are both of those and nobody wants to be nagged for them.
   */
  expected?: boolean;
  /**
   * While this axis is unsatisfied, a record carrying it cannot proceed.
   *
   * What *unsatisfied* means follows from the type, which is how the rest of the
   * vocabulary already works — the type picks the editor's control and the
   * validator's check, and it picks this too:
   *
   * - a **reference** facet blocks while any record it names is not `closed`;
   * - any other facet blocks while it holds a value at all.
   *
   * That second rule is not a shortcut. A person does not *complete*: marking
   * `person-a` closed is nonsense, you clear the axis instead — so `waiting_on`
   * behaves as non-empty whether its values are labels or cards, and a vault is
   * free to make them cards for the traversal without changing what it means.
   *
   * Plural on purpose. Unlike `project`, whose config chain admits exactly one
   * relation, "reasons this cannot move" is naturally a list — which is what the
   * `blocked` axis was already saying with two values hardcoded into it.
   */
  blocking?: boolean;
  /**
   * Which hue family this axis draws in, from the app's palette.
   *
   * The palette is the app's and the choice is the vault's, which is the only
   * arrangement in which no facet is named in code: a chip's colour used to come
   * from a nine-entry map of facet names, and a canvas edge from a second map of
   * three, so a vault's own vocabulary was permanently grey and a renamed
   * relation lost its colour without saying so.
   *
   * A **bucket** may declare one too, and it wins for a chip drawn in that
   * bucket — which is how `overdue` gets to be loud on an axis that is otherwise
   * quiet. Its direction cannot be derived: `due` runs urgent-at-the-low-end and
   * an `effort` axis runs trivial-at-the-low-end, and nothing in the numbers says
   * which.
   *
   * Absent means no hue: the chip recedes, which is right for a hint like
   * `source` and is what any undeclared axis gets.
   */
  hue?: string;
}

export type Facets = Record<string, FacetDef>;

export type Severity = 'error' | 'warning';

export interface Issue {
  severity: Severity;
  file: string;
  id?: string;
  field?: string;
  message: string;
}
