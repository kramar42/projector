import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NOTE_PLACES } from '../src/schema/note.ts';

/**
 * Where a fixture's file lives, from the name a test gives it.
 *
 * Tests name notes the way a person would — `a.md`, `platform/README.md`,
 * `mapping/sub.md` — and this puts each where the required layout keeps that kind
 * of file: a bare note in `notes/`, a folder in `projects/`, and anything already
 * naming a place left as it is. The vault's own `AGENTS.md` and `README.md` stay
 * at the root, because they describe the vault rather than being notes in it.
 *
 * The parent directory is created, so the result can be written to at once.
 */
export function place(root: string, ...segments: string[]): string {
  const rel = segments.join('/');
  const [top] = rel.split('/');
  const full =
    rel === 'AGENTS.md' || rel === 'CLAUDE.md' || rel === 'README.md'
      ? join(root, rel)
      : (NOTE_PLACES as readonly string[]).includes(top!) || top === 'assets' || top === 'memory' || top === '.projector'
        ? join(root, rel)
        : rel.includes('/')
          ? join(root, 'projects', rel)
          : join(root, 'notes', rel);
  mkdirSync(dirname(full), { recursive: true });
  return full;
}
