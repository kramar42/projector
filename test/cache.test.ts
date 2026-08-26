import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cached, invalidate, stampOf } from '../src/index/cache.ts';
import { reindex } from '../src/index/indexer.ts';
import { paths } from '../src/config.ts';

/**
 * The memo, and the one thing its stamp cannot see.
 *
 * `stampOf` reads the source files — cards, views, vocabulary — and skips
 * dotfiles, because the index is its own output and including it would make
 * every rebuild invalidate itself. The gap that leaves: the index is derived and
 * disposable (C1), so another process may delete it and write a new one without
 * touching a single source byte. The stamp says nothing changed, and the cached
 * `DatabaseSync` is left open on an unlinked inode.
 */
function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'projector-cache-'));
  mkdirSync(join(root, '.projector', 'views'), { recursive: true });
  writeFileSync(
    join(root, '.projector', 'facets.yaml'),
    'status:\n  label: Status\n  values: [planning, active]\n',
  );
  writeFileSync(join(root, 'one.md'), '---\nid: one\ntitle: One\n---\n\nBody.\n');
  writeFileSync(join(root, 'two.md'), '---\nid: two\ntitle: Two\n---\n\nBody.\n');
  return root;
}

/** What `load()` does in the server: build through the memo, dispose the old db. */
const build = (root: string) => reindex(root);
const dispose = ({ db }: ReturnType<typeof reindex>) => db.close();

test('nothing changed means nothing is rebuilt', () => {
  const root = vault();
  try {
    invalidate(root);
    const first = cached(root, build, dispose);
    const second = cached(root, build, dispose);
    assert.equal(second, first, 'the memo should hand back the same value');
  } finally {
    invalidate(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a card written outside the app rebuilds the memo', () => {
  const root = vault();
  try {
    invalidate(root);
    const first = cached(root, build, dispose);
    writeFileSync(join(root, 'three.md'), '---\nid: three\ntitle: Three\n---\n\nBody.\n');
    const second = cached(root, build, dispose);
    assert.notEqual(second, first, 'a new card changes the stamp');
    assert.equal(second.notes.size, 3);
  } finally {
    invalidate(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The regression. `pj reindex` — or any `pj` command, which reindexes to answer
 * — opens the index `fresh`, and that unlinks `index.db` along with its `-wal`
 * and `-shm`. Before the memo tracked which file it had open, a server that had
 * cached a value went on serving the old handle: the stamp was unchanged because
 * no card had moved, and every read through the dead handle failed with
 * `disk I/O error` until the process was restarted. `/api/meta` died while
 * `/api/query` survived, because only one of them touches the database.
 */
test('a second process replacing the index does not leave a stale handle', () => {
  const root = vault();
  try {
    invalidate(root);
    const first = cached(root, build, dispose);
    const before = statSync(paths(root).db).ino;
    assert.doesNotThrow(() => first.db.prepare('SELECT count(*) AS n FROM notes').get());

    // Exactly what another terminal does. Nothing under the vault changes.
    const stamp = stampOf(root);
    const outside = reindex(root);
    outside.db.close();
    assert.equal(stampOf(root), stamp, 'no source file changed, so the stamp cannot notice');
    assert.notEqual(statSync(paths(root).db).ino, before, 'but the index is a different file');

    const second = cached(root, build, dispose);
    assert.notEqual(second, first, 'the memo must not hand back a handle to a deleted file');
    assert.doesNotThrow(
      () => second.db.prepare('SELECT count(*) AS n FROM notes').get(),
      'the rebuilt handle reads',
    );
  } finally {
    invalidate(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Disposing the superseded value is how the memo avoids leaking a database per
 * rebuild — but the value it is disposing here is the broken one, and closing a
 * database whose file was unlinked can throw. If that escaped, the fix for one
 * failing route would break every route.
 */
test('a dispose that throws does not fail the rebuild that caused it', () => {
  const root = vault();
  try {
    invalidate(root);
    cached(root, build, dispose);
    writeFileSync(join(root, 'four.md'), '---\nid: four\ntitle: Four\n---\n\nBody.\n');
    const value = cached(root, build, () => {
      throw new Error('close failed');
    });
    assert.equal(value.notes.size, 3);
  } finally {
    invalidate(root);
    rmSync(root, { recursive: true, force: true });
  }
});
