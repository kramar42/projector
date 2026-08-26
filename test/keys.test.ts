import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYMAP,
  RESERVED,
  bind,
  inField,
  isKeyShaped,
  isReserved,
  type Command,
  type KeyContext,
  type KeyStroke,
  type Pending,
} from '../src/view/keys.ts';
import { DEPTH, emptyHistory, inverseOf, recorded, redone, undone, type Step } from '../src/view/undo.ts';
import { drawn, first, last, locate, stepped, type Grid } from '../src/web/views/motion.ts';

/**
 * The keyboard grammar.
 *
 * Every one of these runs without a DOM, which is the whole reason `bind` is a
 * pure function: there are forty bindings and a prefix state machine, and the
 * alternative is discovering that `⌥j` does nothing on a Mac by pressing it.
 */

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  facetKeys: { p: 'priority', s: 'status' },
  groupedAxis: 'status',
  inField: false,
  ...over,
});

/** A stroke, spelled the way a browser would spell it. */
function stroke(key: string, over: Partial<KeyStroke> = {}): KeyStroke {
  const code = /^[0-9]$/.test(key)
    ? `Digit${key}`
    : /^[a-zA-Z]$/.test(key)
      ? `Key${key.toUpperCase()}`
      : '';
  return {
    key,
    code,
    shiftKey: /^[A-Z]$/.test(key),
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...over,
  };
}

/**
 * The keydown a keyboard sends for the modifier itself.
 *
 * Holding ⇧ to type `,F` is three events, not two, and leaving the middle one out
 * is what let every shifted completion in the map look tested and be broken.
 */
const SHIFT: KeyStroke = {
  key: 'Shift',
  code: 'ShiftLeft',
  shiftKey: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
};

/** Press a run of keys from a cold start and return the last dispatch. */
function press(keys: (string | KeyStroke)[], c: KeyContext = ctx()) {
  let pending: Pending | null = null;
  let out = bind(pending, typeof keys[0] === 'string' ? stroke(keys[0]) : keys[0]!, c);
  pending = out.pending;
  for (const k of keys.slice(1)) {
    out = bind(pending, typeof k === 'string' ? stroke(k) : k, c);
    pending = out.pending;
  }
  return out;
}

const commandOf = (keys: (string | KeyStroke)[], c?: KeyContext): Command | null =>
  press(keys, c).command;

// ---------------------------------------------------------------- the reserved set

test('the map claims twelve letters, so a vault has fourteen', () => {
  assert.equal(RESERVED.length, 12);
  assert.equal(new Set(RESERVED).size, 12, 'no letter reserved twice');
  // The three regions of a card that `g` reaches. They have to be reserved
  // because `g` plus a letter is otherwise the axis namespace.
  for (const region of ['c', 'f', 'y']) assert.ok(isReserved(region), region);
});

test('reserving is case-folded, because H and J are bindings too', () => {
  assert.ok(isReserved('j'));
  assert.ok(isReserved('J'), 'J extends a selection, so j cannot be claimed as J either');
  assert.ok(isReserved('U'), 'redo');
  assert.ok(!isReserved('p'));
});

test("the rail's letters stay a vault's, because they sit behind a leader", () => {
  // `,f` and `,c` are absent: those letters are spent by `gf` and `gc`, which are
  // top-level completions of a prefix rather than leader rows.
  for (const behindTheLeader of ['s', 'v', 'w']) {
    assert.ok(!isReserved(behindTheLeader), `,${behindTheLeader} must not cost the bare letter`);
  }
});

test('a key is one letter, so no vault can claim a digit or a leader', () => {
  assert.ok(isKeyShaped('p'));
  assert.ok(!isKeyShaped('P'), 'declared lower-case, so the shifted form stays the map’s');
  assert.ok(!isKeyShaped('3'));
  assert.ok(!isKeyShaped(','));
  assert.ok(!isKeyShaped('pp'));
});

// ---------------------------------------------------------------- whose key is it

test('a browser chord is never ours', () => {
  assert.equal(bind(null, stroke('j', { metaKey: true }), ctx()).handled, false);
  assert.equal(bind(null, stroke('j', { ctrlKey: true }), ctx()).handled, false);
});

test('a key typed into a field belongs to the field', () => {
  assert.equal(bind(null, stroke('j'), ctx({ inField: true })).handled, false);
  assert.equal(bind(null, stroke('3'), ctx({ inField: true })).handled, false);
});

