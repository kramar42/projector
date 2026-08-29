import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { appRoot, isConfigured, looksLikeVault, paths, resolvePath } from './config.ts';
import { listNoteFiles } from './schema/note.ts';

/**
 * Vaults — a directory of notes, opened the way Obsidian opens a folder.
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
  /** Note count, or null when the vault is missing. */
  notes: number | null;
}

/**
 * What an install knows about before anyone has configured it: `vaults/tutorial`,
 * which ships in the repository.
 *
 * **The registry is never committed, and this is why it does not have to be.** A
 * checked-in `vaults.json` could not work anyway — entries hold absolute paths,
 * so the one file would name the machine it was committed from. Deriving the
 * tutorial's path from `appRoot` at read time gets it right in every clone, and
 * leaves the real registry untracked, so opening your own vaults never shows up
 * as a change to the repository.
 *
 * It is a *synthesised row*, not a seeded file: nothing is written until you open
 * something. Which also means `pj vaults forget` works on it — that write
 * materialises the file, and an empty list is then an empty list.
 *
 * Only the tutorial ships this way. `vaults/coverage` is committed too, but it is
 * a test fixture: it belongs to whoever is looking at the app, not to somebody
 * opening it for the first time.
 *
 * `PROJECTOR_VAULTS` opts out. Pointing the registry somewhere else says this
 * list is mine, and a test asserting on `no vaults yet` should not have to know
 * what the repository ships with.
 */
export function shippedVaults(): VaultEntry[] {
  const path = join(appRoot, 'vaults', 'tutorial');
  if (process.env.PROJECTOR_VAULTS || !isConfigured(path)) return [];
  return [{ path, name: suggestName(path), addedAt: 0 }];
}

function readRegistry(): VaultEntry[] {
  if (!existsSync(registryFile())) return shippedVaults();
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
 * How many notes a folder holds, for the picker and `pj vaults`.
 *
 * Counted with the same walk the indexer uses. It used to be its own flat
 * `readdirSync` with its own exclusions, which meant the two could disagree — and
 * they did, about anything in a subfolder. One question, one answer.
 */
export function countNotes(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return listNoteFiles(paths(path).notes).length;
  } catch {
    return 0;
  }
}

/**
 * Counting is opt-in, because a count is a walk of the vault and most callers
 * never show one. The registry is read to *resolve* a vault far more often
 * than to *display* the list — every `pj` startup, `--help` included, and every
 * `/api/meta` — and each of those was paying a full walk of every registered
 * vault for a number it threw away, which at workspace scale was most of a
 * second per command. `pj vaults` and the pickers ask; nothing else should.
 */
export function listVaults(counted = false): VaultInfo[] {
  return readRegistry()
    .map((v) => ({
      ...v,
      exists: existsSync(v.path),
      notes: counted && existsSync(v.path) ? countNotes(v.path) : null,
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
 * `data`, `vault`, `notes` — and silently borrow the parent's name instead. It is
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
 * Give a folder the `.projector/` it needs to be opened as a vault.
 *
 * Three folders arrive here and each gets a different answer. **One that already
 * has a `.projector/`** is left alone: an absent `facets.yaml` is a vault
 * carrying the built-ins and nothing else, and a deleted `home.yaml` is a view
 * somebody deleted — re-running `--create` over it must not quietly put both
 * back. **One holding markdown** is somebody's notes: the notes are already
 * there, so only the config is written, and nothing that was in the folder is
 * touched or moved. **An empty one** gets the same config and starts bare.
 *
 * Anything else is somebody's documents, and is refused.
 *
 * Views are part of the config rather than an optional extra: a vault with no
 * board would open onto nothing, which is a dead end rather than a fresh start.
 * That is why a folder of markdown is seeded too — the whole point of opening one
 * is to see it arranged.
 */
export function initVault(
  path: string,
  seedFacets: string,
  seedViews: { path: string; body: string }[] = [],
): void {
  const p = paths(path);
  const configured = isConfigured(path);
  if (existsSync(path) && !looksLikeVault(path)) {
    const entries = readdirSync(path).filter((f) => !f.startsWith('.'));
    if (entries.length) throw new Error(`${path} is not empty and does not look like a vault`);
  }
  mkdirSync(p.notes, { recursive: true });
  if (configured) return ensureIgnore(path);

  mkdirSync(p.views, { recursive: true });
  if (!existsSync(p.facets)) writeFileSync(p.facets, seedFacets, 'utf8');
  for (const v of seedViews) {
    const target = join(p.views, v.path);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, v.body, 'utf8');
  }
  ensureIgnore(path);
}

/**
 * The databases and scratch files a vault should never commit.
 *
 * One line covers the three databases now that they live together — they used to
 * need six, at the root, next to the notes.
 *
 * **Missing lines are appended, not skipped.** Writing the file only when it was
 * absent meant it was written for a fresh folder and never for a vault that was
 * already a git repository — which is every adopted one, the case the whole
 * feature exists for. Those vaults grew three untracked databases and nothing
 * said why. Nothing already present is repeated, and nothing already there is
 * touched: this only ever adds lines to the end.
 */
const IGNORED = ['.projector/*.db*', '*.tmp-*', '.DS_Store'];

function ensureIgnore(path: string): void {
  const ignore = join(path, '.gitignore');
  if (!existsSync(ignore)) {
    writeFileSync(ignore, `${IGNORED.join('\n')}\n`, 'utf8');
    return;
  }
  const current = readFileSync(ignore, 'utf8');
  const have = new Set(current.split('\n').map((l) => l.trim()));
  const missing = IGNORED.filter((l) => !have.has(l));
  if (!missing.length) return;
  const gap = current === '' || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(ignore, `${current}${gap}# projector — derived and disposable\n${missing.join('\n')}\n`, 'utf8');
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

/**
 * Immediate subdirectories, for the folder picker.
 *
 * Both halves of "is this a vault" are reported, because they look different to a
 * person browsing: `configured` is one they have opened before, `isVault` is any
 * folder holding markdown — which, since the layout stopped requiring a `notes/`,
 * includes `~/Documents` and every source repository. Marking those identically
 * to a real vault would be the picker asserting something it does not know.
 */
export function browse(
  path: string,
): { path: string; entries: { name: string; isVault: boolean; configured: boolean }[] } {
  const p = path.trim() ? normalise(path) : homedir();
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    throw new Error(`not a directory: ${p}`);
  }
  const entries = readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({
      name: e.name,
      isVault: looksLikeVault(join(p, e.name)),
      configured: isConfigured(join(p, e.name)),
    }))
    .sort(
      (a, b) =>
        Number(b.configured) - Number(a.configured) ||
        Number(b.isVault) - Number(a.isVault) ||
        a.name.localeCompare(b.name),
    );
  return { path: p, entries };
}

export { registryFile, looksLikeVault };
