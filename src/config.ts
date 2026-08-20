import { existsSync } from 'node:fs';
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
 */
export const paths = (root: string) => ({
  root,
  cards: join(root, 'cards'),
  assets: join(root, 'cards', 'assets'),
  facets: join(root, 'facets.yaml'),
  views: join(root, 'views'),
  boards: join(root, 'views', 'board'),
  canvases: join(root, 'views', 'canvas'),
  db: join(root, '.index.db'),
  enrichDb: join(root, '.enrich.db'),
});

/**
 * The vault a command-line invocation should act on.
 *
 * `--vault <path>` wins, then `COCKPIT_DATA`. Otherwise, if exactly one vault is
 * registered, that one — a single-vault setup should not have to say so. With
 * several registered and no choice made, the caller is asked to pick rather than
 * guessing.
 */
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
  if (process.env.COCKPIT_DATA) {
    return { root: resolvePath(process.env.COCKPIT_DATA, process.cwd()) };
  }
  if (registered.length === 1) return { root: registered[0]!.path };
  if (!registered.length) {
    return {
      error:
        'no vault. Pass --vault <path>, set COCKPIT_DATA, or open one in the app first.',
    };
  }
  return {
    error:
      `several vaults are registered — pass --vault <path>:\n` +
      registered.map((v) => `  ${v.name}  ${v.path}`).join('\n'),
  };
}

export { appRoot, existsSync };
