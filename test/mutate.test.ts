import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Conflict,
  Invalid,
  bulkDelete,
  bulkFacet,
  bulkMove,
  checkFacets,
  createNote,
  deleteNote,
  mergeNotes,
  mtimeOf,
  patchNote,
  repointed,
  putFrontmatter,
  saveAsset,
  foldInto,
} from '../src/server/mutate.ts';
import { defaultSides, foldResult, foldRows } from '../src/schema/fold.ts';
import type { Facets } from '../src/schema/types.ts';
import { readAll } from '../src/index/indexer.ts';
import { paths } from '../src/config.ts';

/**
 * The write gate.
 *
 * Every change to a note file goes through this module, and half of it had no
 * test — including `bulkMove`, the per-note transform that makes a drag mean the
 * same thing for one note and for twelve. That fix was verified by hand in a
 * terminal and never pinned, which is the pattern this codebase keeps producing:
 * the pure part covered, the thing that applies it not.
 *
 * Everything here takes a root and writes inside it, so a temp directory is the
 * whole setup — no injection, no harness.
 */

function vault(cards: Record<string, string> = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pj-mutate-'));
  mkdirSync(paths(root).config, { recursive: true });
  writeFileSync(
    paths(root).facets,
    'priority: { label: Priority, values: [now, month, backlog], open: false }\n' +
      'status: { label: Status, values: [planning, done], open: false, single: true }\n' +
      'tech: { label: Tech, values: [kafka], open: true }\n' +
      'parent: { label: Part of, type: ref, single: true }\n',
    'utf8',
  );
  for (const [id, body] of Object.entries(cards)) {
    writeFileSync(join(paths(root).notes, `${id}.md`), body, 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const card = (id: string, facets: string) =>
  `---\nid: ${id}\ntitle: ${id.toUpperCase()}\nfacets: { ${facets} }\n---\nbody of ${id}\n`;

const facetsOf = (root: string, id: string) =>
  readAll(paths(root).notes).notes.get(id)?.facets ?? {};

// ---------------------------------------------------------------- bulkMove

/**
 * The bug this function exists to make unrepresentable: the board computed the
 * new values for one note and threw them away whenever more than one was
 * selected, sending uniform values instead. Shift-dragging `now`→`month` took
 * `now` off a single note and `month` off a batch.
 *
 * The property is that every note gets *its own* answer from one transform, which
 * a uniform `values` array cannot express — so the test uses three notes holding
 * three different things and one gesture.
 */
test('a move gives every note its own answer from one gesture', () => {
  const v = vault({
    both: card('both', 'priority: [now, month]'),
    only: card('only', 'priority: [now]'),
    other: card('other', 'priority: [now, backlog]'),
  });
  try {
    const move = [{ facet: 'priority', from: 'now', to: 'month' }];
    const res = bulkMove(v.root, ['both', 'only', 'other'], move, 'remove');
    assert.equal(res.changed, 3);
    // `now` came off every one; `month` came off none. Under the old uniform path
    // `both` would have become ['now'] — the inversion.
    assert.deepEqual(facetsOf(v.root, 'both').priority, ['month']);
    assert.equal(facetsOf(v.root, 'only').priority, undefined, 'an emptied facet is dropped');
    assert.deepEqual(facetsOf(v.root, 'other').priority, ['backlog']);
  } finally {
    v.cleanup();
  }
});

test('a plain move replaces the value dragged from and keeps the rest', () => {
  const v = vault({ a: card('a', 'priority: [now, month]') });
  try {
    bulkMove(v.root, ['a'], [{ facet: 'priority', from: 'now', to: 'backlog' }], 'replace');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['month', 'backlog']);
  } finally {
    v.cleanup();
  }
});

test('a move writes only the facet it names', () => {
  const v = vault({ a: card('a', 'priority: [now], status: [planning], tech: [kafka]') });
  try {
    bulkMove(v.root, ['a'], [{ facet: 'priority', from: 'now', to: 'month' }], 'replace');
    const after = facetsOf(v.root, 'a');
    assert.deepEqual(after.priority, ['month']);
    // The whole-map replacement this replaced could revert a facet an agent had
    // changed since the client's last read.
    assert.deepEqual(after.status, ['planning']);
    assert.deepEqual(after.tech, ['kafka']);
  } finally {
    v.cleanup();
  }
});

test('a move that changes nothing writes nothing', () => {
  const v = vault({ a: card('a', 'priority: [month]') });
  try {
    const before = mtimeOf(join(paths(v.root).notes, 'a.md'));
    const move = [{ facet: 'priority', from: 'now', to: 'month' }];
    assert.equal(bulkMove(v.root, ['a'], move, 'add').changed, 0);
    assert.equal(mtimeOf(join(paths(v.root).notes, 'a.md')), before, 'the file was not touched');
  } finally {
    v.cleanup();
  }
});

/**
 * A diagonal drag on a matrix board crosses two axes and is still one gesture, so
 * it is one write. Two writes would read the note twice, bump `updated` twice and
 * let the second land on a note the first had already changed.
 */
test('a move across two axes is a single write', () => {
  const v = vault({ a: card('a', 'priority: [now], status: [planning], tech: [kafka]') });
  try {
    const res = bulkMove(
      v.root,
      ['a'],
      [
        { facet: 'status', from: 'planning', to: 'done' },
        { facet: 'priority', from: 'now', to: 'month' },
      ],
      'replace',
    );
    assert.equal(res.changed, 1, 'one note, counted once however many axes moved');
    const after = facetsOf(v.root, 'a');
    assert.deepEqual(after.status, ['done']);
    assert.deepEqual(after.priority, ['month']);
    assert.deepEqual(after.tech, ['kafka'], 'and still only the facets it named');
  } finally {
    v.cleanup();
  }
});

/** Every axis is checked before any is written, so there is no half-moved note. */
test('a move refused on one axis leaves the other alone', () => {
  const v = vault({ a: card('a', 'priority: [now], status: [planning]') });
  try {
    assert.throws(
      () =>
        bulkMove(
          v.root,
          ['a'],
          [
            { facet: 'status', from: 'planning', to: 'done' },
            { facet: 'priority', from: 'now', to: 'urgent' },
          ],
          'replace',
        ),
      (e: Error) => e instanceof Invalid && /urgent/.test(e.message),
    );
    const after = facetsOf(v.root, 'a');
    assert.deepEqual(after.status, ['planning'], 'the axis that would have succeeded');
    assert.deepEqual(after.priority, ['now']);
  } finally {
    v.cleanup();
  }
});

test('a move refuses a value the vocabulary does not have', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    assert.throws(
      () => bulkMove(v.root, ['a'], [{ facet: 'priority', from: 'now', to: 'urgent' }], 'replace'),
      (e: Error) => e instanceof Invalid && /urgent/.test(e.message),
    );
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['now'], 'and leaves the note alone');
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- bulkFacet

/** Uniform on purpose: "make these say `now`" is a different operation from a move. */
test('a bulk facet write is uniform, and set / add / remove each mean one thing', () => {
  const v = vault({
    a: card('a', 'priority: [now, month]'),
    b: card('b', 'priority: [backlog]'),
  });
  try {
    bulkFacet(v.root, ['a', 'b'], 'priority', ['now'], 'set');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['now']);
    assert.deepEqual(facetsOf(v.root, 'b').priority, ['now'], 'set replaces whatever was there');

    bulkFacet(v.root, ['a', 'b'], 'priority', ['month'], 'add');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['now', 'month']);

    bulkFacet(v.root, ['a'], 'priority', ['now'], 'remove');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['month']);
  } finally {
    v.cleanup();
  }
});

