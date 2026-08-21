import { fallbackLabel } from '../schema/links.ts';
import type { Rec, ResolvedProject } from '../schema/types.ts';
import { isProject } from '../index/project.ts';
import { dueBucket, type DueBucket } from '../index/query.ts';

/** What the web app receives for one record. Everything here is derived, never guessed (C8). */
export interface CardDTO {
  id: string;
  title: string;
  isProject: boolean;
  facets: Record<string, string[]>;
  links: { kind: string; ref: string; label: string; raw: string }[];
  /** Checklist progress counted from the body's markdown task lists. */
  progress: { done: number; total: number } | null;
  /** First prose paragraph, for the card face. */
  excerpt: string;
  /** Rendered lazily by the client; the raw body travels as-is. */
  body: string;
  due: string | null;
  /** Which `due` bucket, computed server-side so the face never re-derives it (C8). */
  dueIn: DueBucket | null;
  updated: string | null;
  childCount: number;
  blockedBy: { id: string; title: string; done: boolean }[];
  unblocks: string[];
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
  records: Map<string, Rec>,
  extra: {
    childCount?: number;
    blockedBy?: { id: string; title: string; done: boolean }[];
    unblocks?: string[];
    /** Overridable so a test does not depend on the day it runs. */
    today?: string;
  } = {},
): CardDTO {
  return {
    id: rec.id,
    title: rec.title,
    isProject: isProject(rec),
    facets: rec.facets,
    links: rec.links.map((l) => ({ ...l, label: fallbackLabel(l) })),
    progress: progressOf(rec.body),
    excerpt: excerptOf(rec.body),
    body: rec.body,
    due: rec.due ?? null,
    dueIn: dueBucket(rec.due, extra.today ?? new Date().toISOString().slice(0, 10)),
    updated: rec.updated ?? null,
    childCount: extra.childCount ?? 0,
    blockedBy: extra.blockedBy ?? [],
    unblocks: extra.unblocks ?? [],
  };
}

export interface ProjectDTO extends ResolvedProject {}
