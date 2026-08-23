import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseOf,
  bannerFor,
  busyLabel,
  classify,
  heldBase,
  idleStatus,
  labelFor,
  nextStatus,
  planWrite,
  type CardWrite,
} from '../src/web/panel/write.ts';

/**
 * The card panel's decisions.
 *
 * Every one of these was previously unreachable by a test — they lived inside a
 * 481-line component, behind a `run(label, fn)` that took an opaque thunk. Which
 * is why several of them had been wrong for a while and nothing said so.
 *
 * `write.ts` imports only types, so this loads under `node --test` with no DOM,
 * no `fetch` and no jsdom — the policy `test/client.test.ts` states.
 */

/** Every variant, so an added kind fails a test rather than slipping through. */
const EVERY: CardWrite[] = [
  { kind: 'facet', name: 'priority', values: ['now'], mode: 'set' },
  { kind: 'title', title: 'a title' },
  { kind: 'links', links: ['jira:PROJ-1'] },
  { kind: 'projectBlock', block: {} },
  { kind: 'body', body: 'text' },
  { kind: 'frontmatter', yaml: 'id: a\n' },
  { kind: 'delete' },
];

// ------------------------------------------------------------------ the gate

/**
 * The defect this file exists for. A write that can lose data must carry the
 * mtime it is gated on, and the panel had one that did not: the parent picker
 * went through the bulk endpoint, which has no base mtime and never calls
 * `guard`, so re-parenting silently overwrote a concurrent agent edit.
 *
 * Asserted over every variant rather than the one that was broken, because the
 * point is that there is no longer a place to put an unstamped write.
 */
test('every write that can lose data carries the base mtime', () => {
  for (const w of EVERY) {
    const p = planWrite(w, 1700);
    if (p.call === 'delete') continue; // no guard to satisfy on a file going away
    const base = p.call === 'patch' ? p.body.baseMtime : p.baseMtime;
    assert.equal(base, 1700, `${w.kind} must be gated`);
  }
});

test('the panel can name one facet and cannot express the whole map', () => {
  const p = planWrite({ kind: 'facet', name: 'priority', values: ['now'], mode: 'set' }, 1);
  assert.equal(p.call, 'patch');
  assert.deepEqual(p.call === 'patch' && p.body.facet, {
    name: 'priority',
    values: ['now'],
    mode: 'set',
  });
  assert.ok(p.call === 'patch' && !('facets' in p.body), 'the stale-map write is unproducible');
});

test('clearing a facet is expressible, since that is how an axis is removed', () => {
  const p = planWrite({ kind: 'facet', name: 'tech', values: [], mode: 'set' }, 1);
  // An omitted key would merge back from disk; naming it empty is what removes it.
  assert.deepEqual(p.call === 'patch' && p.body.facet, { name: 'tech', values: [], mode: 'set' });
});

/**
 * The last hole in the narrow write. Naming the axis stops a click on `status`
 * reverting `tech`; carrying the mode stops a click on `tech` reverting `tech`.
 * A toggle knows one value changed and nothing about the rest of the axis, so
 * `set` would be it asserting a fact it does not have.
 */
test('a toggle names the value it moved, not the axis it thinks it left behind', () => {
  for (const mode of ['add', 'remove'] as const) {
    const p = planWrite({ kind: 'facet', name: 'tech', values: ['kafka'], mode }, 1);
    assert.deepEqual(p.call === 'patch' && p.body.facet, {
      name: 'tech',
      values: ['kafka'],
      mode,
    });
  }
});

/** "The panel writes one card" as a property, not as a habit. */
test('no write plan reaches the bulk endpoint', () => {
  for (const w of EVERY) {
    assert.ok(['patch', 'frontmatter', 'delete'].includes(planWrite(w, 1).call), w.kind);
  }
});

test('the busy word follows the write, including which way the project toggle went', () => {
  assert.equal(labelFor({ kind: 'projectBlock', block: {} }), 'making a project');
  assert.equal(labelFor({ kind: 'projectBlock', block: null }), 'un-projecting');
  assert.equal(labelFor({ kind: 'facet', name: 'x', values: [], mode: 'set' }), 'saving facets');
  assert.equal(labelFor({ kind: 'delete' }), 'deleting');
});

// ----------------------------------------------------------------- the bases

/**
 * Both halves of `max` are a bug that has happened.
 *
 * Last-write-wins bricks the panel: once a write response is the base it never
 * yields to a fresher read, so an agent editing the card 409s everything and the
 * Reload button cannot recover it. Read-only is subtler — a second chip click
 * inside the reload window carries a pre-write mtime and 409s against the user's
 * own previous change.
 */
test('the base is the freshest of the last read and the last write, not the latest of them', () => {
  assert.equal(baseOf(2000, 1500), 2000, 'a reload landing after a write still wins');
  assert.equal(baseOf(1000, 1500), 1500, 'a write response is newer than the read before it');
  assert.equal(baseOf(null, 1500), 1500);
  assert.equal(baseOf(1000, null), 1000);
  assert.equal(baseOf(null, null), null, 'nothing is known before the first read lands');
});