/**
 * The tempting exception, and the one that must not be made. The rail's search
 * clears itself on Escape and the panel's title editor abandons a rename — so an
 * app-level Escape would close the card you were renaming.
 */
test('a field owns every key it is given, Escape included', () => {
  assert.equal(bind(null, stroke('Escape'), ctx({ inField: true })).handled, false);
  assert.deepEqual(bind(null, stroke('Escape'), ctx()).command, { kind: 'escape' });
});

test('a field is a field however it says so', () => {
  assert.ok(inField({ tagName: 'INPUT' }));
  assert.ok(inField({ tagName: 'TEXTAREA' }));
  assert.ok(inField({ tagName: 'DIV', isContentEditable: true }));
  assert.ok(!inField({ tagName: 'DIV' }));
  assert.ok(!inField(null));
});

// ---------------------------------------------------------------- moving

test('hjkl move the cursor along the orderings a shape supplies', () => {
  assert.deepEqual(commandOf(['j']), { kind: 'move', along: 'row', delta: 1 });
  assert.deepEqual(commandOf(['k']), { kind: 'move', along: 'row', delta: -1 });
  assert.deepEqual(commandOf(['l']), { kind: 'move', along: 'column', delta: 1 });
  assert.deepEqual(commandOf(['h']), { kind: 'move', along: 'column', delta: -1 });
  assert.deepEqual(commandOf([']']), { kind: 'move', along: 'lane', delta: 1 });
});

test('gg is the first row and G the last', () => {
  assert.deepEqual(commandOf(['g', 'g']), { kind: 'moveTo', end: 'first' });
  assert.deepEqual(commandOf(['G']), { kind: 'moveTo', end: 'last' });
});

test('g alone consumes the key that follows rather than letting it act late', () => {
  const out = press(['g', 'j']);
  assert.equal(out.command, null);
  assert.equal(out.handled, true, 'a swallowed key must still be prevented from scrolling');
  assert.equal(out.pending, null);
});

test('H and L walk the trail of cards the cursor has visited', () => {
  assert.deepEqual(commandOf(['H']), { kind: 'trail', delta: -1 });
  assert.deepEqual(commandOf(['L']), { kind: 'trail', delta: 1 });
});

// ---------------------------------------------------------------- writing

test('a bare digit is the nth value of the axis you are grouped by', () => {
  assert.deepEqual(commandOf(['3']), { kind: 'setAxisValue', facet: 'status', ordinal: 3 });
});

/**
 * The shorthand is expanded here and nowhere else, which is what lets every
 * consumer treat a digit and a named axis identically.
 */
test('a bare digit and the axis key spelled out are the same command', () => {
  assert.deepEqual(commandOf(['3']), commandOf(['s', '3']));
});

test('0 clears the axis — the (none) column a drag already reaches', () => {
  assert.deepEqual(commandOf(['0']), { kind: 'setAxisValue', facet: 'status', ordinal: 0 });
});

test('an ungrouped board has no columns to number, so a digit means nothing', () => {
  const out = press(['3'], ctx({ groupedAxis: null }));
  assert.equal(out.command, null);
});

test('a facet key and a digit write that axis whether or not the card carries it', () => {
  assert.deepEqual(commandOf(['p', '4']), {
    kind: 'setAxisValue',
    facet: 'priority',
    ordinal: 4,
  });
});

test('an axis key doubled opens its control, whichever control its type picks', () => {
  assert.deepEqual(commandOf(['p', 'p']), { kind: 'openAxisControl', facet: 'priority' });
});

test('an axis key followed by anything else takes the same fallback', () => {
  assert.deepEqual(commandOf(['p', 'z']), { kind: 'openAxisControl', facet: 'priority' });
});

test('escape abandons a half-typed sequence instead of closing anything', () => {
  const out = press(['p', 'Escape']);
  assert.equal(out.command, null);
  assert.equal(out.pending, null);
});

/**
 * ⇧8 is `*`. Binding the shifted digit row would have cost the punctuation, which
 * is why the lane axis is reached through its own `key:` instead.
 */
test('a shifted digit is punctuation, not an ordinal', () => {
  assert.deepEqual(commandOf([stroke('*', { code: 'Digit8', shiftKey: true })]), {
    kind: 'select',
    how: 'all',
  });
});

test('a vault cannot shadow the map, because the map is read first', () => {
  const c = ctx({ facetKeys: { j: 'nonsense' } });
  assert.deepEqual(commandOf(['j'], c), { kind: 'move', along: 'row', delta: 1 });
});

// ---------------------------------------------------------------- choosing

