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
 * neither is stored (C11). Every relation is a facet declared `ref: true`, which
 * is why `parent` filters and groups exactly as `priority` does.
 */
export interface Rec {
  id: string;
  title: string;
  facets: Record<string, string[]>;
  links: Link[];
  project?: ProjectBlock;
  source_fingerprint?: string;
  /**
   * A deadline, `YYYY-MM-DD`.
   *
   * A field rather than a facet, and the distinction is the point: a facet is a
   * declared vocabulary of strings tested for membership, while a date needs
   * range comparison against today. `priority` says what you intend to do next;
   * `due` says what the world expects regardless of intent.
   */
  due?: string;
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

export interface FacetDef {
  label: string;
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
   * The values of this facet are record ids in this vault.
   *
   * A reference facet is a facet — it filters, groups, drags and bulk-edits
   * through the same code path as `priority` — and it is *also* traversable,
   * which is what edges used to be for. `open` is implied and `values` is
   * meaningless, since a vocabulary of record ids cannot be declared in advance.
   *
   * Cycles are always refused. Every reference facet that exists needs it:
   * `project` for config inheritance, and `parent` for tree layout once it moves
   * here too.
   */
  ref: boolean;
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
