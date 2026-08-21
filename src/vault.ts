import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { appRoot, looksLikeVault, paths, resolvePath } from './config.ts';

/**
 * Vaults — a directory of cards, opened the way Obsidian opens a folder.
 *
 * There is no built-in location and nothing named `data` anywhere in here: a
 * vault is wherever the user points at. The registry below exists so the browser
 * can refer to a vault it has already opened rather than naming an arbitrary
 * filesystem path on every request.
 */

/**
 * The registry lives next to the app. One fixed location: an install keeps its
 * own list of vaults, so nothing is written to your home directory and two
 * installs cannot fight over one file.
 *
 * It is the only thing the app writes outside a vault, and it holds nothing but
 * paths you have opened — delete it and you lose the list, nothing else.
 */
const REGISTRY = join(appRoot, 'vaults.json');

export interface VaultEntry {
  path: string;
  name: string;
  addedAt: number;
  lastOpenedAt?: number;
}

export interface VaultInfo extends VaultEntry {
  exists: boolean;
  /** Card count, or null when the vault is missing. */
  cards: number | null;
}

function readRegistry(): VaultEntry[] {
  if (!existsSync(REGISTRY)) return [];
  try {
    const j = JSON.parse(readFileSync(REGISTRY, 'utf8')) as { vaults?: VaultEntry[] };
    return (j.vaults ?? []).filter((v) => v && typeof v.path === 'string');
  } catch {
    return [];
  }
}

function writeRegistry(vaults: VaultEntry[]): void {
  const tmp = `${REGISTRY}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ vaults }, null, 2) + '\n', 'utf8');
  renameSync(tmp, REGISTRY);
}

/** Canonical form of a user-supplied path: `~` expanded, absolute, no trailing slash. */
export function normalise(p: string): string {
  return resolve(resolvePath(p.trim(), process.cwd())).replace(/\/+$/, '') || '/';
}

/** A directory is a vault when it holds the things a vault is made of. */
export function countCards(path: string): number {
  const dir = paths(path).cards;
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').length;
  } catch {
    return 0;
  }
}

export function listVaults(): VaultInfo[] {
  return readRegistry()
    .map((v) => ({
      ...v,
      exists: existsSync(v.path),
      cards: existsSync(v.path) ? countCards(v.path) : null,
    }))
    .sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt));
}

export function isRegistered(path: string): boolean {
  const want = normalise(path);
  return readRegistry().some((v) => v.path === want);
}

export function registerVault(path: string, name?: string): VaultEntry {
  const p = normalise(path);
  const vaults = readRegistry();
  const found = vaults.find((v) => v.path === p);
  if (found) {
    if (name) found.name = name;
    found.lastOpenedAt = Date.now();
    writeRegistry(vaults);
    return found;
  }
  const entry: VaultEntry = {
    path: p,
    name: name?.trim() || suggestName(p),
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  vaults.push(entry);
  writeRegistry(vaults);
  return entry;
}

export function touchVault(path: string): void {
  const p = normalise(path);
  const vaults = readRegistry();
  const found = vaults.find((v) => v.path === p);
  if (!found) return;
  found.lastOpenedAt = Date.now();
  writeRegistry(vaults);
}

/** Forget a vault. The directory itself is never touched. */
export function forgetVault(path: string): boolean {
  const p = normalise(path);
  const vaults = readRegistry();
  const kept = vaults.filter((v) => v.path !== p);
  if (kept.length === vaults.length) return false;
  writeRegistry(kept);
  return true;
}

/**
 * A readable default name. `…/work/cockpit/data` reads better as "cockpit" than
 * as "data", so a generic leaf borrows its parent's name.
 */
const GENERIC = new Set(['data', 'vault', 'cards', 'cockpit-data', '.']);

export function suggestName(path: string): string {
  const leaf = basename(path);
  if (!GENERIC.has(leaf.toLowerCase())) return leaf;
  const parent = basename(dirname(path));
  return parent ? `${parent}` : leaf;
}

/**
 * Create the skeleton of a new vault. Refuses to touch a non-empty directory.
 *
 * Views are part of the skeleton: a vault with no board would open onto nothing,
 * which is a dead end rather than a fresh start.
 */
export function initVault(
  path: string,
  seedFacets: string,
  seedReadme: string,
  seedViews: { path: string; body: string }[] = [],
): void {
  const p = paths(path);
  if (existsSync(path)) {
    const entries = readdirSync(path).filter((f) => !f.startsWith('.'));
    if (entries.length && !looksLikeVault(path)) {
      throw new Error(`${path} is not empty and does not look like a vault`);
    }
  }
  mkdirSync(p.cards, { recursive: true });
  mkdirSync(p.assets, { recursive: true });
  mkdirSync(p.views, { recursive: true });
  if (!existsSync(p.facets)) writeFileSync(p.facets, seedFacets, 'utf8');
  const readme = join(p.cards, 'README.md');
  if (!existsSync(readme)) writeFileSync(readme, seedReadme, 'utf8');
  for (const v of seedViews) {
    const target = join(p.views, v.path);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, v.body, 'utf8');
  }
  const ignore = join(path, '.gitignore');
  if (!existsSync(ignore)) {
    writeFileSync(
      ignore,
      '.index.db\n.index.db-*\n.enrich.db\n.enrich.db-*\n.intake.db\n.intake.db-*\n*.tmp-*\n.DS_Store\n',
      'utf8',
    );
  }
}

/**
 * Resolve a `doc:` reference.
 *
 * Absolute and `~` paths are taken as given; anything relative resolves against
 * the vault root. Note the consequence: a relative path is relative to the
 * *vault*, not to the document it is written in, so a doc living outside the
 * vault is reached with `../` — and those refs move with the vault rather than
 * following it.
 */
export function resolveDoc(ref: string, root: string): { path: string | null; tried: string[] } {
  const raw = ref.trim();
  if (!raw) return { path: null, tried: [] };
  const candidate =
    raw.startsWith('/') || raw.startsWith('~') ? resolvePath(raw, root) : resolve(root, raw);
  const ok = existsSync(candidate) && statSync(candidate).isFile();
  return { path: ok ? candidate : null, tried: [candidate] };
}

/** Immediate subdirectories, for the folder picker. */
export function browse(path: string): { path: string; entries: { name: string; isVault: boolean }[] } {
  const p = path.trim() ? normalise(path) : homedir();
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    throw new Error(`not a directory: ${p}`);
  }
  const entries = readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, isVault: looksLikeVault(join(p, e.name)) }))
    .sort((a, b) => Number(b.isVault) - Number(a.isVault) || a.name.localeCompare(b.name));
  return { path: p, entries };
}

export { REGISTRY, looksLikeVault };
