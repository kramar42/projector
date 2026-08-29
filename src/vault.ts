import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
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
  /**
   * Whether `notes` was counted just now, or read from that vault's last index.
   *
   * The list is drawn from four registered vaults and only one of them is open,
   * so counting them all is a walk of every vault on every listing — 1.5 seconds
   * for four, and essentially all of it the one with two thousand notes. The
   * cached number is the same number (`indexStamp` records the file count it
   * walked, so this is not the index's own row count, which excludes duplicates
   * and unreadable files) but as of whenever that vault was last indexed.
   *
   * So it is reported rather than hidden: a count nobody has verified draws as
   * `~2179`, and the surfaces say what the tilde means. Null when there is no
   * count at all.
   */
  notesExact: boolean | null;
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
 * The same count, from the vault's own index when it has one.
 *
 * `indexStamp` already writes the number: `meta.stamp` is
 * `v2:<files>:<stat count>:<mtime sum>:<max mtime>`, and the second field is the
 * length of exactly the walk `countNotes` does. Reading one small row is 2–5ms
 * against 822ms for the walk that produced it, so the listing costs a read per
 * vault instead of a filesystem traversal per vault.
 *
 * **Not `SELECT count(*) FROM notes`,** which is the tempting one and is a
 * different number: the index collapses duplicate ids and drops unreadable
 * files, so on a real vault it read 1700 where the walk reads 2179. The stamp is
 * the walk's own answer, written down.
 *
 * `exact: false` is the whole of the honesty: nothing here re-verifies that the
 * vault has not changed since, and for a vault no server is watching it can be
 * arbitrarily old. A vault that has never been indexed has no stamp, so it is
 * walked — which is exact, and is also the case where the walk is cheap.
 */
export function countedNotes(path: string): { notes: number; exact: boolean } {
  if (!existsSync(path)) return { notes: 0, exact: true };
  const stamped = stampCount(path);
  if (stamped !== null) return { notes: stamped, exact: false };
  return { notes: countNotes(path), exact: true };
}

/**
 * The file count out of `index.db`'s stamp, or null.
 *
 * Opened read-only and directly rather than through `openDb`, which creates and
 * migrates: asking how many notes a vault has must not bring a database into
 * existence. Every failure is a null — a listing must not break because one
 * registered vault holds a db from an older schema, a half-written file, or a
 * directory somebody has since made unreadable.
 */
function stampCount(path: string): number | null {
  try {
    const file = paths(path).db;
    if (!existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'stamp'").get() as
        | { value: string }
        | undefined;
      const n = Number(row?.value.split(':')[1]);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Counting is opt-in, because a count is a walk of the vault and most callers
 * never show one. The registry is read to *resolve* a vault far more often
 * than to *display* the list — every `pj` startup, `--help` included, and every
 * `/api/meta` — and each of those was paying a full walk of every registered
 * vault for a number it threw away, which at workspace scale was most of a
 * second per command. `pj vaults` and the pickers ask; nothing else should.
 *
 * `true` takes the index's word for the number where there is one; `'walk'` is
 * `pj vaults --exact` and nothing else, for when the tilde needs an answer.
 */
export function listVaults(counted: boolean | 'walk' = false): VaultInfo[] {
  return readRegistry()
    .map((v) => {
      const exists = existsSync(v.path);
      const count = !counted || !exists
        ? null
        : counted === 'walk'
          ? { notes: countNotes(v.path), exact: true }
          : countedNotes(v.path);
      return {
        ...v,
        exists,
        notes: count?.notes ?? null,
        notesExact: count?.exact ?? null,
      };
    })
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