test('a bulk write skips an id that is not a note rather than failing the batch', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    assert.equal(bulkFacet(v.root, ['a', 'ghost'], 'priority', ['month'], 'set').changed, 1);
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['month']);
  } finally {
    v.cleanup();
  }
});

// -------------------------------------------------------- one axis at a time

/**
 * The two forms of a facet write, and why both exist.
 *
 * `facets` is the whole map, replaced. `pj set` needs that, because it expresses
 * every removal by omitting a key — `--facet f=`, a fully-consumed `--remove`,
 * `--parent none`. Under a merge those three would silently stop removing.
 *
 * `facet` is one axis, merged over the file *after* the guard. The browser needs
 * that: the map it holds is as old as its last render, so sending it back reverts
 * whatever an agent changed on another axis in the meantime — and the write still
 * satisfies `guard`, because the file it is racing was written inside the
 * tolerance. That is a lost update with no conflict and no trace, which is the
 * one outcome C3 says this module exists to prevent.
 */
test('a narrow write touches one axis and leaves an agent’s concurrent edit alone', () => {
  const v = vault({ a: card('a', 'priority: [now], tech: [kafka]') });
  try {
    // What the browser read, and what it still believes the map to be.
    const base = mtimeOf(join(paths(v.root).notes, 'a.md'));

    // An agent edits another axis. Within the guard's tolerance, so no conflict:
    // this is the race that has no 409 to catch it.
    writeFileSync(
      join(paths(v.root).notes, 'a.md'),
      card('a', 'priority: [now], tech: [kafka, quarkus]'),
      'utf8',
    );

    patchNote(v.root, 'a', { facet: { name: 'status', values: ['done'] }, baseMtime: base });

    const after = facetsOf(v.root, 'a');
    assert.deepEqual(after.status, ['done'], 'the named axis is written');
    assert.deepEqual(after.tech, ['kafka', 'quarkus'], 'the agent’s edit survives');
    assert.deepEqual(after.priority, ['now'], 'an axis nobody touched is untouched');
  } finally {
    v.cleanup();
  }
});

test('a narrow write clears an axis by naming it empty, and validates the values it names', () => {
  const v = vault({ a: card('a', 'priority: [now], tech: [kafka]') });
  try {
    patchNote(v.root, 'a', { facet: { name: 'tech', values: [] } });
    assert.equal(facetsOf(v.root, 'a').tech, undefined, 'an emptied axis is dropped, not stored as []');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['now']);

    assert.throws(
      () => patchNote(v.root, 'a', { facet: { name: 'priority', values: ['nonsuch'] } }),
      /priority/,
      'the narrow form is not a way past the vocabulary',
    );
  } finally {
    v.cleanup();
  }
});

/**
 * The same race, one level in: two edits to the *same* axis.
 *
 * Naming the axis is not enough on its own. A toggle that says "tech is now
 * [k8s]" is still asserting the whole axis from a copy as old as its last render,
 * so an agent adding a value to `tech` in between is reverted — inside the
 * guard's tolerance, so there is no conflict and no trace. `add`/`remove` say
 * what the click did instead, and a delta cannot revert what it never mentioned.
 */
test('a toggle removes the value it names without reverting one added beside it', () => {
  const v = vault({ a: card('a', 'tech: [kafka]') });
  try {
    const base = mtimeOf(join(paths(v.root).notes, 'a.md'));

    // The user's panel rendered with tech: [kafka]. An agent then adds one.
    writeFileSync(join(paths(v.root).notes, 'a.md'), card('a', 'tech: [kafka, quarkus]'), 'utf8');

    // The user clicks `kafka` off. Under `set` this would send [] and take
    // `quarkus` with it.
    patchNote(v.root, 'a', {
      facet: { name: 'tech', values: ['kafka'], mode: 'remove' },
      baseMtime: base,
    });

    assert.deepEqual(facetsOf(v.root, 'a').tech, ['quarkus'], 'the agent’s value survives');
  } finally {
    v.cleanup();
  }
});

