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
 *
 * `PROJECTOR_VAULTS` points it elsewhere, which is what makes `pj vaults`
 * testable: without it a test of `vaults add` would edit the list you actually
 * use. A function rather than a constant so a test can set the variable after
 * import, as with `PROJECTOR_CLAUDE_HOME` and `PROJECTOR_JIRA_URL`.
 */
const registryFile = () => process.env.PROJECTOR_VAULTS || join(appRoot, 'vaults.json');

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
  if (!existsSync(registryFile())) return [];
  try {
    const j = JSON.parse(readFileSync(registryFile(), 'utf8')) as { vaults?: VaultEntry[] };
    return (j.vaults ?? []).filter((v) => v && typeof v.path === 'string');
  } catch {
    return [];
  }
}

function writeRegistry(vaults: VaultEntry[]): void {
  const tmp = `${registryFile()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ vaults }, null, 2) + '\n', 'utf8');
  renameSync(tmp, registryFile());
}

/** Canonical form of a user-supplied path: `~` expanded, absolute, no trailing slash. */
export function normalise(p: string): string {
  return resolve(resolvePath(p.trim(), process.cwd())).replace(/\/+$/, '') || '/';
}

/**
 * A directory is a vault when it holds the things a vault is made of.
 *
 * `README.md` is excluded because a folder full of markdown attracts one — not
 * because the app puts one there. It no longer seeds a card-conventions README:
 * that text was a copy of the `projector` skill, which an agent already has, and
 * two places saying the same thing is one place to drift.
 */
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
 * The name prefilled when a vault is opened. Deliberately just the folder name.
 *
 * This used to keep a list of leaf names considered too generic to be a name —
 * `data`, `vault`, `cards` — and silently borrow the parent's name instead. It is
 * gone on purpose: the rule guessed for the user, the list of what counts as
 * generic was never right for anyone but its author, and its output was a *name*
 * the user could see and change anyway. A suggestion that is wrong in a visible
 * field costs a keystroke; a rule nobody can predict costs an explanation. Do not
 * reintroduce it.
 */
export function suggestName(path: string): string {
  return basename(path);
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
  seedViews: { path: string; body: string }[] = [],
): void {
  const p = paths(path);
  // Adopting a folder that is already a vault, or making one out of an empty
  // folder. Anything else is somebody's documents.
  const adopting = looksLikeVault(path);
  if (existsSync(path) && !adopting) {
    const entries = readdirSync(path).filter((f) => !f.startsWith('.'));
    if (entries.length) throw new Error(`${path} is not empty and does not look like a vault`);
  }
  mkdirSync(p.cards, { recursive: true });
  mkdirSync(p.assets, { recursive: true });
  mkdirSync(p.views, { recursive: true });

  // The starter vocabulary and views go into a *new* vault only.
  //
  // They used to go in whenever the file was missing, which was the same thing
  // while a vault could not do without them. It is not any more: an absent
  // `facets.yaml` is a vault that carries the built-ins and nothing else, and a
  // deleted `home.yaml` is a view somebody deleted. Re-running `--create` over
  // an existing vault would have put both back, silently, as a fresh start.
  if (adopting) return ensureIgnore(path);
  if (!existsSync(p.facets)) writeFileSync(p.facets, seedFacets, 'utf8');
  for (const v of seedViews) {
    const target = join(p.views, v.path);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, v.body, 'utf8');
  }
  ensureIgnore(path);
}

/** The databases and scratch files a vault should never commit. */
function ensureIgnore(path: string): void {
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

export { registryFile, looksLikeVault };
