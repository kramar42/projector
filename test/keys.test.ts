import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTS,
  BINDINGS,
  CHEATSHEET_IDS,
  PALETTE,
  paletteFor,
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
import { DEPTH as TRAIL_DEPTH, back, emptyTrail, forward, jumped } from '../src/view/trail.ts';
import {
  drawn,
  first,
  idAt,
  isCursorAt,
  last,
  locate,
  stepped,
  steppedTo,
  type Grid,
  type Spot,
} from '../src/web/views/motion.ts';

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
  // The three regions of a note that `g` reaches. They have to be reserved
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
 * app-level Escape would close the note you were renaming.
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

test('H and L walk the trail of notes the cursor has visited', () => {
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

test('a facet key and a digit write that axis whether or not the note carries it', () => {
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
test('⌥ falls back to the physical key, because macOS rewrites the character', () => {
  const optOne = stroke('¡', { code: 'Digit1', altKey: true });
  assert.deepEqual(bind(null, optOne, ctx()).command, { kind: 'view', ordinal: 1 });

  const optJ = stroke('∆', { code: 'KeyJ', altKey: true });
  assert.deepEqual(bind(null, optJ, ctx()).command, { kind: 'reorder', delta: 1 });
});

test('⌥ letter commands follow the active keyboard layout, while ⌥ numbers remain physical', () => {
  const dvorakJ = stroke('∆', { code: 'KeyC', altKey: true, layoutKey: 'j' });
  const dvorakH = stroke('∆', { code: 'KeyJ', altKey: true, layoutKey: 'h' });
  const optionOne = stroke('¡', { code: 'Digit1', altKey: true, layoutKey: '1' });

  assert.deepEqual(bind(null, dvorakJ, ctx()).command, { kind: 'reorder', delta: 1 });
  assert.equal(bind(null, dvorakH, ctx()).command, null, 'the Dvorak H key is not ⌥J');
  assert.deepEqual(bind(null, optionOne, ctx()).command, { kind: 'view', ordinal: 1 });
});

test('⌥0 is not a view, because saved views are counted from one', () => {
  const out = bind(null, stroke('º', { code: 'Digit0', altKey: true }), ctx());
  assert.equal(out.command, null);
});

test('the palette reaches every named action that has no key', () => {
  const acts = new Set(ACTS.map((act) => act.command.kind));
  for (const action of [
    'clearSelection',
    'calendarPage',
    'canvasAction',
    'saveAsView',
    'revertView',
    'blankView',
  ] satisfies Command['kind'][]) {
    assert.ok(acts.has(action), `${action} is clickable but absent from the command palette`);
  }
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

test('the shape layer sets a projection directly', () => {
  const reached = press([',', 's']);
  assert.deepEqual(reached.command, { kind: 'rail', control: 'shape' });
  assert.deepEqual(reached.pending, { kind: 'railShape' });

  assert.deepEqual(commandOf([',', 's', 't']), { kind: 'setShape', shape: 'table' });
  assert.deepEqual(commandOf([',', 's', 'b']), { kind: 'setShape', shape: 'board' });
  assert.deepEqual(commandOf([',', 's', 'c']), { kind: 'setShape', shape: 'calendar' });
  assert.deepEqual(commandOf([',', 's', 'g']), { kind: 'setShape', shape: 'graph' });
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
  assert.deepEqual(commandOf(['Enter']), { kind: 'take' });
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
    ['The cursor', 'Into a note', 'In a list', 'Choosing', 'Pins', 'Writing', 'The view'],
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

/**
 * A note drawn twice is one cursor and two elements.
 *
 * The views used to ask `cursor === id`, which is true of every placement — so
 * each drew a ring, each took a tab stop, and each ran its own `scrollIntoView`
 * on the same commit. The last in DOM order won, which on a wide board is a jump
 * to the rightmost copy with the keyboard's own card left off-screen.
 */
test('exactly one placement of a repeated note is the cursor', () => {
  // `a` in two columns of one lane, the way a facet with two values draws it.
  const twice: Grid = {
    cells: [[['a', 'b'], ['a', 'c']]],
    columns: ['now', 'month'],
    continuous: false,
  };

  // `locate` picks the first, and always did — every step is computed from it.
  assert.deepEqual(locate(twice, 'a'), [0, 0, 0]);

  const spot = locate(twice, 'a');
  assert.equal(isCursorAt(spot, 0, 0, 0), true, 'the placement locate names');
  assert.equal(isCursorAt(spot, 0, 1, 0), false, 'the other one is an echo, not a cursor');

  // Exactly one, swept over the whole grid rather than asserted on two cells.
  let cursors = 0;
  twice.cells.forEach((lane, l) =>
    lane.forEach((col, c) => col.forEach((_, r) => { if (isCursorAt(spot, l, c, r)) cursors++; })),
  );
  assert.equal(cursors, 1);

  assert.equal(isCursorAt(null, 0, 0, 0), false, 'no cursor is no placement');
});

/**
 * And the second placement is reachable, which for a while it was not.
 *
 * `locate` answering "the first" unconditionally made the echo a place the
 * cursor could be *put* but never *be*: a click set the id, the next render
 * resolved it back to the first copy, and the ring jumped across the board —
 * so `j` then walked the column you had just clicked away from.
 *
 * The hint is deliberately weak. It holds only while the cell it names still
 * carries the note, so everything the cursor's own comment claims about an id
 * surviving a regroup survives with it.
 */
test('the copy the cursor was put on is the copy it stays on', () => {
  const twice: Grid = {
    cells: [[['a', 'b'], ['a', 'c']]],
    columns: ['now', 'month'],
    continuous: false,
  };

  const echo: Spot = [0, 1, 0];
  assert.deepEqual(locate(twice, 'a', echo), echo, 'the hinted copy wins');
  assert.equal(isCursorAt(locate(twice, 'a', echo), 0, 0, 0), false, 'the first one is the echo now');

  // And stepping from it stays in that column rather than in the other copy's.
  assert.deepEqual(steppedTo(twice, echo, 'row', 1), [0, 1, 1], 'j walks the column you are in');
  assert.equal(idAt(twice, steppedTo(twice, echo, 'row', 1)), 'c');
  assert.equal(stepped(twice, 'a', 'row', 1), 'b', 'and without a hint, the first copy as before');

  // A hint the grid has outgrown is dropped rather than honoured.
  const moved: Grid = { ...twice, cells: [[['a', 'b'], ['c']]] };
  assert.deepEqual(locate(moved, 'a', echo), [0, 0, 0], 'the cell no longer holds it');
  const gone: Grid = { ...twice, cells: [[['b'], ['a']]] };
  assert.deepEqual(locate(gone, 'a', echo), [0, 1, 0], 'it moved within the hinted cell');
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

test('setting an axis inverts to each note’s own prior values', () => {
  const before: Record<string, string[]> = { a: ['now'], b: ['month'], c: [] };
  const back = inverseOf(
    { ids: ['a', 'b', 'c'], facet: 'priority', values: ['backlog'], mode: 'set' },
    (id) => before[id] ?? [],
  );
  assert.deepEqual(back.sort((x, y) => x.ids[0]!.localeCompare(y.ids[0]!)), [
    { ids: ['a'], facet: 'priority', values: ['now'], mode: 'set' },
    { ids: ['b'], facet: 'priority', values: ['month'], mode: 'set' },
    // A note that carried nothing is restored to nothing, not skipped — otherwise
    // undoing a bulk write leaves the axis set on whatever had been empty.
    { ids: ['c'], facet: 'priority', values: [], mode: 'set' },
  ]);
});

/** Twelve notes that agreed are one request, not twelve. */
test('notes that shared a prior value are put back together', () => {
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
 * The gap that made `H` useless: a keyboard could reach every note the view drew
 * and no note it did not, so the only way out of a note was the mouse.
 */
test('g plus an axis key follows that axis, and shifted follows it back', () => {
  assert.deepEqual(commandOf(['g', 'p']), { kind: 'gotoRef', facet: 'priority' });
  assert.deepEqual(commandOf(['g', stroke('P')]), { kind: 'gotoInverse', facet: 'priority' });
  assert.deepEqual(commandOf(['g', 'l']), { kind: 'gotoRegion', region: 'links' });
});

/**
 * The folded dock's keyboard address.
 *
 * Reachable behind `g` and costing the vocabulary nothing, which is the whole
 * argument for spending brackets on it: `isKeyShaped` refuses any `key:` that is
 * not a bare letter, so no vault can declare `[`, and unlike the region letters
 * these need no line in `RESERVED` to be safe. Asserted from both sides — the
 * pair reaches the command, and the bare strokes still mean what they meant.
 */
test('g bracket steps the pin ring, and costs the vocabulary nothing', () => {
  assert.deepEqual(commandOf(['g', '[']), { kind: 'pinStep', delta: -1 });
  assert.deepEqual(commandOf(['g', ']']), { kind: 'pinStep', delta: 1 });

  // Unprefixed they are still lane motion, on every vault: a mark cannot be an
  // axis key, so this cannot be shadowed and cannot shadow.
  assert.deepEqual(commandOf(['[']), { kind: 'move', along: 'lane', delta: -1 });
  assert.deepEqual(commandOf([']']), { kind: 'move', along: 'lane', delta: 1 });
  assert.ok(!RESERVED.includes('['), 'a mark never needs reserving; `isKeyShaped` already refuses it');
  assert.ok(!isKeyShaped('['), 'and this is why');
});

/**
 * The shifted axis letter, without the prefix.
 *
 * This line used to assert `null` — "only behind the prefix" — and it was pinning
 * an accident rather than a decision. `g⇧⟨key⟩` prefers the drawn row when the
 * panel has one, so the *reshape* was reachable only when the row was absent, and
 * a project's sixty members are exactly the case that draws a row. The one list
 * worth turning into a query was the one the keyboard could not ask for.
 *
 * The stroke was free by construction, which is the whole argument for spending
 * it here: the bare uppercase letters `start` binds are `G H L J K U`, each the
 * shifted form of a letter already in `RESERVED`, so no legal `key:` can have a
 * shifted form the map has taken. Asserted below rather than reasoned about, on
 * both sides — an axis letter reaches the command, and a letter no vault declared
 * still reaches nothing.
 */
test('a shifted axis letter alone makes the other end the view', () => {
  assert.deepEqual(commandOf([stroke('P')], ctx()), { kind: 'focusInverse', facet: 'priority' });

  // Folded to find the axis, but not folded *before* deciding: `p` and `⇧P` are
  // two strokes with two meanings, and one table serves both. `p` alone is still a
  // prefix awaiting a digit, so it is the double-tap that reaches the control —
  // which is the namespace this borrows a letter from.
  assert.deepEqual(commandOf(['p'], ctx()), null, 'a prefix, not a command');
  assert.deepEqual(commandOf(['p', 'p'], ctx()), { kind: 'openAxisControl', facet: 'priority' });

  // A letter no vault declared stays unbound rather than falling through to
  // something. `z` is not in `RESERVED` and not an axis key here.
  assert.deepEqual(commandOf([stroke('Z')], ctx()), null);

  // And the map's own shifted letters are unreachable this way, because the
  // switch claims them first — `U` is redo, not an axis whose key is `u`.
  assert.deepEqual(commandOf([stroke('U')], ctx()), { kind: 'redo' });
});

/**
 * A region beats an axis, which is only honest because the letters are reserved:
 * read the other way round a vault would shadow one silently.
 */
test('the shifted region is the door rather than the room', () => {
  // `gf` walks the rows a note has; `gF` opens the list of the ones it has not.
  assert.deepEqual(commandOf(['g', SHIFT, stroke('F')]), {
    kind: 'gotoRegion',
    region: 'addFacet',
  });
});

test(', O flips the sort without touching what is sorted by', () => {
  assert.deepEqual(commandOf([',', SHIFT, stroke('O')]), { kind: 'rail', control: 'sortDir' });
  assert.deepEqual(commandOf([',', 'o']), { kind: 'rail', control: 'sort' });
});

test('g plus a region letter reaches part of the note', () => {
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

// ----------------------------------------------------------------- the trail

/**
 * `H` and `L`, which are a jumplist and not a history.
 *
 * The rules were all implemented and none of them asserted, which is how the
 * most visible one stayed broken: a jump *from nowhere* records nothing, and a
 * cold `?note=` load left the cursor unset — so the first reference followed
 * from a shared link pushed nothing and `H` did not come back. Every case below
 * is one a reader hits.
 */
const walk = (trail: ReturnType<typeof emptyTrail>, at: string | null, delta: 1 | -1) =>
  (delta === -1 ? back : forward)(trail, at);

test('the trail records where you left, and walks back through it', () => {
  let t = emptyTrail();
  t = jumped(t, 'a', 'b');
  t = jumped(t, 'b', 'c');
  assert.deepEqual(t.behind, ['a', 'b']);

  const first = walk(t, 'c', -1)!;
  assert.equal(first.to, 'b', 'H is the note you came from');
  const second = walk(first.trail, 'b', -1)!;
  assert.equal(second.to, 'a');
  assert.equal(walk(second.trail, 'a', -1), null, 'and it stops rather than wrapping');

  // Forward is the same move with the stacks swapped, which is the whole reason
  // one function serves both.
  assert.equal(walk(second.trail, 'a', 1)!.to, 'b');
});

test('a jump from nowhere records nothing, because there is nowhere to come back to', () => {
  // The shared-link case exactly: no cursor yet, then a reference is followed.
  const t = jumped(emptyTrail(), null, 'b');
  assert.deepEqual(t.behind, [], 'a first jump in a fresh session leaves no mark');
  assert.equal(walk(t, 'b', -1), null, 'so H has nothing to do, and says so by doing nothing');
});

test('landing where you already are is not a jump', () => {
  const t = jumped(emptyTrail(), 'a', 'a');
  assert.deepEqual(t.behind, [], 'clicking the card under the cursor may not fill the trail');
});

test('a new jump abandons forward, as it does in a browser', () => {
  let t = jumped(jumped(emptyTrail(), 'a', 'b'), 'b', 'c');
  const backOnce = walk(t, 'c', -1)!;
  assert.deepEqual(backOnce.trail.ahead, ['c'], 'L would return');
  t = jumped(backOnce.trail, 'b', 'd');
  assert.deepEqual(t.ahead, [], 'and then it would not: you never went to c from d');
});

test('the trail is capped, and the cap drops the oldest rather than refusing the newest', () => {
  let t = emptyTrail();
  for (let i = 0; i <= TRAIL_DEPTH + 10; i++) t = jumped(t, `n${i}`, `n${i + 1}`);
  assert.equal(t.behind.length, TRAIL_DEPTH);
  assert.equal(t.behind[t.behind.length - 1], `n${TRAIL_DEPTH + 10}`, 'the newest survives');
  assert.equal(t.behind[0], `n${11}`, 'the oldest is what goes');
});

// ------------------------------------------------------- keyboard parity

/**
 * The two halves of the grammar have to agree, and neither can see the other.
 *
 * `keys.ts` decides what a stroke *means* and `App.tsx` decides what that does,
 * which is the split that makes the first half testable at all. The cost is that
 * a command can be emitted and never acted on: `bind` returned `openAxisControl`,
 * `newCard` and `reorder` for months while the dispatcher had no case for them,
 * so the keys were live, silent, and documented as working.
 *
 * Read from source rather than imported, the way `theme.test.ts` reads the
 * stylesheet: `App.tsx` is a React component that reaches for `window` on the way
 * in, and there is no jsdom here on purpose.
 */
const SRC = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

/** The `Command` union alone — `Pending` below it is the prefix machine's own. */
function commandKinds(): Set<string> {
  const src = SRC('../src/view/keys.ts');
  const from = src.indexOf('export type Command =');
  const to = src.indexOf('export type Pending =');
  assert.ok(from > 0 && to > from, 'the Command union moved');
  return new Set([...src.slice(from, to).matchAll(/kind: '([a-zA-Z]+)'/g)].map((m) => m[1]!));
}

test('every command the grammar emits is one the dispatcher acts on', () => {
  const handled = new Set(
    [...SRC('../src/web/App.tsx').matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]!),
  );
  /**
   * Empty, and worth keeping as a set rather than deleting.
   *
   * `palette` lived here for as long as `.` was bound to nothing. The exception
   * was written with its reason and with a check that it stops being one, which
   * is what made it safe to leave — and it did stop, so it went. The next command
   * to arrive before its dispatcher has somewhere honest to sit.
   */
  const parked = new Set<string>();

  const orphans = [...commandKinds()].filter((k) => !handled.has(k) && !parked.has(k)).sort();
  assert.deepEqual(
    orphans,
    [],
    `emitted by keys.ts, acted on by nothing:\n  ${orphans.join('\n  ')}`,
  );

  // And the other direction: a parked command that quietly got wired should stop
  // being described as parked.
  const wired = [...parked].filter((k) => handled.has(k));
  assert.deepEqual(wired, [], `no longer parked, so the exception should go: ${wired.join(', ')}`);
});

test('a pending reorder reaches the memoized board', () => {
  const src = SRC('../src/web/App.tsx');
  assert.match(src, /<BoardView[\s\S]*?nudge=\{nudge\}/, 'the board receives the pending key command');
  const deps = src.slice(src.indexOf('}, [data, meta, queryError, shape'), src.indexOf('\n\n  if (gate || !vault)'));
  assert.match(deps, /\bnudge\b/, 'the memo redraws when ⌥j or ⌥k sets its pending command');
});

/**
 * Keyboard parity: a control a pointer can reach, a keyboard can reach too.
 *
 * Coarse on purpose. Matching each `onClick` to its own element needs a parser,
 * and the failure this exists to catch is not one misattributed handler — it is a
 * whole surface shipping with no keyboard address at all, which is how the bulk
 * bar and the canvas toolbar held every selection-scoped write in the app while
 * being reachable only by Tab.
 *
 * So the unit is the file: anything that draws interactive controls either wires
 * them into the grammar — a `data-navlist` to walk, a `data-nav` to land on, a
 * `data-act` or `data-rail` for a key to aim at — or is named below as
 * deliberately Tab-only, which is a decision rather than an oversight and reads
 * as one here.
 */
test('a surface that draws controls is reachable from the keyboard', () => {
  /**
   * Tab-only, on purpose.
   *
   * Every one of these is a *modal* or a *gate*: it is already the only thing on
   * screen, so Tab is navigation rather than a maze, and a key to reach it would
   * address something that has nothing to compete with. The list is short and is
   * meant to stay short — a new entry is a claim, not a formality.
   */
  const TAB_ONLY = new Set([
    'Cheatsheet.tsx', //     `?` opens it, esc closes it; the body is a table you read
    'Declined.tsx', //       `,d` opens it; a modal over everything
    'FoldDialog.tsx', //     `+` opens it; a modal with two columns and a confirm
    'VaultPicker.tsx', //    the gate, drawn when there is no vault to have a grammar for
    'VaultSwitcher.tsx', //  lives in the gate and in one rail row
    'CommitInput.tsx', //    a field: it *is* the keyboard, and ⏎ / esc are its whole API
    'BodyEditor.tsx', //     CodeMirror owns its keys; `g c` reaches it and esc leaves
    'FrontmatterEditor.tsx',
    'Popover.tsx', //        the shell for the lists below; its contents carry the nav
    'Button.tsx', //         the button itself — its callers decide what addresses it
  ]);

  const dir = fileURLToPath(new URL('../src/web', import.meta.url));
  const files: string[] = [];
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.tsx')) files.push(full);
    }
  };
  walk(dir);
  assert.ok(files.length > 15, 'the component tree moved');

  const unreachable: string[] = [];
  for (const file of files) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (TAB_ONLY.has(name)) continue;
    const src = readFileSync(file, 'utf8');
    // Only files that actually draw something clickable are asked the question.
    if (!/onClick=/.test(src)) continue;
    // `data-card` is the cursor's own address: a board and a table put the
    // keyboard on a card with `j`/`k`/`h`/`l` and a roving tabindex, which is a
    // different mechanism from the chip walk and just as much an address.
    if (/data-nav|data-act|data-rail|data-card/.test(src)) continue;
    unreachable.push(name);
  }

  assert.deepEqual(
    unreachable,
    [],
    'these draw controls with no keyboard address and are not listed as Tab-only:\n  ' +
      unreachable.join('\n  '),
  );
});

// ------------------------------------------------------------- the registry

/**
 * The flat half of the grammar is a table now, and this is what the table buys.
 *
 * `bind`, `KEYMAP` and `MANUAL.md` are three places one binding has to be
 * written. The tests above hold the *commands* together — every kind the grammar
 * emits is one the dispatcher acts on — and nothing held the *strokes*: `⌥j` and
 * `⌥k` shipped bound, documented and absent from `?`, and `⌫` grew a second
 * meaning its row never mentioned, both inside one afternoon.
 */

/** No vocabulary and no grouping, so only the map itself can answer. */
const bare = ctx({ facetKeys: {}, groupedAxis: null });

/** The strokes the registry claims, for the exhaustive sweep below. */
const FLAT_STROKES = new Set(BINDINGS.map((b) => b.stroke));

test('every binding is what pressing its stroke does', () => {
  for (const b of BINDINGS) {
    assert.deepEqual(
      commandOf([b.stroke], bare),
      b.command,
      `${b.id}: pressing ${b.stroke} does not produce the command it declares`,
    );
  }
  assert.equal(new Set(BINDINGS.map((b) => b.stroke)).size, BINDINGS.length, 'a stroke is bound twice');
  assert.equal(new Set(BINDINGS.map((b) => b.id)).size, BINDINGS.length, 'an id is used twice');
});

/**
 * The other direction, and the one that matters: a key cannot answer without an
 * entry. Exhaustive over everything the map could plausibly claim, so a stroke
 * added to `bind` and to nothing else fails here rather than shipping unlisted.
 */
test('nothing answers a bare stroke except a binding', () => {
  const candidates = [
    ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(33 + i)), // printable ASCII
    'Enter', 'Backspace', 'Tab', 'Escape', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Insert',
  ];
  /**
   * The answers that are deliberately not bindings.
   *
   * `Escape` is decided in `bind` before the registry, because it has to end a
   * pending sequence — a binding cannot express that. A digit is a template: it
   * means the nth value of whatever axis the view groups by, so with no grouping
   * it correctly answers nothing, and `bare` is why it does not appear here.
   */
  const notBindings = new Set(['Escape']);

  const surprises = candidates
    .filter((k) => !FLAT_STROKES.has(k) && !notBindings.has(k))
    .filter((k) => commandOf([k], bare) !== null);

  assert.deepEqual(surprises, [], `answered without a registry entry: ${surprises.join(' ')}`);
});

/**
 * Every command has a way in, and the ways that are not bindings are named.
 *
 * The taxonomy, asserted rather than described: a kind is reached by a stroke, by
 * a sequence or template the registry cannot hold, or it is parked. A new kind
 * that is none of the three fails here — which is the check that would have
 * caught `openAxisControl`, `newCard` and `reorder` sitting unreachable.
 */
test('every command is reachable, and how is written down', () => {
  /** Reached by a prefix sequence or by a template the vault fills in. */
  const NOT_FLAT: Record<string, string> = {
    escape: 'decided in bind(), before the registry',
    move: 'also a binding; `listMove` shares the kind',
    moveTo: 'gg for first; G is a binding',
    listMove: 'j/k inside a navlist, resolved by the dispatcher',
    gotoRef: 'g + an axis letter',
    gotoInverse: 'g + a shifted axis letter',
    focusInverse: 'a shifted axis letter',
    gotoRegion: 'g + a region letter — REGIONS',
    pinStep: 'g [ and g ] — the folded dock, from the keyboard',
    openAxisControl: 'an axis letter, then anything that is not a digit',
    setAxisValue: 'a digit, or an axis letter then a digit',
    setShape: ',s then t, b, c or g',
    rail: 'the , leader — RAIL_LETTERS',
    reachList: ',b and ,t',
    declined: ',d',
    view: '⌥1–9',
    reorder: '⌥j / ⌥k',
    // The four the palette exists for: a control, no key, and `ACTS` names them.
    rename: 'the palette',
    toggleProject: 'the palette',
    enrich: 'the palette',
    switchVault: 'the palette',
    clearSelection: 'the palette',
    calendarPage: 'the palette',
    canvasAction: 'the palette',
    saveAsView: 'the palette',
    revertView: 'the palette',
    blankView: 'the palette',
  };

  // Widened: `commandKinds()` reads the union out of the source as plain strings,
  // so the two sides of this comparison have to meet as strings.
  const bound = new Set<string>(BINDINGS.map((b) => b.command.kind));
  const missing = [...commandKinds()].filter((k) => !bound.has(k) && !(k in NOT_FLAT));
  assert.deepEqual(missing, [], `no way in, and no note saying why:\n  ${missing.join('\n  ')}`);

  // And nothing claims to need an escape hatch it no longer uses.
  const stale = Object.keys(NOT_FLAT).filter((k) => !commandKinds().has(k));
  assert.deepEqual(stale, [], `named here and gone from the union: ${stale.join(', ')}`);

  /**
   * And "the palette" has to be true. A kind whose only way in is a palette row
   * is unreachable the moment the row goes, which no other check would notice —
   * `PALETTE` is derived, so an entry can vanish by a label being deleted.
   */
  const viaPalette = new Set(PALETTE.map((e) => e.command.kind as string));
  const promised = Object.entries(NOT_FLAT)
    .filter(([, how]) => how === 'the palette')
    .map(([k]) => k)
    .filter((k) => !viaPalette.has(k));
  assert.deepEqual(promised, [], `said to be in the palette and absent from it: ${promised.join(', ')}`);
});

test('the cheatsheet accounts for every binding, once', () => {
  const listed = CHEATSHEET_IDS;
  assert.equal(new Set(listed).size, listed.length, 'a binding is on two rows');

  /** Nothing is bound-but-unlisted now; `.` opens the palette and `?` says so. */
  const parked = new Set<string>();
  const unlisted = BINDINGS.map((b) => b.id).filter((id) => !listed.includes(id) && !parked.has(id));
  assert.deepEqual(unlisted, [], `bound and not on the cheatsheet: ${unlisted.join(', ')}`);

  const listedParked = [...parked].filter((id) => listed.includes(id));
  assert.deepEqual(listedParked, [], `parked and listed anyway: ${listedParked.join(', ')}`);
});

/**
 * The axis rows, which are why the palette was worth building at all.
 *
 * `g⟨axis⟩`, `⇧⟨axis⟩` and the four `,`-leader rows that take a letter address an
 * axis by the one it declares — and a vault has twenty-six letters and no
 * obligation to stop at twenty-six axes. An axis with no letter had a pointer and
 * nothing else, which is the condition NEXT.md named as the trigger for this.
 */
test('a letterless axis is offered, and offered without a key', () => {
  const rows = paletteFor([
    { name: 'status', label: 'Status', key: 's' },
    { name: 'layer', label: 'Layer' },
  ]);

  const group = rows.find((r) => r.label === 'Group by Layer');
  assert.ok(group, 'an axis with no letter is still offered');
  assert.equal(group.keys, undefined, 'and is honest that no stroke reaches it');
  assert.deepEqual(group.command, { kind: 'rail', control: 'group', facet: 'layer' });

  // One that does declare a letter says so, so the palette teaches the key.
  assert.equal(rows.find((r) => r.label === 'Group by Status')?.keys, ', g s');
});

test('a computed axis is grouped and sorted by, never walked from', () => {
  const rows = paletteFor([{ name: 'blocked', label: 'Blocked', computed: true }]);
  const labels = rows.map((r) => r.label);

  assert.ok(labels.includes('Group by Blocked'));
  assert.ok(labels.includes('Sort by Blocked'));
  // Nothing names a note on a computed axis, so there is nowhere to go and
  // nothing that names this one back.
  assert.ok(!labels.some((l) => l.includes('Go to the note this names on Blocked')));
  assert.ok(!labels.some((l) => l.includes('names this note on Blocked')));
});

test('the constant rows lead, and the order is the declaration', () => {
  const rows = paletteFor([{ name: 'status', label: 'Status', key: 's' }]);
  assert.deepEqual(
    rows.slice(0, PALETTE.length).map((r) => r.id),
    PALETTE.map((r) => r.id),
    'expanding the axes must not disturb what was already there',
  );
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'a row id is used twice');
});