test('x picks a card out and J K extend the run', () => {
  assert.deepEqual(commandOf(['x']), { kind: 'select', how: 'toggle' });
  assert.deepEqual(commandOf(['J']), { kind: 'select', how: 'extend', delta: 1 });
  assert.deepEqual(commandOf(['K']), { kind: 'select', how: 'extend', delta: -1 });
});

// ---------------------------------------------------------------- undo

test('u undoes and U redoes, one hand and no modifier', () => {
  assert.deepEqual(commandOf(['u']), { kind: 'undo' });
  assert.deepEqual(commandOf(['U']), { kind: 'redo' });
});

// ---------------------------------------------------------------- ⌥

/**
 * The bug this pins is invisible on Linux: macOS turns ⌥1 into `¡` and ⌥j into
 * `∆`, so every modified binding in the map is unreachable through `event.key`.
 */
test('⌥ reads the physical key, because macOS rewrites the character', () => {
  const optOne = stroke('¡', { code: 'Digit1', altKey: true });
  assert.deepEqual(bind(null, optOne, ctx()).command, { kind: 'view', ordinal: 1 });

  const optJ = stroke('∆', { code: 'KeyJ', altKey: true });
  assert.deepEqual(bind(null, optJ, ctx()).command, { kind: 'reorder', delta: 1 });
});

test('⌥0 is not a view, because saved views are counted from one', () => {
  const out = bind(null, stroke('º', { code: 'Digit0', altKey: true }), ctx());
  assert.equal(out.command, null);
});

// ---------------------------------------------------------------- the rail

/**
 * The bug this pins: a modifier arrives as its own `keydown`, so it used to be
 * fed to the pending sequence, match nothing, and clear it.
 */
test('holding shift does not abandon the sequence it is being held for', () => {
  assert.deepEqual(commandOf([',', SHIFT, stroke('G')]), { kind: 'rail', control: 'thenBy' });
  assert.deepEqual(commandOf([',', SHIFT, stroke('F')]), { kind: 'rail', control: 'filter' });
  assert.deepEqual(commandOf(['g', SHIFT, stroke('P')]), {
    kind: 'gotoInverse',
    facet: 'priority',
  });
  // And the modifier alone is not a stroke the app claims.
  assert.equal(bind(null, SHIFT, ctx()).handled, false);
});

test('the leader reaches a rail row in two keystrokes', () => {
  assert.deepEqual(commandOf([',', 'v']), { kind: 'rail', control: 'view' });
  assert.deepEqual(commandOf([',', 's']), { kind: 'rail', control: 'shape' });
  assert.deepEqual(commandOf([',', 'c']), { kind: 'rail', control: 'clear' });
});

test('a rail row that takes an axis writes it outright', () => {
  assert.deepEqual(commandOf([',', 'g', 'p']), {
    kind: 'rail',
    control: 'group',
    facet: 'priority',
  });
  assert.deepEqual(commandOf([',', 'o', 's']), {
    kind: 'rail',
    control: 'sort',
    facet: 'status',
  });
});

/**
 * `,g` used to do nothing until a second key arrived, and then swallow it. The
 * row is reached on the prefix now, so the axis letter is a shortcut rather than
 * a requirement.
 */
test('a rail row that takes an axis is reached on the leader, not on the letter', () => {
  const out = press([',', 'g']);
  assert.deepEqual(out.command, { kind: 'rail', control: 'group' });
  assert.deepEqual(out.pending, { kind: 'railAxis', control: 'group' });
});

test('a key that is not an axis letter goes back to meaning what it means', () => {
  // `,g` has already focused the control, so this `j` steps it rather than being
  // eaten by a fallback with nothing left to do.
  assert.deepEqual(commandOf([',', 'g', 'j']), { kind: 'move', along: 'row', delta: 1 });
  // And an unbound letter is simply unbound, rather than re-firing the row.
  assert.equal(press([',', 'g', 'z']).command, null);
});

test('an unknown leader letter means nothing and says so', () => {
  const out = press([',', 'q']);
  assert.equal(out.command, null);
  assert.equal(out.pending, null);
});

// ---------------------------------------------------------------- the rest

test('the singles', () => {
  assert.deepEqual(commandOf(['/']), { kind: 'search' });
  assert.deepEqual(commandOf(['?']), { kind: 'help' });
  assert.deepEqual(commandOf(['.']), { kind: 'palette' });
  assert.deepEqual(commandOf(['n']), { kind: 'newCard' });
  assert.deepEqual(commandOf(['o']), { kind: 'open' });
  assert.deepEqual(commandOf(['Enter']), { kind: 'open' });
});