/**
 * The one assertion standing between a dirty editor and destroying an agent's
 * work. The editor refuses to adopt an incoming document while dirty, so what is
 * on screen belongs to an older read — and its write has to say so.
 *
 * The `wrote` half is the other side of it, and it is here because leaving it out
 * was a reproducible trap with no second writer in it: type in the body, click any
 * chip, save — refused, because the panel had moved the file past a base it was
 * holding against itself. A chip, a rename, a link and a project block are the
 * only things this panel writes and none of them touches body bytes, so accepting
 * our own writes costs the document nothing. A foreign write arrives through
 * `read`, which stays frozen — the last case below is the one that matters.
 */
test('a body write is gated on the read its document came from', () => {
  assert.equal(heldBase(1000, 2000, true, null), 1000, 'held: the base does not move under the text');
  assert.equal(heldBase(1000, 2000, false, null), 2000, 'clean: it tracks the freshest read');
  assert.equal(heldBase(null, 2000, true, null), null);

  assert.equal(
    heldBase(1000, 2000, true, 1500),
    1500,
    'held: our own write advances it, or saving the body after clicking a chip is refused',
  );
  assert.equal(heldBase(1800, 2000, true, 1500), 1800, 'held: and never goes backwards');

  // The whole point, stated as a case: a foreign write lands in `read`, not in
  // `wrote`, so the base stays where the document came from and the write is
  // refused. `read` at 9000 is an agent; `wrote` at 1500 is us.
  assert.equal(
    heldBase(1000, 9000, true, 1500),
    1500,
    'held: a foreign read does not advance it, which is what makes the refusal happen',
  );

  // Assigned during render, so StrictMode applies it twice.
  for (const held of [true, false]) {
    for (const wrote of [null, 1500]) {
      assert.equal(
        heldBase(heldBase(1000, 2000, held, wrote), 2000, held, wrote),
        heldBase(1000, 2000, held, wrote),
      );
    }
  }
});

// --------------------------------------------------------------- one failure

test('a conflict is read off the error rather than stored beside it', () => {
  assert.deepEqual(classify({ message: 'file changed on disk', conflict: true }), {
    message: 'file changed on disk',
    conflict: true,
  });
  assert.deepEqual(classify({ message: 'title cannot be empty', status: 400 }), {
    message: 'title cannot be empty',
    conflict: false,
  });
  assert.deepEqual(classify(new TypeError('offline')), { message: 'offline', conflict: false });
});

/**
 * The exact sequence the two-flag version got wrong: a 409, then a validation
 * failure. `run` cleared `problem` and left `conflict` set, so an invalid value
 * was reported as "Changed on disk — probably a Claude session", with a Reload
 * button that fixed nothing.
 */
test('a validation failure after a conflict is not reported as a conflict', () => {
  let s = idleStatus();
  s = nextStatus(s, { t: 'start', seq: 1, label: 'saving facets' });
  s = nextStatus(s, { t: 'settled', seq: 1, failure: { message: 'file changed', conflict: true } });
  assert.deepEqual(bannerFor(s), {
    tone: 'conflict',
    message: 'file changed',
    canReload: true,
  });

  s = nextStatus(s, { t: 'start', seq: 2, label: 'renaming' });
  s = nextStatus(s, {
    t: 'settled',
    seq: 2,
    failure: { message: 'title cannot be empty', conflict: false },
  });
  assert.deepEqual(bannerFor(s), {
    tone: 'bad',
    message: 'title cannot be empty',
    canReload: false,
  });
});

test('a failure is superseded or reported, never dropped by someone else succeeding', () => {
  let s = idleStatus();
  s = nextStatus(s, { t: 'start', seq: 1, label: 'saving links' });
  s = nextStatus(s, { t: 'start', seq: 2, label: 'saving facets' });
  s = nextStatus(s, { t: 'settled', seq: 1, failure: { message: 'nope', conflict: false } });
  s = nextStatus(s, { t: 'settled', seq: 2, failure: null });
  assert.equal(s.failure?.message, 'nope', 'a later success does not clear an earlier failure');
  assert.deepEqual(s.pending, []);

  assert.equal(nextStatus(s, { t: 'dismiss' }).failure, null);
});

/** A write can settle after the panel has moved on — the race `useLive` also has. */
test('a write settling for a card the panel has left changes nothing', () => {
  const s = nextStatus(idleStatus(), { t: 'start', seq: 1, label: 'renaming' });
  const after = nextStatus(s, { t: 'settled', seq: 99, failure: { message: 'x', conflict: true } });
  assert.equal(after, s, 'an unknown seq is a no-op, not a banner on the wrong card');
});

test('the header names the newest write in flight, and nothing when idle', () => {
  let s = idleStatus();
  assert.equal(busyLabel(s), null);
  s = nextStatus(s, { t: 'start', seq: 1, label: 'saving links' });
  s = nextStatus(s, { t: 'start', seq: 2, label: 'renaming' });
  assert.equal(busyLabel(s), 'renaming');
  assert.equal(bannerFor(idleStatus()), null);
});
