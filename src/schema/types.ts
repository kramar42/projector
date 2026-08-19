export type Kind = 'card' | 'node';
export type EdgeType = 'parent' | 'blocks' | 'relates';

export const EDGE_TYPES: readonly EdgeType[] = ['parent', 'blocks', 'relates'];

export interface ProjectRepo {
  /** Absolute, `~`-prefixed, or relative to the data directory. */
  path: string;
  base?: string;
}

export interface ProjectBlock {
  key?: string;
  repos?: ProjectRepo[];
  /** Narrow instead of union when merging down the parent chain. */
  repos_replace?: boolean;
  jira?: string;
  branch?: string;
}

export interface Edge {
  type: EdgeType;
  to: string;
}

/** A parsed link reference. `raw` is preserved verbatim so writes round-trip. */
export interface Link {
  kind: string;
  ref: string;
  raw: string;
}

/** One card or node file. Facet values are always arrays, uniformly. */
export interface Rec {
  id: string;
  kind: Kind;
  title: string;
  facets: Record<string, string[]>;
  edges: Edge[];
  links: Link[];
  project?: ProjectBlock;
  source_fingerprint?: string;
  created?: string;
  updated?: string;
  /** Everything below the frontmatter, byte-preserved. */
  body: string;
  file: string;
}

/** Project config after merging every `project:` block on the parent chain. */
export interface ResolvedProject {
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
  /** Only valid on records at any depth beneath this record id. */
  scope?: { under: string };
  /** Computed by the indexer; rejected if present in a card file. */
  derived?: boolean;
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
