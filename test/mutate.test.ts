import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Conflict,
  Invalid,
  bulkDelete,
  bulkFacet,
  bulkMove,
  checkFacets,
  deleteNote,
  mtimeOf,
  patchNote,
  putFrontmatter,
  saveAsset,
} from '../src/server/mutate.ts';
import { readAll } from '../src/index/indexer.ts';

/**
 * The write gate.
 *
 * Every change to a card file goes through this module, and half of it had no
 * test — including `bulkMove`, the per-card transform that makes a drag mean the
 * same thing for one card and for twelve. That fix was verified by hand in a
 * terminal and never pinned, which is the pattern this codebase keeps producing:
 * the pure part covered, the thing that applies it not.
 *
 * Everything here takes a root and writes inside it, so a temp directory is the
 * whole setup — no injection, no harness.
 */

function vault(cards: Record<string, string> = {}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pj-mutate-'));
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(
    join(root, 'facets.yaml'),
    'priority: { label: Priority, values: [now, month, backlog], open: false }\n' +
      'status: { label: Status, values: [planning, done], open: false, single: true }\n' +
      'tech: { label: Tech, values: [kafka], open: true }\n' +
      'parent: { label: Part of, type: ref, single: true }\n',
    'utf8',
  );
  for (const [id, body] of Object.entries(cards)) {
    writeFileSync(join(root, 'notes', `${id}.md`), body, 'utf8');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const card = (id: string, facets: string) =>
  `---\nid: ${id}\ntitle: ${id.toUpperCase()}\nfacets: { ${facets} }\n---\nbody of ${id}\n`;

const facetsOf = (root: string, id: string) =>
  readAll(join(root, 'notes')).notes.get(id)?.facets ?? {};

// ---------------------------------------------------------------- bulkMove

/**
 * The bug this function exists to make unrepresentable: the board computed the
 * new values for one card and threw them away whenever more than one was
 * selected, sending uniform values instead. Shift-dragging `now`→`month` took
 * `now` off a single card and `month` off a batch.
 *
 * The property is that every card gets *its own* answer from one transform, which
 * a uniform `values` array cannot express — so the test uses three cards holding
 * three different things and one gesture.
 */
test('a move gives every card its own answer from one gesture', () => {
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
    const before = mtimeOf(join(v.root, 'notes', 'a.md'));
    const move = [{ facet: 'priority', from: 'now', to: 'month' }];
    assert.equal(bulkMove(v.root, ['a'], move, 'add').changed, 0);
    assert.equal(mtimeOf(join(v.root, 'notes', 'a.md')), before, 'the file was not touched');
  } finally {
    v.cleanup();
  }
});

/**
 * A diagonal drag on a matrix board crosses two axes and is still one gesture, so
 * it is one write. Two writes would read the card twice, bump `updated` twice and
 * let the second land on a card the first had already changed.
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
    assert.equal(res.changed, 1, 'one card, counted once however many axes moved');
    const after = facetsOf(v.root, 'a');
    assert.deepEqual(after.status, ['done']);
    assert.deepEqual(after.priority, ['month']);
    assert.deepEqual(after.tech, ['kafka'], 'and still only the facets it named');
  } finally {
    v.cleanup();
  }
});

/** Every axis is checked before any is written, so there is no half-moved card. */
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
    assert.deepEqual(facetsOf(v.root, 'a').priority, ['now'], 'and leaves the card alone');
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
    const base = mtimeOf(join(v.root, 'notes', 'a.md'));

    // An agent edits another axis. Within the guard's tolerance, so no conflict:
    // this is the race that has no 409 to catch it.
    writeFileSync(
      join(v.root, 'notes', 'a.md'),
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
    const base = mtimeOf(join(v.root, 'notes', 'a.md'));

    // The user's panel rendered with tech: [kafka]. An agent then adds one.
    writeFileSync(join(v.root, 'notes', 'a.md'), card('a', 'tech: [kafka, quarkus]'), 'utf8');

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
    const notes = readAll(join(v.root, 'notes')).notes;

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
    const file = join(v.root, 'notes', 'a.md');
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

// ---------------------------------------------------------------- assets

test('an asset is stored by content hash under its card, and its type is checked', () => {
  const v = vault({ a: card('a', 'priority: [now]') });
  try {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const first = saveAsset(v.root, 'a', 'image/png', png);
    // The path returned is relative to `cards/`, since that is where a card body
    // resolves it from.
    assert.match(first.path, /^assets\/a\/[0-9a-f]{12}\.png$/, first.path);
    assert.ok(existsSync(join(v.root, 'notes', first.path)), 'stored under cards/');

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
    assert.ok(!existsSync(join(v.root, 'notes', 'a.md')));
    assert.ok(existsSync(join(v.root, 'notes', 'b.md')));
  } finally {
    v.cleanup();
  }
});

test('linking bumps updated, and unlinking an absent ref refuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'projector-link-'));
  try {
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(
      join(root, 'notes', 'a.md'),
      '---\nid: a\ntitle: Card A\nupdated: 2020-01-01\n---\nbody\n',
      'utf8',
    );
    writeFileSync(join(root, 'facets.yaml'), 'status: { values: [planning, done] }\n', 'utf8');

    patchNote(root, 'a', { links: ['jira:FOO-1'] });
    const after = readFileSync(join(root, 'notes', 'a.md'), 'utf8');
    assert.match(after, /links: \[jira:FOO-1\]/);
    assert.doesNotMatch(after, /updated: 2020-01-01/, 'a write that leaves `updated` alone is the bug');
    assert.match(after, /updated: \d{4}-\d{2}-\d{2}/);

    // Emptying the array drops the key rather than storing `links: []`.
    patchNote(root, 'a', { links: [] });
    assert.doesNotMatch(readFileSync(join(root, 'notes', 'a.md'), 'utf8'), /links:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The gesture that meant two things.
 *
 * The board computed `nextValues` for one card and then threw it away whenever
 * more than one was selected, sending uniform values to the bulk endpoint
 * instead. Three of four gestures diverged and one *inverted*: shift-dragging
 * `now`→`month` took `now` off a single card and `month` off a batch. There is no
 * cardinality branch to test any more, so this asserts the property instead — the
 * intent carries endpoints, and one transform answers for every card.
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
 * cost, on the real vault: `readAll` measures around 31ms over 191 notes, and
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
      join(v.root, 'notes', 'holder.md'),
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
  const doc = readFileSync(new URL('../ARCHITECTURE.md', import.meta.url), 'utf8');
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
