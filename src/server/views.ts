import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { paths } from '../config.ts';
import { specFromFile, type ViewSpec } from '../view/spec.ts';

/**
 * Saved views: named queries in files (C9).
 *
 * P1 kept them in `views/board/` and `views/canvas/`, because a view was a place
 * and its shape was which folder it sat in. A shape is a control now, so the
 * directory is not allowed to mean anything — the tree is scanned whole, and
 * anything new is written flat to `views/<name>.yaml`. Files already in the
 * subfolders keep working exactly where they are.
 */

export interface ViewFile {
  name: string;
  file: string;
}

/** Every view file under `views/`, at any depth, in a stable order. */
export function viewFiles(root: string): ViewFile[] {
  const dir = paths(root).views;
  if (!existsSync(dir)) return [];
  const out: ViewFile[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.ya?ml$/.test(entry.name)) out.push({ name: basename(entry.name).replace(/\.ya?ml$/, ''), file: child });
    }
  };
  visit(dir);
  return out;
}

/**
 * The file a view name resolves to: wherever it already is, or a flat path for
 * one that does not exist yet. *Save current as…* therefore never buries a new
 * view in a folder named after a shape it might not keep.
 */
export function viewFileFor(root: string, name: string): string {
  const existing = viewFiles(root).find((v) => v.name === name);
  return existing?.file ?? join(paths(root).views, `${name}.yaml`);
}

/** A view file's parsed mapping beside the spec it produced, and where it came from. */
export interface LoadedView {
  name: string;
  file: string;
  /** Exactly what the file says, for the checker — `specFromFile` drops the rest. */
  raw: Record<string, unknown>;
  spec: ViewSpec;
}

/**
 * Every view, read once.
 *
 * `pj check` used to call `findView` per view, and `findView` was
 * `loadViews(root).find(...)` — so it re-read and re-parsed every file once per
 * file. One pass now, and it keeps the raw mapping, which is what the key check
 * needs: by the time a `ViewSpec` exists the unknown keys are gone.
 */
export function loadViewFiles(root: string): LoadedView[] {
  const out: LoadedView[] = [];
  for (const { name, file } of viewFiles(root)) {
    const raw = parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null;
    if (!raw) continue;
    out.push({ name, file, raw, spec: specFromFile(name, raw) });
  }
  return out;
}

export function loadViews(root: string): ViewSpec[] {
  return loadViewFiles(root).map((v) => v.spec);
}

export function findView(root: string, name: string): ViewSpec | undefined {
  return loadViews(root).find((v) => v.name === name);
}
