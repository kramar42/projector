import { fallbackHref, fallbackLabel } from '../schema/links.ts';
import { jiraConfig } from '../sources/jira.ts';
import type { Rec } from '../schema/types.ts';
import { isProject } from '../index/project.ts';
import { bucketOf } from '../schema/facets.ts';
import type { Facets } from '../schema/types.ts';

/** What the web app receives for one record. Everything here is derived, never guessed (C8). */
export interface CardDTO {
  id: string;
  title: string;
  isProject: boolean;
  facets: Record<string, string[]>;
  /**
   * `href` is where the link opens, derived from the ref alone — a fetcher adds
   * richness, never the ability to click. `null` for the two kinds with nowhere
   * on the web to go: a Claude session and a local doc.
   */
  links: { kind: string; ref: string; label: string; href: string | null; raw: string }[];
  /** Checklist progress counted from the body's markdown task lists. */
  progress: { done: number; total: number } | null;
  /** First prose paragraph, for the card face. */
  excerpt: string;
  /** Rendered lazily by the client; the raw body travels as-is. */
  body: string;
  /**
   * The bucket each ordered facet's values fall in, keyed by facet.
   *
   * Computed here so a face never re-derives it (C8) — and generically, so the
   * chip a `due` facet draws says "overdue" without anything in the client
   * knowing that facet by name.
   */
  buckets: Record<string, string[]>;
  updated: string | null;
  /**
   * How many records name this one, across every reference facet.
   *
   * The number the record mark is read from. It counted the `parent` facet alone
   * and was called `childCount`, which is why the mark and the `type`
   * pseudo-facet — which has always meant "named by *any* reference facet" —
   * could disagree about the same record.
   */
  refCount: number;
  /**
   * The records this one is waiting on, each saying which relation it came along
   * — a vault may declare several, and a single list has to distinguish them.
   */
  blockedBy: { id: string; title: string; via: string; done: boolean; isProject: boolean; refCount: number }[];
  unblocks: string[];
}

/** Bucketed values for every facet that declares buckets. */
function bucketsOf(rec: Rec, facets: Facets, today: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, def] of Object.entries(facets)) {
    if (!def.buckets?.length) continue;
    const raw = rec.facets[name];
    if (raw?.length) out[name] = [...new Set(raw.map((v) => bucketOf(def, v, today)))];
  }
  return out;
}

const TASK = /^\s*[-*]\s+\[( |x|X)\]\s+/gm;

/** Count markdown task list items. Deterministic — the board's progress bar is a count, not a judgement. */
export function progressOf(body: string): { done: number; total: number } | null {
  const matches = [...body.matchAll(TASK)];
  if (!matches.length) return null;
  const done = matches.filter((m) => m[1]!.toLowerCase() === 'x').length;
  return { done, total: matches.length };
}

/** The first paragraph that is prose — not a heading, task, table row or html comment. */
export function excerptOf(body: string, max = 160): string {
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t) continue;
    if (/^(#{1,6}\s|[-*]\s+\[[ xX]\]|\||<!--|!\[)/.test(t)) continue;
    const flat = t
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // markdown link → its text
      .replace(/^\s*\[?https?:\/\/\S+\]?\s*$/gm, '')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[-*]\s+/, '')
      .trim();
    if (!flat) continue;
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  }
  return '';
}

export function toDTO(
  rec: Rec,
  extra: {
    refCount?: number;
    blockedBy?: { id: string; title: string; via: string; done: boolean; isProject: boolean; refCount: number }[];
    unblocks?: string[];
    facets?: Facets;
    /** Overridable so a test does not depend on the day it runs. */
    today?: string;
  } = {},
): CardDTO {
  return {
    id: rec.id,
    title: rec.title,
    isProject: isProject(rec),
    facets: rec.facets,
    links: rec.links.map((l) => ({
      ...l,
      label: fallbackLabel(l),
      href: fallbackHref(l, jiraConfig()?.url ?? null),
    })),
    progress: progressOf(rec.body),
    excerpt: excerptOf(rec.body),
    body: rec.body,
    buckets: bucketsOf(rec, extra.facets ?? {}, extra.today ?? new Date().toISOString().slice(0, 10)),
    updated: rec.updated ?? null,
    refCount: extra.refCount ?? 0,
    blockedBy: extra.blockedBy ?? [],
    unblocks: extra.unblocks ?? [],
  };
}

