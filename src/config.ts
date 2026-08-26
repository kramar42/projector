import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Expand a leading `~` and resolve against `base`. Absolute paths pass through. */
export function resolvePath(p: string, base: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(base, p);
}

/**
 * Everything inside a vault, derived from its root.
 *
 * The app has no built-in location and no directory name it assumes — a vault is
 * whichever folder the user opened, the way Obsidian works. `paths()` is the only
 * place the internal layout of a vault is written down.
 *
 * **The cards are the vault.** They sit at the root, at any depth, the way a
 * folder of markdown already looks before projector ever sees it — so pointing at
 * an existing pile of notes is opening it, not importing it. Everything the app
 * adds lives under `.projector/`: the vocabulary, the saved views, and the three
 * derived databases. One dot-folder to gitignore, and a root that holds nothing
 * but what you wrote.
 *
 * `notes` is still its own key rather than a second name for `root`. Every caller
 * that reads it wants *where the cards are*, and saying so is what let this
 * change be five lines instead of forty.
 */
export const paths = (root: string) => ({
  root,
  notes: root,
  assets: join(root, 'assets'),
  config: join(root, '.projector'),
  facets: join(root, '.projector', 'facets.yaml'),
  views: join(root, '.projector', 'views'),
  db: join(root, '.projector', 'index.db'),
  enrichDb: join(root, '.projector', 'enrich.db'),
  intakeDb: join(root, '.projector', 'intake.db'),
});

/**
 * The vault a command-line invocation should act on.
 *
 * `--vault <path>` wins, then `PROJECTOR_DATA`. Otherwise, if exactly one vault is
 * registered, that one — a single-vault setup should not have to say so. With
 * several registered and no choice made, the caller is asked to pick rather than
 * guessing.
 */
/**
 * Whether this folder has ever been opened as a vault — it holds a `.projector/`.
 *
 * The strict half of the question, and the only one a *write* is allowed to
 * answer with. See `vaultAbove`.
 */
export function isConfigured(path: string): boolean {
  return existsSync(paths(path).config);
}

/**
 * Whether a directory is a vault: it has been opened as one, or it is a folder
 * of markdown, which is the same thing before anyone opened it.
 *
 * There is no exempted filename. A `README.md` is a card like every other file,
 * because a rule that holds for all but one name is a rule nobody can predict —
 * and the exemption used to be a guess about a file the app does not write.
 *
 * The consequence is deliberate and worth stating: any folder holding markdown
 * answers yes here, a source repository included. That is the honest answer to
 * *could this be opened as a vault* — it could, and it would show you its
 * markdown. It is emphatically **not** the answer to *is this the vault I should
 * write to*, which is `isConfigured`'s.
 */
export function looksLikeVault(path: string): boolean {
  if (isConfigured(path)) return true;
  try {
    return readdirSync(path).some((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
}

/**
 * A vault at or above `from`, found the way git finds a repository.
 *
 * Strict on purpose: a walk-up asks *which vault am I standing in*, and answers
 * it without anyone confirming. If markdown were enough, `pj set` run anywhere
 * inside a source repository would take that repository for its vault and start
 * writing frontmatter into its documentation. `.projector/` is a folder you get
 * by opening a vault once, so the marker is a decision somebody made rather than
 * a coincidence of file extensions.
 */
export function vaultAbove(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (isConfigured(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function resolveCliVault(
  argv: string[],
  registered: { path: string; name: string }[],
): { root: string } | { error: string } {
  const flagAt = argv.indexOf('--vault');
  if (flagAt !== -1) {
    const given = argv[flagAt + 1];
    if (!given) return { error: '--vault needs a path' };
    return { root: resolvePath(given, process.cwd()) };
  }
  if (process.env.PROJECTOR_DATA) {
    return { root: resolvePath(process.env.PROJECTOR_DATA, process.cwd()) };
  }
  // Standing inside a vault is an unambiguous answer, and it does not need the
  // registry to exist — so the CLI works on a vault the app has never opened.
  const here = vaultAbove(process.cwd());
  if (here) return { root: here };
  if (registered.length === 1) return { root: registered[0]!.path };
  if (!registered.length) {
    return {
      error:
        'no vault. Run from inside one, pass --vault <path>, set PROJECTOR_DATA, or open one in the app.',
    };
  }
  return {
    error:
      `several vaults are registered — run from inside one or pass --vault <path>:\n` +
      registered.map((v) => `  ${v.name}  ${v.path}`).join('\n'),
  };
}

export { appRoot, existsSync };