test('an unbound key is left alone', () => {
  assert.equal(bind(null, stroke('q'), ctx({ facetKeys: {} })).handled, false);
});

// ---------------------------------------------------------------- starting work

test('`!` starts work, and is a stroke no vocabulary can reach', () => {
  assert.deepEqual(bind(null, stroke('!'), ctx({ facetKeys: {} })).command, { kind: 'work' });
  // The whole argument for the mark over a letter: a vault claiming every letter
  // it is allowed to still cannot shadow it, because a key is one letter a-z.
  assert.ok(!isKeyShaped('!'));
  const everyLetter = Object.fromEntries(
    'abcdefghijklmnopqrstuvwxyz'.split('').map((k) => [k, `axis_${k}`]),
  );
  assert.deepEqual(bind(null, stroke('!'), ctx({ facetKeys: everyLetter })).command, { kind: 'work' });
});

test('starting work cost the reserved set nothing', () => {
  // `w` in particular. The seeded vocabulary spends it on `waiting_on` and `,w`
  // is the Focus row, which is why the binding is not `g w`.
  assert.ok(!isReserved('w'));
  assert.deepEqual(
    bind({ kind: 'goto', fallback: null }, stroke('w'), ctx({ facetKeys: { w: 'waiting_on' } })).command,
    { kind: 'gotoRef', facet: 'waiting_on' },
  );
});

test('a prefix swallows `!` rather than starting work mid-sequence', () => {
  // `g` then `!` is not a region and not an axis, so it produces nothing — and
  // must not fall through to launching, which would make an abandoned `g` a
  // keystroke that creates worktrees.
  assert.equal(bind({ kind: 'goto', fallback: null }, stroke('!'), ctx({ facetKeys: {} })).command, null);
});

// ---------------------------------------------------------------- the cheatsheet

/**
 * `?` renders from `KEYMAP`, so the one failure worth guarding is the cheatsheet
 * describing a key the dispatcher does not produce. The two are not derived from
 * one another — `bind` resolves things a table cannot express — so this holds the
 * table's *unmodified single keys* against it, which is the half that can be
 * checked mechanically.
 */
test('every plain key the cheatsheet lists actually does something', () => {
  // Whole rows, not loose tokens. A row is either plain or it is a sequence —
  // `, v` splits into a leader and a letter that means nothing on its own, and
  // reading it as two keys is how this test first failed.
  // A row is a *sequence* when it starts with a prefix, and its letters mean
  // nothing on their own: `, v` is the rail leader and `g f` is a region of the
  // note. Reading either as two independent keys is how this test first failed.
  const isSequence = (keys: string) => /^(,|g) /.test(keys);
  const plainRows = KEYMAP.flatMap((s) => s.rows).filter(
    (r) => !isSequence(r.keys) && /^[a-zA-Z./?*![\]](\s[a-zA-Z./?*![\]])*$/.test(r.keys),
  );
  const singles = plainRows.flatMap((r) => r.keys.split(' '));
  assert.ok(singles.length > 10, 'the map should be mostly single keys');
  for (const key of singles) {
    const out = bind(null, stroke(key), ctx({ facetKeys: {} }));
    assert.ok(out.handled, `the cheatsheet lists "${key}" but the dispatcher ignores it`);
  }
});

test('the cheatsheet has a row for every section a reader would look under', () => {
  assert.deepEqual(
    KEYMAP.map((s) => s.section),
    ['The cursor', 'Into a note', 'In a list', 'Choosing', 'Writing', 'The view'],
  );
  for (const section of KEYMAP) assert.ok(section.rows.length > 0, section.section);
});

// ---------------------------------------------------------------- moving over a grid

/**
 * A board: two lanes, three columns, one of them declared and empty.
 *
 *        c0          c1        c2
 *   l0   a b c       —         d
 *   l1   e           f g       —
 */
const board: Grid = {
  cells: [
    [['a', 'b', 'c'], [], ['d']],
    [['e'], ['f', 'g'], []],
  ],
  columns: ['now', 'month', 'backlog'],
  continuous: false,
};

/** A table: one lane, three sections, read as one list down the page. */
const table: Grid = {
  cells: [[['a', 'b'], ['c'], ['d', 'e']]],
  columns: ['now', 'month', 'backlog'],
  continuous: true,
};

