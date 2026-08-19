import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';

export interface BoardView {
  kind: 'board';
  name: string;
  title: string;
  filter?: Record<string, string[] | 'none'>;
  groupBy: string;
  swimlanes?: string | null;
  cardFacets?: string[];
  sort?: string[];
  showEmpty?: boolean;
  uncategorised?: 'end' | 'start' | 'hide';
}

export interface CanvasView {
  kind: 'canvas';
  name: string;
  title: string;
  include?: {
    filter?: Record<string, string[]>;
    explicit?: string[];
    under?: string;
    /** Ancestors of included records are added by default; set false to opt out. */
    ancestors?: boolean;
  };
  layout: 'manual' | 'tree-lr' | 'tree-tb';
  /** Size for records that don't state their own. Omit for full cards. */
  defaultSize?: 'chip' | 'card' | 'expanded';
  edges?: { show?: string[] };
  nodes?: Record<string, { x?: number; y?: number; w?: number; h?: number; size?: string }>;
}

export type View = BoardView | CanvasView;

function loadDir(dir: string, kind: 'board' | 'canvas'): View[] {
  if (!existsSync(dir)) return [];
  const out: View[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    const raw = parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown> | null;
    if (!raw) continue;
    const name = basename(f).replace(/\.ya?ml$/, '');
    out.push({ ...(raw as object), kind, name, title: String(raw.title ?? name) } as View);
  }
  return out;
}

export function loadViews(boardsDir: string, canvasesDir: string): View[] {
  return [...loadDir(boardsDir, 'board'), ...loadDir(canvasesDir, 'canvas')];
}