test('add is a union and remove is a difference, both against the file', () => {
  const v = vault({ a: card('a', 'tech: [kafka]') });
  try {
    patchNote(v.root, 'a', { facet: { name: 'tech', values: ['kafka'], mode: 'add' } });
    assert.deepEqual(facetsOf(v.root, 'a').tech, ['kafka'], 'adding what is there is not a duplicate');

    patchNote(v.root, 'a', { facet: { name: 'tech', values: ['quarkus'], mode: 'add' } });
    assert.deepEqual(facetsOf(v.root, 'a').tech, ['kafka', 'quarkus']);

    patchNote(v.root, 'a', { facet: { name: 'tech', values: ['nonsuch'], mode: 'remove' } });
    assert.deepEqual(facetsOf(v.root, 'a').tech, ['kafka', 'quarkus'], 'removing an absent value is a no-op');

    patchNote(v.root, 'a', { facet: { name: 'tech', values: ['kafka', 'quarkus'], mode: 'remove' } });
    assert.equal(facetsOf(v.root, 'a').tech, undefined, 'emptying the axis drops it');
  } finally {
    v.cleanup();
  }
});

/**
 * A single-valued axis is the one case where replacing is honest, and the
 * vocabulary is what makes it so — `add` on `status` would produce two values and
 * be refused, which is why the editor picks `set` from `def.single` rather than
 * from the facet's name (C4).
 */
test('a single-valued axis refuses to accumulate, whatever mode asks', () => {
  const v = vault({ a: card('a', 'status: [planning]') });
  try {
    patchNote(v.root, 'a', { facet: { name: 'status', values: ['done'], mode: 'set' } });
    assert.deepEqual(facetsOf(v.root, 'a').status, ['done']);

    assert.throws(
      () => patchNote(v.root, 'a', { facet: { name: 'status', values: ['planning'], mode: 'add' } }),
      /status/,
    );
  } finally {
    v.cleanup();
  }
});

/**
 * The guard against fixing the two forms into one. `pj set` reads the note,
 * mutates a copy of the map and sends it whole; if `facets` ever started merging,
 * every removal it expresses would become a no-op — with no compile error.
 */
test('the whole-map form still replaces, so `pj set` can express a removal', () => {
  const v = vault({ a: card('a', 'priority: [now], tech: [kafka]') });
  try {
    patchNote(v.root, 'a', { facets: { priority: ['month'] } });
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['month']);
    assert.equal(facetsOf(v.root, 'a').tech, undefined, 'an omitted key is a removal');
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- validation

/** The gate every write passes through, and it had no test of its own. */
test('the vocabulary is enforced: unknown facets, closed values, single-valued axes', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    assert.throws(() => checkFacets(v.root, 'a', { nonsuch: ['x'] }), /unknown facet "nonsuch"/);
    assert.throws(() => checkFacets(v.root, 'a', { priority: ['urgent'] }), /urgent/);
    assert.throws(() => checkFacets(v.root, 'a', { status: ['planning', 'done'] }), /one value/);

    // An open facet takes anything; a declared value on a closed one is fine.
    checkFacets(v.root, 'a', { tech: ['something-new'] });
    checkFacets(v.root, 'a', { priority: ['now', 'month'] });
  } finally {
    v.cleanup();
  }
});

/**
 * The graph checks only run when the note map is supplied — `isRef(def) &&
 * notes`. Worth pinning, because a caller that omits it gets validation minus
 * the cycle rule and no indication that it did.
 */