test('a card knows where it sits, and a card that is not drawn does not', () => {
  assert.deepEqual(locate(board, 'g'), [1, 1, 1]);
  assert.deepEqual(locate(board, 'nowhere'), null);
  assert.deepEqual(drawn(board), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('j and k walk a column and stop at its ends on a board', () => {
  assert.equal(stepped(board, 'a', 'row', 1), 'b');
  assert.equal(stepped(board, 'c', 'row', 1), null, 'a column has a visible end');
  assert.equal(stepped(board, 'a', 'row', -1), null);
});

/** A section heading is a divider, not a wall — which is what the eye already does. */
test('j runs through a section boundary on a table', () => {
  assert.equal(stepped(table, 'b', 'row', 1), 'c');
  assert.equal(stepped(table, 'c', 'row', 1), 'd');
  assert.equal(stepped(table, 'd', 'row', -1), 'c');
  assert.equal(stepped(table, 'e', 'row', 1), null, 'the end of the list is the end');
});

/**
 * A board keeps a declared column with nothing in it because it is somewhere to
 * drag *to*. There is nothing in it to put a cursor *on*.
 */
test('l steps over an empty column rather than stopping in front of it', () => {
  assert.equal(stepped(board, 'a', 'column', 1), 'd', 'c1 is empty in this lane');
  assert.equal(stepped(board, 'd', 'column', -1), 'a');
  assert.equal(stepped(board, 'd', 'column', 1), null, 'and the board has an edge');
});

test('crossing a column keeps the position, clamped to what is there', () => {
  // From the third card of a three-card column into a one-card column.
  assert.equal(stepped(board, 'c', 'column', 1), 'd');
  // And back, landing on the last of the longer column rather than the third.
  assert.equal(stepped(board, 'f', 'lane', -1), null, 'c1 is empty in lane 0');
  assert.equal(stepped(board, 'e', 'lane', -1), 'a');
});

test('the first keystroke of a session lands somewhere rather than nowhere', () => {
  assert.equal(stepped(board, null, 'row', 1), 'a');
  assert.equal(stepped(board, null, 'column', -1), 'a');
  assert.equal(first(board), 'a');
  assert.equal(last(board), 'g');
});

/**
 * Following a reference can leave the cursor on a card the query does not draw.
 * Motion is what re-enters the view, so the failure mode is "the cursor goes
 * home" rather than "the arrow keys stopped working".
 */
test('a cursor on a card the view does not draw re-enters at the top', () => {
  assert.equal(stepped(board, 'elsewhere', 'row', 1), 'a');
});

test('an empty grid has nowhere to go, and says so without throwing', () => {
  const canvas: Grid = { cells: [], columns: [], continuous: false };
  assert.equal(stepped(canvas, null, 'row', 1), null);
  assert.equal(first(canvas), null);
  assert.deepEqual(drawn(canvas), []);
});

// ---------------------------------------------------------------- undo

/**
 * The inverse table, which is the whole of whether `u` is trustworthy.
 *
 * The delta cases are the interesting ones: they read no prior state, so they
 * cannot be wrong about it and they compose with whatever else wrote to the axis
 * in between — an agent, another window. Only `set` has to remember, and it is
 * the one case where a concurrent write can be clobbered.
 */
test('a delta inverts to the opposite delta, without reading anything', () => {
  const never = () => {
    throw new Error('a delta inverse must not read prior state');
  };
  assert.deepEqual(inverseOf({ ids: ['a'], facet: 'tech', values: ['k8s'], mode: 'add' }, never), [
    { ids: ['a'], facet: 'tech', values: ['k8s'], mode: 'remove' },
  ]);
  assert.deepEqual(inverseOf({ ids: ['a'], facet: 'tech', values: ['k8s'], mode: 'remove' }, never), [
    { ids: ['a'], facet: 'tech', values: ['k8s'], mode: 'add' },
  ]);
});

test('setting an axis inverts to each card’s own prior values', () => {
  const before: Record<string, string[]> = { a: ['now'], b: ['month'], c: [] };
  const back = inverseOf(
    { ids: ['a', 'b', 'c'], facet: 'priority', values: ['backlog'], mode: 'set' },
    (id) => before[id] ?? [],
  );
  assert.deepEqual(back.sort((x, y) => x.ids[0]!.localeCompare(y.ids[0]!)), [
    { ids: ['a'], facet: 'priority', values: ['now'], mode: 'set' },
    { ids: ['b'], facet: 'priority', values: ['month'], mode: 'set' },
    // A card that carried nothing is restored to nothing, not skipped — otherwise
    // undoing a bulk write leaves the axis set on whatever had been empty.
    { ids: ['c'], facet: 'priority', values: [], mode: 'set' },
  ]);
});

/** Twelve cards that agreed are one request, not twelve. */
test('cards that shared a prior value are put back together', () => {
  const back = inverseOf(
    { ids: ['a', 'b', 'c'], facet: 'status', values: ['done'], mode: 'set' },
    (id) => (id === 'c' ? ['planning'] : ['active']),
  );
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], { ids: ['a', 'b'], facet: 'status', values: ['active'], mode: 'set' });
});

test('the stacks behave the way every editor’s do', () => {
  const step = (label: string): Step => ({ forward: [], back: [], label });
  let h = recorded(recorded(emptyHistory(), step('one')), step('two'));
  assert.deepEqual(h.done.map((s) => s.label), ['one', 'two']);

  const back = undone(h)!;
  assert.equal(back.step.label, 'two');
  assert.deepEqual(back.history.done.map((s) => s.label), ['one']);
  assert.deepEqual(back.history.undone.map((s) => s.label), ['two']);

  const forward = redone(back.history)!;
  assert.equal(forward.step.label, 'two');
  assert.deepEqual(forward.history.undone, []);

  // A new write abandons the redo stack: a forward that leads somewhere you did
  // not come from is worse than no forward.
  assert.deepEqual(recorded(back.history, step('three')).undone, []);
  assert.equal(undone(emptyHistory()), null);
  assert.equal(redone(emptyHistory()), null);
});

test('the stack is capped, because git is what remembers Tuesday', () => {
  let h = emptyHistory();
  for (let i = 0; i < DEPTH + 10; i++) h = recorded(h, { forward: [], back: [], label: `${i}` });
  assert.equal(h.done.length, DEPTH);
  assert.equal(h.done[0]!.label, '10', 'the oldest fall off the front');
});

// ---------------------------------------------------------------- going somewhere

/**
 * The gap that made `H` useless: a keyboard could reach every card the view drew
 * and no card it did not, so the only way out of a card was the mouse.
 */
test('g plus an axis key follows that axis, and shifted follows it back', () => {
  assert.deepEqual(commandOf(['g', 'p']), { kind: 'gotoRef', facet: 'priority' });
  assert.deepEqual(commandOf([stroke('P')], ctx()), null, 'only behind the prefix');
  assert.deepEqual(commandOf(['g', stroke('P')]), { kind: 'gotoInverse', facet: 'priority' });
  assert.deepEqual(commandOf(['g', 'l']), { kind: 'gotoRegion', region: 'links' });
});

/**
 * A region beats an axis, which is only honest because the letters are reserved:
 * read the other way round a vault would shadow one silently.
 */
test('the shifted region is the door rather than the room', () => {
  // `gf` walks the rows a card has; `gF` opens the list of the ones it has not.
  assert.deepEqual(commandOf(['g', SHIFT, stroke('F')]), {
    kind: 'gotoRegion',
    region: 'addFacet',
  });
});

test(', O flips the sort without touching what is sorted by', () => {
  assert.deepEqual(commandOf([',', SHIFT, stroke('O')]), { kind: 'rail', control: 'sortDir' });
  assert.deepEqual(commandOf([',', 'o']), { kind: 'rail', control: 'sort' });
});

test('g plus a region letter reaches part of the card', () => {
  assert.deepEqual(commandOf(['g', 'f']), { kind: 'gotoRegion', region: 'facets' });
  assert.deepEqual(commandOf(['g', 'c']), { kind: 'gotoRegion', region: 'body' });
  assert.deepEqual(commandOf(['g', 'y']), { kind: 'gotoRegion', region: 'frontmatter' });
  const claimed = ctx({ facetKeys: { f: 'nonsense', c: 'nonsense' } });
  assert.deepEqual(commandOf(['g', 'f'], claimed), { kind: 'gotoRegion', region: 'facets' });
});

test('gg still means the first row, and the prefix costs no top-level key', () => {
  assert.deepEqual(commandOf(['g', 'g']), { kind: 'moveTo', end: 'first' });
  // `g` is reserved, so no vault can declare it and shadow this.
  assert.ok(isReserved('g'));
});

test('a vault that declares no keys simply has no gotos', () => {
  const bare = ctx({ facetKeys: {} });
  assert.equal(commandOf(['g', 'p'], bare), null);
  assert.deepEqual(
    commandOf(['g', 'l'], bare),
    { kind: 'gotoRegion', region: 'links' },
    'a region is not a facet',
  );
});
