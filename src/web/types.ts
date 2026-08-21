export interface CardDTO {
  id: string;
  title: string;
  isProject: boolean;
  facets: Record<string, string[]>;
  links: { kind: string; ref: string; label: string; raw: string }[];
  progress: { done: number; total: number } | null;
  excerpt: string;
  body: string;
  due: string | null;
  /** Which bucket the deadline falls in, computed server-side (C8). */
  dueIn: 'overdue' | 'today' | 'week' | 'later' | null;
  updated: string | null;
  childCount: number;
  blockedBy: { id: string; title: string; done: boolean }[];
  unblocks: string[];
}

export interface FacetDef {
  label: string;
  values: string[];
  open: boolean;
  /** At most one value at a time — a vocabulary constraint, not a storage one. */
  single: boolean;
  /**
   * The values are record ids, so the facet is traversable as well as
   * filterable: it draws on a canvas, walks under `focus`, and refuses a cycle.
   */
  ref: boolean;
}

export interface Meta {
  vault: string;
  vaultName: string;
  facets: Record<string, FacetDef>;
  counts: Record<string, number>;
  enrichment: Record<string, number>;
  views: SavedView[];
}

export interface SavedView {
  name: string;
  title: string;
  shape: Shape;
}

export type Shape = 'board' | 'canvas' | 'table';

export interface Focus {
  id: string;
  /** A reference facet name, or an edge type while those still exist. */
  via: string;
  /** `out` follows a record's own references; `in` finds the records naming it. */
  dir: 'out' | 'in' | 'both';
  depth?: number;
}

/** The query half of a spec: what is in scope, and how it is grouped and ordered. */
export interface Query {
  filter?: Record<string, string[]>;
  q?: string;
  focus?: Focus;
  /** Primary axis, then the secondary one — board lanes, table sub-sections. */
  groupBy?: string[];
  sort?: string[];
  connect?: 'ancestors' | 'none';
  uncategorised?: 'end' | 'start' | 'hide';
}

/**
 * One view, whether it came from a saved file or from the URL. `nodes` and
 * `order` are hand-curated arrangement and only ever arrive from a saved view —
 * an ad-hoc query has no file to hold them (C9).
 */
export interface ViewSpec {
  name?: string;
  title?: string;
  shape: Shape;
  query: Query;
  /**
   * Which facets this view surfaces. A label draws as a chip and a column; a
   * reference draws as those *and* a line, and the first reference lays the
   * canvas out.
   */
  show: string[];
  nodes?: Record<string, { x?: number; y?: number }>;
  order?: Record<string, string[]>;
}

export interface ValueCount {
  value: string;
  count: number;
  selected: boolean;
}

export interface FacetCount {
  facet: string;
  label: string;
  /** Computed rather than stored. The panel does not distinguish them. */
  pseudo: boolean;
  values: ValueCount[];
}

/** `lane` is set only when a second grouping axis is in play. */
export interface Group {
  value: string;
  lane?: string;
  ids: string[];
}

/** Derived counts for a project record — what the projects table exists for. */
export interface Rollup {
  direct: number;
  total: number;
  blocked: number;
  untriaged: number;
  touched: string | null;
}

export interface QueryResponse {
  spec: ViewSpec;
  /** Keyed by id: a card in three columns is one card. */
  cards: Record<string, CardDTO>;
  ids: string[];
  /** Ancestors kept so a graph stays connected. Never matches. */
  context: string[];
  groups: Group[] | null;
  axis: string[];
  lanes: string[];
  counts: FacetCount[];
  total: number;
  /** What focus and search left, before the facet filter. */
  universe: number;
  placements: number;
  edges: { src: string; dst: string; type: string }[];
  rollups?: Record<string, Rollup>;
  views: SavedView[];
}

export interface CardDetail {
  card: CardDTO;
  file: string;
  /** File mtime at read time; sent back on a write so a concurrent edit 409s. */
  mtime: number;
  parents: { id: string; title: string }[];
  children: { id: string; title: string }[];
  project: {
    key: string;
    repos: { path: string; base?: string }[];
    jira?: string;
    branch?: string;
    instructions: string[];
    chain: string[];
  } | null;
}

// ---------------------------------------------------------------- enrichment

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

export interface Enrichment {
  label: string;
  title?: string;
  badges?: { label: string; tone: Tone }[];
  fields?: { k: string; v: string }[];
  url?: string;
  command?: string;
}

export interface Resolved {
  ref: string;
  kind: string;
  state: 'fresh' | 'stale' | 'missing' | 'error' | 'unsupported';
  data?: Enrichment;
  error?: string;
  needsSetup?: boolean;
  fetchedAt?: number;
  note?: string;
}
