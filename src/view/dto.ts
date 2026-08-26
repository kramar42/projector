import { fallbackHref, fallbackLabel } from '../schema/links.ts';
import type { Note } from '../schema/types.ts';
import { isProject } from '../index/project.ts';
import { bucketOf } from '../schema/facets.ts';
import type { Facets } from '../schema/types.ts';

/** What the web app receives for one note. Everything here is derived, never guessed (C8). */
export interface NoteDTO {
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
  /**
   * What each computed axis says about this note, keyed by axis.
   *
   * Beside `facets` rather than merged into it, and the separation is the point
   * (C8): `facets` is what the file stores and what the panel edits, so a
   * computed value in there would draw an editable row for something no write can
   * change, and `changed.ts` would flash a card whose axis moved because the
   * calendar did. Same shape, different question — a face asks both and shows
   * either, `axisValues` in the client is the one place that joins them.
   */
  computed: Record<string, string[]>;
  updated: string | null;
  /**
   * How many notes name this one, across every reference facet.
   *
   * The number the note mark is read from. It counted the `parent` facet alone
   * and was called `childCount`, which is why the mark and the `type`
   * computed axis — which has always meant "named by *any* reference facet" —
   * could disagree about the same note.
   */
  refCount: number;
  /**
   * The notes this one is waiting on, each saying which relation it came along
   * — a vault may declare several, and a single list has to distinguish them.
   */
  blockedBy: { id: string; title: string; via: string; done: boolean; isProject: boolean; refCount: number }[];
  unblocks: string[];
}

/** Bucketed values for every facet that declares buckets. */
function bucketsOf(rec: Note, facets: Facets, today: string): Record<string, string[]> {
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
  rec: Note,
  extra: {
    refCount?: number;
    blockedBy?: { id: string; title: string; via: string; done: boolean; isProject: boolean; refCount: number }[];
    unblocks?: string[];
    facets?: Facets;
    /** From `computedReader`, which builds the aggregate context once per payload. */
    computed?: Record<string, string[]>;
    /** Overridable so a test does not depend on the day it runs. */
    today?: string;
    /**
     * The Jira host a bare `jira:` ref links to, read from the vault whose
     * payload this is. Passed in rather than looked up, because a DTO is built
     * for one vault and the process may hold several open with different hosts.
     */
    jiraBase?: string | null;
  } = {},
): NoteDTO {
  return {
    id: rec.id,
    title: rec.title,
    isProject: isProject(rec),
    facets: rec.facets,
    links: rec.links.map((l) => ({
      ...l,
      label: fallbackLabel(l),
      href: fallbackHref(l, extra.jiraBase ?? null),
    })),
    progress: progressOf(rec.body),
    excerpt: excerptOf(rec.body),
    body: rec.body,
    buckets: bucketsOf(rec, extra.facets ?? {}, extra.today ?? new Date().toISOString().slice(0, 10)),
    computed: extra.computed ?? {},
    updated: rec.updated ?? null,
    refCount: extra.refCount ?? 0,
    blockedBy: extra.blockedBy ?? [],
    unblocks: extra.unblocks ?? [],
  };
}

