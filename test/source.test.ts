import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/**
 * Every source file has to be searchable.
 *
 * A control byte in a string literal — a separator written as the character
 * rather than as an escape — makes grep classify the whole file as binary and drop
 * it from recursive searches *silently*. `src/agent/history.ts` held two for
 * months. The consequence is not cosmetic: three architecture reviews and four
 * sub-agent sweeps of this repo all under-reported, because the tool used to find
 * things is the one the defect hides from, and nothing said so.
 *
 * It found two more when finally checked by byte instead of by grep — one of them
 * written in the same commit that fixed the first, by copying a separator across
 * during a refactor. That is how easily it comes back, which is why it is a test.
 *
 * The fix is always the same and costs nothing: write the escape (`\u0000`) rather
 * than the character. Byte-identical at runtime, visible in the source.
 */

const ROOT = new URL('..', import.meta.url).pathname;

/** Text extensions only. A real binary — a font, an image — is not a source file. */
const SEARCHABLE = new Set(['.ts', '.tsx', '.css', '.md', '.json', '.yaml', '.yml', '.html']);
const SKIP = new Set(['node_modules', 'dist', '.git', '.pnpm-store']);

/**
 * Tab, newline and carriage return are the control bytes a text file may hold.
 * Everything else below 32, plus DEL, is what makes grep give up.
 */
const ALLOWED = new Set([9, 10, 13]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (SEARCHABLE.has(extname(entry))) out.push(path);
  }
  return out;
}

test('no source file holds a control byte that hides it from grep', () => {
  const files = sourceFiles(ROOT);
  assert.ok(files.length > 40, `expected to walk the repo, found ${files.length} files`);

  const offenders: string[] = [];
  for (const path of files) {
    const bytes = readFileSync(path);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b >= 32 || ALLOWED.has(b)) continue;
      // Report the line, since that is what a fix needs.
      const line = bytes.subarray(0, i).toString('utf8').split('\n').length;
      const hex = `0x${b.toString(16).padStart(2, '0')}`;
      offenders.push(`${relative(ROOT, path)}:${line} holds ${hex}`);
      break;
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these files are invisible to \`grep -r\` — write the byte as an escape instead:\n  ${offenders.join('\n  ')}`,
  );
});

/**
 * The guard is worth nothing if it cannot fail, and a walk that quietly matches
 * nothing passes. So: the detector actually detects, and the walk actually reaches
 * the files it claims to.
 */
test('the guard would catch it', () => {
  const withNul = Buffer.from("const REC = '\u0000';\n", 'utf8');
  const found = [...withNul].some((b) => b < 32 && !ALLOWED.has(b));
  assert.ok(found, 'a literal NUL must be detected');

  const clean = Buffer.from("const REC = '\\u0000';\n\tindented\r\n", 'utf8');
  assert.ok(
    ![...clean].some((b) => b < 32 && !ALLOWED.has(b)),
    'an escape, a tab and a CRLF are all fine',
  );

  const files = sourceFiles(ROOT).map((p) => relative(ROOT, p));
  for (const expected of ['src/agent/history.ts', 'src/web/enrichment.tsx', 'src/web/views/edges.ts']) {
    assert.ok(files.includes(expected), `the walk must reach ${expected} — all three once hid here`);
  }
});
