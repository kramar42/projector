import { existsSync, readFileSync } from 'node:fs';
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
 * Data directory resolution, in precedence order:
 *   COCKPIT_DATA → cockpit.config.json's dataDir → ./data
 * Relative values resolve against the app root, so the data directory can be
 * moved anywhere without the CLI's working directory mattering.
 */
export function dataDir(): string {
  const fromEnv = process.env.COCKPIT_DATA;
  if (fromEnv) return resolvePath(fromEnv, appRoot);

  const cfgPath = join(appRoot, 'cockpit.config.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { dataDir?: string };
    if (cfg.dataDir) return resolvePath(cfg.dataDir, appRoot);
  }
  return join(appRoot, 'data');
}

export const paths = (root = dataDir()) => ({
  root,
  cards: join(root, 'cards'),
  assets: join(root, 'cards', 'assets'),
  facets: join(root, 'facets.yaml'),
  views: join(root, 'views'),
  boards: join(root, 'views', 'board'),
  canvases: join(root, 'views', 'canvas'),
  db: join(root, '.index.db'),
});

export { appRoot };