test('a reference facet refuses a cycle, and self-reference, given the notes', () => {
  const v = vault({
    top: card('top', 'parent: [mid]'),
    mid: card('mid', 'status: [planning]'),
  });
  try {
    const notes = readAll(paths(v.root).notes).notes;

    // `top` already points at `mid`; pointing `mid` back closes a loop.
    assert.throws(
      () => checkFacets(v.root, 'mid', { parent: ['top'] }, notes),
      (e: Error) => e instanceof Invalid && /cycle/i.test(e.message),
    );
    assert.throws(
      () => checkFacets(v.root, 'mid', { parent: ['mid'] }, notes),
      (e: Error) => e instanceof Invalid && /own note/i.test(e.message),
    );

    // Without the map the vocabulary is still checked, the graph is not.
    checkFacets(v.root, 'mid', { parent: ['top'] });
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- frontmatter

test('frontmatter is written whole, and a stale mtime is a conflict', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    const file = join(paths(v.root).notes, 'a.md');
    const res = putFrontmatter(v.root, 'a', 'id: a\ntitle: Renamed\nfacets: { priority: [month] }\n');
    assert.ok(typeof res.mtime === 'number');
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['month']);
    assert.match(readFileSync(file, 'utf8'), /body of a/, 'the body is untouched');

    // A write carrying an mtime from before someone else's edit is refused.
    assert.throws(() => putFrontmatter(v.root, 'a', 'id: a\ntitle: X\n', 1), (e) => e instanceof Conflict);
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- bare notes

/**
 * The first write to a file that carried no frontmatter.
 *
 * `patchKey` was always happy to invent a fence, so the naive version of this
 * wrote `updated:` alone — a file with frontmatter, no `id`, and a body it could
 * no longer be found by. Identity has to go in *with* the first key, and it has
 * to be the identity the note was already answering to.
 */
test('writing to a note that carried no frontmatter freezes the name it was going by', () => {
  const v = vault();
  try {
    const file = join(paths(v.root).notes, 'Reading Notes.md');
    writeFileSync(file, '# Monday reading\n\nWe talked about the thing.\n', 'utf8');

    // Found by the id the parser derived, without anything having written it.
    patchNote(v.root, 'reading-notes', { facets: { status: ['planning'] } });

    const rec = readAll(paths(v.root).notes).notes.get('reading-notes')!;
    assert.deepEqual(rec.facets.status, ['planning']);
    assert.equal(rec.title, 'Monday reading', 'the heading it was already titled by');

    const text = readFileSync(file, 'utf8');
    assert.match(text, /^---\nid: reading-notes\ntitle: Monday reading\n/, 'identity, written down');
    assert.match(text, /We talked about the thing\.\n$/, 'and the body is untouched');

    // Which is the whole point: the file can now be renamed without renaming the
    // note, so a reference pointing at it survives.
    renameSync(file, join(paths(v.root).notes, 'archive-me.md'));
    assert.ok(readAll(paths(v.root).notes).notes.get('reading-notes'), 'still the same note');
  } finally {
    v.cleanup();
  }
});

test('a body written to a bare note leaves it bare until the identity lands', () => {
  const v = vault();
  try {
    const file = join(paths(v.root).notes, 'thought.md');
    writeFileSync(file, 'just prose\n', 'utf8');
    patchNote(v.root, 'thought', { body: 'different prose\n' });

    const text = readFileSync(file, 'utf8');
    assert.equal(text.startsWith('---\n'), true, 'the write that follows a body edit adds identity');
    assert.match(text, /different prose\n$/);
    assert.equal(text.includes('undefined'), false, 'and never the string "undefined"');
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- assets

test('an asset is stored by content hash under its note, and its type is checked', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const first = saveAsset(v.root, 'a', 'image/png', png);
    // The path returned is relative to `notes/`, since that is where a note body
    // resolves it from.
    assert.match(first.path, /^assets\/a\/[0-9a-f]{12}\.png$/, first.path);
    assert.ok(existsSync(join(paths(v.root).notes, first.path)), 'stored under notes/');

    // The same bytes hash to the same name rather than accumulating copies.
    assert.equal(saveAsset(v.root, 'a', 'image/png', png).path, first.path);

    assert.throws(() => saveAsset(v.root, 'a', 'application/zip', png), /unsupported image type/);
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- deletion

test('a bulk delete removes the files and reports how many', () => {
  const v = vault({ a: card('a', 'priority: [now]'), b: card('b', 'priority: [now]') });
  try {
    assert.equal(bulkDelete(v.root, ['a', 'ghost']).deleted, 1, 'a missing id is not a failure');
    assert.ok(!existsSync(join(paths(v.root).notes, 'a.md')));
    assert.ok(existsSync(join(paths(v.root).notes, 'b.md')));
  } finally {
    v.cleanup();
  }
});

test('linking bumps updated, and unlinking an absent ref refuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'projector-link-'));
  try {
    mkdirSync(paths(root).config, { recursive: true });
    writeFileSync(
      join(paths(root).notes, 'a.md'),
      '---\nid: a\ntitle: Card A\nupdated: 2020-01-01\n---\nbody\n',
      'utf8',
    );
    writeFileSync(paths(root).facets, 'status: { values: [planning, done] }\n', 'utf8');

    patchNote(root, 'a', { links: ['jira:FOO-1'] });
    const after = readFileSync(join(paths(root).notes, 'a.md'), 'utf8');
    assert.match(after, /links: \[jira:FOO-1\]/);
    assert.doesNotMatch(after, /updated: 2020-01-01/, 'a write that leaves `updated` alone is the bug');
    assert.match(after, /updated: \d{4}-\d{2}-\d{2}/);

    // Emptying the array drops the key rather than storing `links: []`.
    patchNote(root, 'a', { links: [] });
    assert.doesNotMatch(readFileSync(join(paths(root).notes, 'a.md'), 'utf8'), /links:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The gesture that meant two things.
 *
 * The board computed `nextValues` for one note and then threw it away whenever
 * more than one was selected, sending uniform values to the bulk endpoint
 * instead. Three of four gestures diverged and one *inverted*: shift-dragging
 * `now`→`month` took `now` off a single note and `month` off a batch. There is no
 * cardinality branch to test any more, so this asserts the property instead — the
 * intent carries endpoints, and one transform answers for every note.
 */

// ------------------------------------------------- the base a loop writes from

/**
 * Every loop in this module writes a record's whole `facets:` key, so the map it
 * writes has to come from a read of that record's own file — not from the
 * snapshot the loop opened with.
 *
 * `bulkMove` carried a comment claiming this property while not having it: "it
 * writes only the named facets, so a value an agent changed since the client's
 * last read cannot be reverted". True of the payload, false of the file. Real
 * cost, at vault scale: `readAll` measures tens of milliseconds over a few hundred notes, and
 * every write in the loop widens the gap after it, so a concurrent edit inside
 * that window was reverted with no conflict to report.
 *
 * Naming an id twice is the same staleness expressed synchronously, which is what
 * makes it testable at all. A `replace` drag is idempotent — the second pass finds
 * `from` already gone and `to` already present, so it has nothing to do and must
 * not count as changed. Reading the pre-loop snapshot instead, the second pass
 * sees the *original* values, decides there is work, and writes the file a second
 * time: `changed` comes back 2, and `updated` is bumped twice for one gesture.
 */
test('a loop writes from the file it is about to write, not from its opening snapshot', () => {
  const v = vault({ twice: card('twice', 'priority: [now], tech: [kafka]') });
  try {
    const move = [{ facet: 'priority', from: 'now', to: 'month' }];
    const res = bulkMove(v.root, ['twice', 'twice'], move, 'replace');
    assert.equal(res.changed, 1, 'the second pass sees the first write and has nothing to do');
    assert.deepEqual(facetsOf(v.root, 'twice').priority, ['month']);
    // The axis nobody named survives, which is the property the whole-key write
    // threatens and the re-read protects.
    assert.deepEqual(facetsOf(v.root, 'twice').tech, ['kafka']);
  } finally {
    v.cleanup();
  }
});

/**
 * The same rule on the widest fan-out in the module: deleting a note rewrites the
 * whole `facets:` key of every note that referenced it — files the caller never
 * named, never read, and holds no mtime for.
 *
 * **This test does not discriminate on the re-read, and saying so is the point.**
 * `deleteNote` takes its own `readAll` at the top of the call, so there is no gap
 * a test can write into from outside: the snapshot is already current by the time
 * the loop runs, and the assertions below pass with or without `facetsNow`. What
 * it pins is the property — a bystander keeps every axis but the dangling one —
 * which is worth a test on its own. The staleness it cannot reach is a concurrent
 * writer landing between that `readAll` and each bystander's write, and reaching
 * that needs an injectable read rather than a temp directory.
 */
test('the delete cascade takes only the dangling reference off a bystander', () => {
  const v = vault({
    target: card('target', 'priority: [now]'),
    holder: card('holder', 'parent: [target], tech: [kafka]'),
  });
  try {
    // Change the bystander on disk after it would have been snapshotted by an
    // earlier read, then delete. The cascade must keep what it finds there.
    writeFileSync(
      join(paths(v.root).notes, 'holder.md'),
      card('holder', 'parent: [target], tech: [kafka], priority: [backlog]'),
      'utf8',
    );
    const res = deleteNote(v.root, 'target');
    assert.equal(res.removedEdges, 1);
    const holder = facetsOf(v.root, 'holder');
    assert.equal(holder.parent, undefined, 'the dangling reference is gone');
    assert.deepEqual(holder.tech, ['kafka']);
    assert.deepEqual(holder.priority, ['backlog'], 'and nothing else on the bystander moved');
  } finally {
    v.cleanup();
  }
});

// ------------------------------------------------------ who declines the guard

/**
 * Which writes carry a concurrency guard, pinned — because the claim about it
 * drifted, not the code.
 *
 * `ARCHITECTURE.md` labelled its own diagram "409 on a concurrent edit" and stated
 * "conflicts are refused, not merged" as a property of the product. Both are
 * properties of one surface: `guard` returns immediately when no base arrives, and
 * only three functions here ever receive one. Every bulk op, every `pj` command and
 * the delete cascade decline it, most of them because their signature has nowhere
 * to put one.
 *
 * So the set is the decision and the prose has to match it. This asserts both
 * directions: a guard added or removed without a document change fails here, and a
 * document that stops naming a guarded path fails here too.
 */
test('the write paths that carry a guard are the ones the document names', () => {
  const src = readFileSync(new URL('../src/server/mutate.ts', import.meta.url), 'utf8');
  const lines = src.split('\n');

  /** Every `guard(...)` call, attributed to the exported function it sits in. */
  const guarded = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s+guard\(/.test(lines[i]!)) continue;
    for (let j = i; j >= 0; j--) {
      const m = lines[j]!.match(/^export function (\w+)/);
      if (m) {
        guarded.add(m[1]!);
        break;
      }
    }
  }

  assert.deepEqual(
    [...guarded].sort(),
    ['patchFields', 'putFrontmatter', 'patchNote'].sort(),
    'a write path gained or lost its guard — update ARCHITECTURE.md’s write-path table with it',
  );

  // And the document says so, in the table rather than in a sentence that reads
  // like a promise about everything.
  const doc = readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
  assert.match(doc, /Conflicts are refused where a base is sent/, 'the scoped claim');
  assert.doesNotMatch(
    doc,
    /\*\*Conflicts are refused, not merged\.\*\*/,
    'the unscoped claim came back',
  );
  for (const row of ['cannot be guarded', 'merges', 'narrows']) {
    assert.ok(doc.includes(row), `the write-path table should still say "${row}"`);
  }
});

// ------------------------------------------------------- two writers, interleaved

/**
 * The write gate, exercised the way it is actually used: one file, two writers.
 *
 * `guard`'s window is not slack, it is the panel's own overlapping writes — `press`
 * is fire-and-forget on purpose, so two chip clicks inside a second carry bases
 * computed before either returned. These assert both halves of that: a base this
 * app just produced is accepted, and a base from before somebody else's write is
 * not.
 */
test('a base from our own preceding write is accepted; one from before a foreign write is not', () => {
  const v = vault({ shared: card('shared', 'priority: [now]') });
  try {
    const file = join(paths(v.root).notes, 'shared.md');
    const first = mtimeOf(file);

    // Our write, carrying the mtime we read. Accepted, and it returns the new one.
    const { mtime: afterOurs } = patchNote(v.root, 'shared', {
      facet: { name: 'priority', values: ['month'], mode: 'set' },
      baseMtime: first,
    });
    assert.deepEqual(facetsOf(v.root, 'shared').priority, ['month']);

    // The base we now hold is the one that write returned, so the next write lands.
    patchNote(v.root, 'shared', {
      facet: { name: 'tech', values: ['kafka'], mode: 'add' },
      baseMtime: afterOurs,
    });
    assert.deepEqual(facetsOf(v.root, 'shared').tech, ['kafka']);
    assert.deepEqual(facetsOf(v.root, 'shared').priority, ['month'], 'and did not revert the first');

    // Now somebody else — an agent, a `pj set`, a `git checkout` — writes the file
    // with no gate at all, which is the only thing an agent can do. Far enough back
    // that the window cannot absorb it.
    const foreign = mtimeOf(file) + 5_000;
    assert.throws(
      () =>
        patchNote(v.root, 'shared', {
          facet: { name: 'priority', values: ['backlog'], mode: 'set' },
          baseMtime: foreign - 10_000,
        }),
      Conflict,
      'a base from before a foreign write is refused rather than merged',
    );
    assert.deepEqual(
      facetsOf(v.root, 'shared').priority,
      ['month'],
      'and the refusal wrote nothing',
    );
  } finally {
    v.cleanup();
  }
});

/**
 * A delta does not need the gate, and that is the point of having one.
 *
 * `add` and `remove` name a value rather than asserting an axis, and the server folds
 * them into whatever it finds on disk — so a value another writer added between this
 * caller's read and its write survives. This is the one write in the app that
 * *merges*, and it is why the panel's chips are safe even inside the window the gate
 * cannot see into.
 */
test('a delta folds into what is on disk, so a concurrent value survives it', () => {
  const v = vault({ shared: card('shared', 'tech: [kafka]') });
  try {
    // Somebody else adds a value we never saw.
    writeFileSync(
      join(paths(v.root).notes, 'shared.md'),
      card('shared', 'tech: [kafka, aws]'),
      'utf8',
    );

    // Our write, computed from the read that did not have it, and deliberately
    // passing no base — the CLI and the bulk bar both do this.
    patchNote(v.root, 'shared', { facet: { name: 'tech', values: ['github'], mode: 'add' } });

    assert.deepEqual(
      facetsOf(v.root, 'shared').tech,
      ['kafka', 'aws', 'github'],
      'the value we never read is still there',
    );

    // Where `set` would have taken it out, which is why the panel restricts `set` to
    // axes on which replacing is the honest meaning.
    patchNote(v.root, 'shared', { facet: { name: 'tech', values: ['github'], mode: 'set' } });
    assert.deepEqual(facetsOf(v.root, 'shared').tech, ['github'], 'set replaces, as it says');
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- merging

/**
 * A merge is the one write that touches many files for one gesture and cannot
 * put any of them back: the survivor, every note that referenced an absorbed
 * one, and the absorbed files themselves. So what is asserted here is mostly
 * *what else moved* — the composition itself is pure and lives in
 * `test/note.test.ts`.
 */
const noteFile = (id: string, front = '', body = '') =>
  `---\nid: ${id}\ntitle: ${id.toUpperCase()}\n${front}---\n${body}`;

const bodyOf = (root: string, id: string) =>
  readAll(paths(root).notes).notes.get(id)?.body ?? null;

test('a merge folds bodies into sections, combines links, and removes the files', () => {
  const v = vault({
    keep: noteFile('keep', 'facets: { status: [planning] }\nlinks: [jira:PROJ-1]\n', '\nWhat I knew.\n'),
    gone: noteFile('gone', 'facets: { status: [done] }\nlinks: [doc:x]\n', '\nAnd this.\n'),
  });
  try {
    const res = mergeNotes(v.root, 'keep', ['gone', 'keep']);
    assert.deepEqual(res, { merged: 1, repointed: 0 });
    const notes = readAll(paths(v.root).notes).notes;
    assert.equal(notes.has('gone'), false, 'the absorbed file is gone');
    // The survivor's own lifecycle is untouched — it did not inherit `done`.
    assert.deepEqual(notes.get('keep')!.facets.status, ['planning']);
    assert.deepEqual(notes.get('keep')!.links.map((l) => l.raw), ['jira:PROJ-1', 'doc:x']);
    assert.equal(bodyOf(v.root, 'keep'), '\nWhat I knew.\n\n## GONE\n\nAnd this.\n');
  } finally {
    v.cleanup();
  }
});

/**
 * The whole reason a merge cannot be a delete plus an edit: everything that
 * pointed at the absorbed note has to point at the survivor instead, or the
 * references simply vanish.
 */
test('references to an absorbed note are repointed at the survivor, without duplicating', () => {
  const v = vault({
    keep: noteFile('keep'),
    gone: noteFile('gone'),
    child: noteFile('child', 'facets: { parent: [gone] }\n'),
    both: noteFile('both', 'facets: { project: [keep, gone] }\n'),
  });
  try {
    const res = mergeNotes(v.root, 'keep', ['gone']);
    assert.equal(res.repointed, 2);
    assert.deepEqual(facetsOf(v.root, 'child').parent, ['keep']);
    // Two values collapsing onto one is one value, not the same id twice.
    assert.deepEqual(facetsOf(v.root, 'both').project, ['keep']);
  } finally {
    v.cleanup();
  }
});

/** "Merge this into its parent" — the ordinary case, and a self-reference if unhandled. */
test('merging a note into the one it is part of leaves no self-reference', () => {
  const v = vault({
    keep: noteFile('keep'),
    gone: noteFile('gone', 'facets: { parent: [keep] }\n'),
  });
  try {
    mergeNotes(v.root, 'keep', ['gone']);
    assert.equal(facetsOf(v.root, 'keep').parent, undefined);
  } finally {
    v.cleanup();
  }
});

/**
 * A merge can produce a graph no single write would have been allowed to make,
 * because repointing changes references the survivor never held. It is refused,
 * and — since a half-applied merge is a vault nobody asked for — refused before
 * anything at all is written.
 */
test('a merge that would close a loop is refused, and writes nothing first', () => {
  const v = vault({
    keep: noteFile('keep', 'facets: { parent: [middle] }\n'),
    middle: noteFile('middle', 'facets: { parent: [gone] }\n'),
    gone: noteFile('gone', '', '\nprose\n'),
  });
  try {
    assert.throws(() => mergeNotes(v.root, 'keep', ['gone']), /reach itself through "parent"/);
    const notes = readAll(paths(v.root).notes).notes;
    assert.equal(notes.has('gone'), true, 'the absorbed file is still there');
    assert.deepEqual(notes.get('middle')!.facets.parent, ['gone'], 'nothing was repointed');
    assert.equal(bodyOf(v.root, 'keep'), '', 'the survivor’s body was not composed');
  } finally {
    v.cleanup();
  }
});

test('a merge carries the fingerprints of what it absorbed', () => {
  const v = vault({
    keep: noteFile('keep', 'source_fingerprint: jira:PROJ-1\n'),
    gone: noteFile('gone', 'source_fingerprint: slack:C1/1\n'),
  });
  try {
    mergeNotes(v.root, 'keep', ['gone']);
    const rec = readAll(paths(v.root).notes).notes.get('keep')!;
    assert.deepEqual(rec.absorbed_fingerprints, ['slack:C1/1']);
    assert.equal(rec.source_fingerprint, 'jira:PROJ-1');
  } finally {
    v.cleanup();
  }
});

/**
 * A merge is not the only way a note comes to answer for a fingerprint.
 *
 * Most of what a sweep turns up is neither a new note nor a link on one — it is
 * *more* about a note that already exists, and a standing chore emits a fresh
 * message id every time, so its fingerprint can never collide with the one
 * already captured. Without somewhere to record that the message was consumed,
 * the sweep proposes it again for ever, and the same note gets created weekly.
 */
test('a note can answer for a message that extended it, without claiming to have come from it', () => {
  const v = vault({ chore: noteFile('chore', 'source_fingerprint: gmail:ORIGIN\n') });
  try {
    patchNote(v.root, 'chore', { absorb: { values: ['gmail:LATER'] } });
    const rec = readAll(paths(v.root).notes).notes.get('chore')!;
    assert.deepEqual(rec.absorbed_fingerprints, ['gmail:LATER']);
    // Where it came from is not what extended it: overwriting the origin would
    // lose the only record of which sweep first found this work.
    assert.equal(rec.source_fingerprint, 'gmail:ORIGIN');
    // The point of all of it — the next sweep converges instead of re-creating.
    assert.deepEqual(createNote(v.root, { title: 'Again', fingerprint: 'gmail:LATER' }), {
      id: 'chore',
      existed: true,
    });
  } finally {
    v.cleanup();
  }
});

/**
 * Two notes answering for one fingerprint means whichever the sweep reads first
 * decides, and the other quietly stops being re-proposed — the same failure as
 * a link on the wrong note, except nothing ever surfaces it. So it is refused,
 * and the refusal names the holder, because the fix is to go and look at it.
 */
test('a fingerprint answers for exactly one note', () => {
  const v = vault({
    chore: noteFile('chore', 'source_fingerprint: gmail:ORIGIN\nabsorbed_fingerprints: [gmail:LATER]\n'),
    other: noteFile('other'),
  });
  try {
    assert.throws(
      () => patchNote(v.root, 'other', { absorb: { values: ['gmail:LATER'] } }),
      (e: unknown) => e instanceof Invalid && /already answered for by chore/.test((e as Error).message),
    );
    assert.throws(
      () => patchNote(v.root, 'chore', { absorb: { values: ['gmail:ORIGIN'] } }),
      (e: unknown) => e instanceof Invalid && /already came from/.test((e as Error).message),
    );
    // Refused means unwritten, not half-written.
    assert.equal(readAll(paths(v.root).notes).notes.get('other')!.absorbed_fingerprints, undefined);
  } finally {
    v.cleanup();
  }
});

/** Symmetric with `pj link --remove`: a removal that did nothing must say so. */
test('a fingerprint can be handed back, and handing back one that is not held is an error', () => {
  const v = vault({ chore: noteFile('chore', 'absorbed_fingerprints: [gmail:LATER]\n') });
  try {
    patchNote(v.root, 'chore', { absorb: { values: ['gmail:LATER'], mode: 'remove' } });
    // Dropped to nothing, rather than left as an empty list nobody can read.
    assert.equal(readAll(paths(v.root).notes).notes.get('chore')!.absorbed_fingerprints, undefined);
    assert.throws(
      () => patchNote(v.root, 'chore', { absorb: { values: ['gmail:LATER'], mode: 'remove' } }),
      (e: unknown) => e instanceof Invalid && /does not answer for/.test((e as Error).message),
    );
  } finally {
    v.cleanup();
  }
});

/**
 * Asset paths are vault-relative and name the note they were pasted into, so a
 * body that moves without its files keeps working right up until the absorbed
 * note's folder is removed — which is the next thing a merge does.
 */
test('absorbed assets move to the survivor and the body’s paths move with them', () => {
  const v = vault({ keep: noteFile('keep'), gone: noteFile('gone') });
  try {
    const { path } = saveAsset(v.root, 'gone', 'image/png', Buffer.from('pretend-png'));
    writeFileSync(join(paths(v.root).notes, 'gone.md'), noteFile('gone', '', `\n![shot](${path})\n`), 'utf8');
    mergeNotes(v.root, 'keep', ['gone']);
    const moved = path.replace('assets/gone/', 'assets/keep/');
    assert.equal(existsSync(join(paths(v.root).notes, moved)), true, 'the file moved');
    assert.equal(existsSync(join(paths(v.root).notes, 'assets', 'gone')), false, 'the old folder went');
    assert.match(bodyOf(v.root, 'keep')!, new RegExp(moved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    v.cleanup();
  }
});

test('a merge needs a survivor that exists and something else to merge in', () => {
  const v = vault({ keep: noteFile('keep') });
  try {
    assert.throws(() => mergeNotes(v.root, 'nonsuch', ['keep']), /no note with id "nonsuch"/);
    assert.throws(() => mergeNotes(v.root, 'keep', ['keep']), /besides the one it merges into/);
    assert.throws(() => mergeNotes(v.root, 'keep', ['ghost']), /no note with id "ghost"/);
  } finally {
    v.cleanup();
  }
});

// `repointed` is the rewrite both a merge and a delete perform; three ways it can
// go wrong, none of which needs a filesystem.
test('a repoint deduplicates, drops a self-reference, and reports nothing when nothing moved', () => {
  const refs = ['parent', 'project'];
  const gone = new Set(['b']);
  assert.deepEqual(
    repointed({ project: ['a', 'b'] }, refs, gone, 'a', 'x'),
    { facets: { project: ['a'] }, changed: 1 },
  );
  assert.deepEqual(
    repointed({ parent: ['b'] }, refs, gone, 'a', 'a'),
    { facets: {}, changed: 1 },
    'a note cannot be part of itself, so the axis empties and is dropped',
  );
  assert.equal(repointed({ parent: ['c'] }, refs, gone, 'a', 'x'), null);
  // A delete is the same rewrite with nowhere to point.
  assert.deepEqual(
    repointed({ project: ['a', 'b'] }, refs, gone, null, 'x'),
    { facets: { project: ['a'] }, changed: 1 },
  );
});

// ------------------------------------------------------------------ folding in

/**
 * What a fold asks about, and what it leaves to the merge.
 *
 * The division is the design: a reference facet is merge's to union — a note is a
 * member of both projects — and everything else is a question, because one value
 * has to win and only a person can say which. That hole was live: a sweep could
 * discover a ticket had moved to blocked and had no way to say so, `merged()`
 * touching no label on the survivor.
 */

const noteWith = (id: string, facets: Record<string, string[]>) =>
  ({ id, title: id, facets, links: [], body: '', file: `${id}.md` }) as unknown as Parameters<
    typeof foldRows
  >[0];

const FOLD_DEFS = {
  status: { type: 'label', values: ['active', 'blocked'], single: true },
  priority: { type: 'label', values: ['now', 'month'], single: true },
  project: { type: 'ref', values: [], open: true },
  parent: { type: 'ref', values: [], open: true, single: true },
} as unknown as Facets;

test('a fold asks about the axes a merge refuses to touch, and no others', () => {
  const rows = foldRows(
    noteWith('cand', {
      status: ['blocked'],
      priority: ['now'],
      project: ['p'],
      intake: ['unjudged'],
      extends: ['target'],
    }),
    noteWith('target', { status: ['active'], priority: ['now'] }),
    FOLD_DEFS,
  );

  assert.deepEqual(
    rows.map((r) => r.facet),
    ['status'],
    'status differs so it is asked; priority already agrees; project is merge’s to union; ' +
      'intake and extends are the pipeline’s',
  );
  assert.deepEqual(rows[0], { facet: 'status', before: ['active'], after: ['blocked'] });
});

test('an axis the note lacks is a row too, and says it holds nothing', () => {
  const rows = foldRows(
    noteWith('cand', { priority: ['now'] }),
    noteWith('target', { status: ['active'] }),
    FOLD_DEFS,
  );
  // A clean addition is still a decision — taking it is a change to the note.
  assert.deepEqual(rows, [{ facet: 'priority', before: [], after: ['now'] }]);
});

test('the default keeps the note exactly as it is', () => {
  const rows = foldRows(
    noteWith('cand', { status: ['blocked'], priority: ['now'] }),
    noteWith('target', { status: ['active'] }),
    FOLD_DEFS,
  );
  const sides = defaultSides(rows);

  // Which is what folding did before the dialog existed: it can be dismissed
  // unread and behave the way it always did.
  assert.deepEqual(foldResult(rows, sides), {});
});

test('only the axes taken are written, so keeping one writes nothing for it', () => {
  const rows = foldRows(
    noteWith('cand', { status: ['blocked'], priority: ['now'] }),
    noteWith('target', { status: ['active'], priority: ['month'] }),
    FOLD_DEFS,
  );
  const sides = { ...defaultSides(rows), status: 'after' as const };

  // `priority` stays on the note's own value, and is absent rather than written
  // back — a write that changes nothing still moves the file's stamp.
  assert.deepEqual(foldResult(rows, sides), { status: ['blocked'] });
});

test('a fold applies what was taken and merges the rest, in that order', () => {
  const v = vault({
    target: card('target', 'status: [planning], priority: [month]'),
    cand: card('cand', 'status: [done], priority: [now], extends: [target]'),
  });
  try {
    foldInto(v.root, 'cand', 'target', { status: ['done'] });
    const after = readAll(paths(v.root).notes).notes.get('target')!;

    assert.deepEqual(after.facets.status, ['done'], 'the taken axis moved');
    assert.deepEqual(after.facets.priority, ['month'], 'and the kept one did not');
    assert.match(after.body, /body of cand/, 'the body came across regardless');
    assert.equal(readAll(paths(v.root).notes).notes.has('cand'), false, 'the candidate is gone');
  } finally {
    v.cleanup();
  }
});
