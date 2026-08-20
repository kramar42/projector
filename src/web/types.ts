export interface CardDTO {
  id: string;
  kind: 'card' | 'node';
  title: string;
  isProject: boolean;
  projectKey: string | null;
  facets: Record<string, string[]>;
  links: { kind: string; ref: string; label: string; raw: string }[];
  progress: { done: number; total: number } | null;
  excerpt: string;
  body: string;
  updated: string | null;
  childCount: number;
  blockedBy: { id: string; title: string; done: boolean }[];
  unblocks: string[];
}

export interface FacetDef {
  label: string;
  values: string[];
  open: boolean;
  scope?: { under: string };
  /** Vocabulary sourced from the data rather than a static list. */
  valuesFrom?: 'project-records';
}

export interface Meta {
  vault: string;
  vaultName: string;
  facets: Record<string, FacetDef>;
  counts: Record<string, number>;
  enrichment: Record<string, number>;
  views: { kind: 'board' | 'canvas'; name: string; title: string }[];
}

export interface BoardResponse {
  view: {
    name: string;
    title: string;
    groupBy: string;
    cardFacets?: string[];
    filter?: Record<string, unknown>;
    uncategorised?: string;
  };
  groups: { value: string; cards: CardDTO[] }[];
  total: number;
  placements: number;
}

export interface CanvasResponse {
  view: { name: string; title: string; layout: string; defaultSize?: string; edges?: { show?: string[] } };
  nodes: CardDTO[];
  edges: { src: string; dst: string; type: string }[];
  stored: Record<string, { x?: number; y?: number; w?: number; h?: number; size?: string }>;
}

export interface CardDetail {
  card: CardDTO;
  file: string;
  /** File mtime at read time; sent back on a write so a concurrent edit 409s. */
  mtime: number;
  parents: { id: string; title: string }[];
  children: { id: string; title: string; kind: string }[];
  project: {
    key: string;
    repos: { path: string; base?: string }[];
    jira?: string;
    branch?: string;
    instructions: string[];
    chain: string[];
  } | null;
}

/** Display size, shared by both views. See §5.3 of the plan. */
export type Size = 'chip' | 'card' | 'expanded';

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
