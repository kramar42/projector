export interface ProjectRepo {
  /** Absolute, `~`-prefixed, or relative to the data directory. */
  path: string;
  base?: string;
}

/**
 * Project configuration, carried by any note. A note's project key is its
 * `id` — there is deliberately no separate `key`, because a second name for the
 * same thing is a second thing to keep in step, and the `project` facet stores
 * note ids exactly like every other reference in the model.
 */
export interface ProjectBlock {
  repos?: ProjectRepo[];
  jira?: string;
  branch?: string;
  /**
   * How work on this project is done, inherited by its members.
   *
   * Configuration, so it lives with the rest of it. It used to be a `##
   * Instructions` heading in the note's body, matched by regex — the one place
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
 * One note file. Facet values are always arrays, uniformly.
 *
 * There is no `kind` and no `edges`. A note is not a class of thing: whether it
 * is work is whether it carries a lifecycle, and whether it contains anything is
 * whether anything references it — both readable from the note itself, so
 * neither is stored (C11). Every relation is a facet declared `type: ref`, which
 * is why `parent` filters and groups exactly as `priority` does.
 */
export interface Note {
  id: string;
  title: string;
  facets: Record<string, string[]>;
  links: Link[];
  project?: ProjectBlock;
  source_fingerprint?: string;
  /**
   * The fingerprints this note answers for besides its own origin.
   *
   * A note's fingerprint is what stops a capture sweep proposing it twice, and
   * merging destroys the file that held it — so the surviving note carries them,
   * or every note ever folded into another comes back on the next sweep as new.
   * Its own `source_fingerprint` is never repeated here.
   *
   * A merge is not the only way one arrives. When a swept message extends a note
   * that already exists rather than becoming a note of its own, the message has
   * no file to leave its fingerprint on — and `source_fingerprint` is the wrong
   * home, because the note did not come from it. It lands here, which is what
   * makes "extend" a third outcome a sweep can actually record: without it the
   * message is proposed again on every sweep, for ever.
   */
  absorbed_fingerprints?: string[];
  created?: string;
  updated?: string;
  /** Everything below the frontmatter, byte-preserved. */
  body: string;
  file: string;
}

/** Project config after merging every `project:` block on the membership chain. */
export interface ResolvedProject {
  /** The id of the nearest project note. */
  key: string;
  repos: ProjectRepo[];
  jira?: string;
  branch?: string;
  /** Root-first, so the most specific advice reads last. */
  instructions: string[];
  /** Project note ids from root to nearest, for briefing provenance. */
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
 * - `ref`    a note id in this vault, so the facet is also traversable.
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
   * While this axis is unsatisfied, a note carrying it cannot proceed.
   *
   * What *unsatisfied* means follows from the type, which is how the rest of the
   * vocabulary already works — the type picks the editor's control and the
   * validator's check, and it picks this too:
   *
   * - a **reference** facet blocks while any note it names is not `closed`;
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
   *
   * On a **reference** axis this is a *line* colour and not a chip colour: its
   * values draw as notes rather than as values, so the family reaches the
   * canvas edge and nothing else. `src/web/hue.ts` is where that is decided.
   */
  hue?: string;
  /**
   * The letter that addresses this axis from the keyboard.
   *
   * Declared here for the same reason `hue` is: **the app owns the keyboard and
   * the vault owns the choice**, which is the only arrangement in which no facet
   * is named in code (C4). A keymap that spelled `p` as `priority` in the client
   * would be exactly the nine-entry map of facet names that `hue` replaced — and
   * it would be wrong the moment you opened a second vault.
   *
   * One letter, a–z, and not one the keyboard already owns; `view/keys.ts` holds
   * the reserved set and `pj check` refuses a collision. Lower-case as declared,
   * because the shifted form of a letter is a different binding.
   *
   * It is an *address*, not a write shortcut, and that is what earns it a key in
   * the file rather than being a fifth thing `single` is read for. `p3` sets the
   * axis's third value, and `,g p` groups by it, `,o p` sorts by it, `,f p` shows
   * it. Five setters, so it is not the kind of declaration that drifts.
   *
   * Absent means the axis has no letter, which is the honest default: you declare
   * one the day you notice you keep reaching for the axis, and the rest stay
   * reachable through the rail and the palette. Most axes want none.
   */
  key?: string;
  /**
   * The app defined this axis, not the vault — `BUILTIN_FACETS` in
   * `schema/facets.ts`, which today means `project` alone.
   *
   * It exists so the client can say "the app's own axis" without naming a facet,
   * which is the rule the UI keeps everywhere else (C4). What it buys: the axis
   * the app itself owns draws in the app's own colour, where a vault's axes draw
   * in the families the vault claims. Being derivable from the *name* is not the
   * same as being derivable — the name is exactly what the client must not know.
   */
  builtin?: true;
  /**
   * What the *other end* of this relation is called, if it has a name worth
   * drawing.
   *
   * `parent` is answered by children; `blocked_by` by what this card blocks. Both
   * were a two-entry map keyed by facet name, in the server *and* in the panel,
   * so a vault renaming either lost the row and a vault's own relation could
   * never have one.
   *
   * The inverse of a relation is not vocabulary in the sense values are — it is
   * not something a card can carry — but it is a word this vault uses, and there
   * is nowhere else for it to live. Absent means no derived row, which stays the
   * right default: nothing computes an inverse for a relation that has not
   * named one.
   */
  inverse?: string;
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
