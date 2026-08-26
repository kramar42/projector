/**
 * What a keystroke means, decided in one place.
 *
 * The same shape as `dropOutcome`: the event and the context go in, a *command*
 * comes out, and the caller translates a command into a request and nothing else.
 * Both sides are plain data, so the whole grammar is testable without a DOM —
 * which matters more here than it did for a drag, because there are forty
 * bindings rather than one gesture and every one of them is a chance for two
 * surfaces to disagree.
 *
 * It lives in `view/` beside `intents.ts` rather than in the client, for the
 * reason stated there: `pj check` has to refuse a vocabulary that claims a key
 * the keyboard already owns, and `view/` is the layer both the CLI and the
 * browser can reach. A reserved set the client alone knows about is one the
 * validator cannot enforce.
 *
 * ## The three rules the map rests on
 *
 * **A digit is the Nth value of an axis, in declared order.** `facets.yaml` is
 * "the single place column order lives", and the server sends that order as
 * `groupOrder.primary` — so the third column of a board is the third value of its
 * axis, and `3` means the thing that is literally third on screen. A bare digit is
 * *shorthand* for `⟨the key of the axis you are grouped by⟩⟨digit⟩` with the key
 * elided, and `bind` expands it here, so no consumer ever has to know that the
 * shorthand exists.
 *
 * **The client names no facet (C4).** `p` cannot mean `priority` in this file;
 * the vault says so, with `key:` in `facets.yaml`. That constraint is what shaped
 * the whole map — positional digits and a declared axis address are the only two
 * ways to reach a facet by key without the app knowing what a facet is called.
 *
 * **A prefix never leaves you with nothing.** `⟨facet key⟩` awaits a digit and
 * falls back to opening that axis's control, so `pp` is as meaningful as `p3`.
 * `,g` is the other shape: it reaches the Group by row *immediately* and then
 * stays open for an axis letter, so `,g` alone is not a keystroke you have to
 * complete before anything happens — and a key that is not an axis letter goes
 * straight back to meaning what it normally means, which is how `,g` then `j`
 * ends up stepping the control the leader just landed on.
 */

import type { Shape } from '../schema/vocabulary.ts';

// ---------------------------------------------------------------- the reserved set

/**
 * A facet's `key:` is **one letter, a–z**.
 *
 * Restricting it to a letter is what keeps this list to nine entries rather than
 * to nine plus every digit and every punctuation mark the map uses: a vault
 * cannot claim `3` or `,` because a key is not allowed to be one. The narrower
 * rule is also the honest one — a vocabulary is read far more often than it is
 * written, and `key: [` is not a thing anyone means.
 */
export function isKeyShaped(key: string): boolean {
  return /^[a-z]$/.test(key);
}

/**
 * The letters the keyboard owns, and so the letters a facet may not take.
 *
 * Case-folded, which is why the list is nine entries and covers fourteen keys:
 * `H`/`L` walk the trail, `J`/`K` extend a selection and `U` redoes, and each is
 * the shifted form of a letter already here. A vault that could declare `key: J`
 * would break `j` as surely as declaring `key: j` would.
 *
 * Fourteen letters are left, which is more than any vault will spend — the seeded
 * vocabulary has thirteen axes and most of them want no key at all.
 *
 * The rail's own letters are deliberately absent. `,s` is Shape and `,w` is
 * Focus, but they sit *behind a leader*, so `s` and `w` are still a vault's to
 * claim. A leader is exactly the device that keeps a namespace from filling up.
 */
export const RESERVED: readonly string[] = [
  'g', 'h', 'j', 'k', 'l', 'n', 'o', 'u', 'x',
  /**
   * The regions of a card, reached by `g` — `gc` its body, `gf` its facets, `gy`
   * its raw frontmatter, `gl` its links.
   *
   * They are reserved for the same reason `l` already was: `g` plus a letter is
   * the *axis* namespace, so a region letter a vault could also claim would be a
   * silent shadowing — `gf` would reach one of the two and the other would simply
   * stop working, with nothing to say so.
   *
   * `c` for content rather than `b` for body, which is the letter you would guess
   * and the one that costs the most: `b` is the natural key for a `blocked_by`
   * axis, and both the seeded vocabulary and the shipped vault spend it there.
   * A region worth one keystroke is not worth taking a letter a vault wants more.
   */
  'c', 'f', 'y',
];

export function isReserved(key: string): boolean {
  return RESERVED.includes(key.toLowerCase());
}

// ---------------------------------------------------------------- commands

/** The rail rows a leader can reach. */
export type RailControl =
  | 'view'
  | 'shape'
  | 'group'
  | 'thenBy'
  | 'sort'
  /** The direction alone — the arrow beside the Sort select. */
  | 'sortDir'
  | 'show'
  | 'focus'
  | 'filter'
  | 'clear'
  | 'collapse';

/**
 * Everything a keystroke can mean.
 *
 * Named for the *intent* rather than for the key, so the cheatsheet and the
 * dispatcher can disagree about which key produces one without either of them
 * being able to disagree about what it does.
 */
export type Command =
  /** Move the cursor one step along an ordering the shape supplies. */
  | { kind: 'move'; along: 'row' | 'column' | 'lane'; delta: number }
  | { kind: 'moveTo'; end: 'first' | 'last' }
  /** Walk the trail of cards the cursor has visited. `-1` is back. */
  | { kind: 'trail'; delta: 1 | -1 }
  /**
   * Follow one axis out of this card — to the note it names.
   *
   * The move the trail exists for, and the reason `H` was useless without it:
   * a keyboard could reach every card the *view* drew and no card it did not,
   * so the only way out of a card was the mouse.
   */
  | { kind: 'gotoRef'; facet: string }
  /**
   * The other end of the same axis: the notes naming *this* one.
   *
   * A different command rather than a direction flag, because it is a different
   * act. Forward is nearly always one note and you go there; backward is a
   * project's twenty children, and the honest answer to twenty is to *show* them
   * — which is what `focus` already does, so this reshapes the view instead of
   * inventing a list to page through.
   */
  | { kind: 'gotoInverse'; facet: string }
  /**
   * A region of the open card: its links, its facet rows, its body, its raw
   * frontmatter.
   *
   * One command with a named region rather than four commands, because the
   * *reaching* is the same act each time — put the keyboard somewhere in the
   * panel — and only the destination differs. The two document regions
   * additionally open their editor, which is the only way "go to the body" can
   * mean anything: reading it needs no cursor.
   */
  | { kind: 'gotoRegion'; region: 'links' | 'facets' | 'body' | 'frontmatter' | 'addFacet' }
  /**
   * Start work on the note under the cursor: a worktree workspace, a briefing,
   * and a Claude session opened on it.
   *
   * The one command in the map that **acts** on something outside the vault, and
   * the only one that is not reached through a prefix. Both follow from what it
   * is. It is not a `gotoRegion` because it does not put the keyboard anywhere —
   * `g` means "go there", and this goes nowhere; and it is not a letter because a
   * letter is a vault's to claim, where `!` can never be one (`isKeyShaped`). So
   * it costs no vocabulary anything and needs no entry in `RESERVED`.
   *
   * `!` rather than any other free mark, on vim's reading of it: `!` is the key
   * that hands what you have to an external program. That is exactly this — the
   * note goes to a session that is not the app.
   *
   * The safety is a confirm rather than a second keystroke, and it has to be:
   * this is one stroke and it creates directories and branches. The dialog names
   * the workspace and the branch before either exists.
   */
  | { kind: 'work' }
  /** Step within whatever list of chips currently holds focus. */
  | { kind: 'listMove'; delta: number }
  | { kind: 'open' }
  // Three members rather than one with a union of `how`, so that ruling out two
  // of them narrows to the third: `delta` belongs to `extend` alone, and a
  // reader — or a compiler — should not have to take that on trust.
  | { kind: 'select'; how: 'toggle' }
  | { kind: 'select'; how: 'all' }
  | { kind: 'select'; how: 'extend'; delta: number }
  | { kind: 'escape' }
  /**
   * Write the Nth declared value of one axis. `ordinal` is 1-based as typed;
   * **`0` means clear the axis**, which is the `(none)` column a drag already
   * reaches. The facet is always resolved — a bare digit's shorthand is expanded
   * by `bind`, so a consumer never sees "the axis I happen to be grouped by".
   */
  | { kind: 'setAxisValue'; facet: string; ordinal: number }
  /** Open one axis's value control, whichever control its `type` picks. */
  | { kind: 'openAxisControl'; facet: string }
  /** Reach a rail row. With a `facet`, write it directly instead of focusing it. */
  | { kind: 'rail'; control: RailControl; facet?: string }
  | { kind: 'view'; ordinal: number }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'search' }
  | { kind: 'help' }
  | { kind: 'palette' }
  | { kind: 'newCard' }
  /** Move the cursor's card within its column's stored order. */
  | { kind: 'reorder'; delta: number };

// ---------------------------------------------------------------- pending

/**
 * A half-typed sequence.
 *
 * `fallback` is what the prefix means on its own, taken when the next key is not
 * the one it was waiting for. `null` is a prefix with no meaning of its own —
 * `g` alone is not a command in vim either.
 */
export type Pending =
  | { kind: 'goto'; fallback: null }
  /** `⟨facet key⟩`, waiting for a digit. */
  | { kind: 'axis'; facet: string; fallback: Command }
  /** `,`, waiting for a rail letter. */
  | { kind: 'rail'; fallback: null }
  /**
   * `,g` and its siblings, waiting for a facet key.
   *
   * No `fallback`, and that is the difference between this prefix and the other
   * two: the rail row has *already been reached* by the time this is set, so
   * there is nothing left for the prefix to mean on its own. A key that is not an
   * axis letter simply goes back to meaning what it normally means.
   */
  | { kind: 'railAxis'; control: RailControl };

/** What `bind` needs to know about the app to resolve a key. */
export interface KeyContext {
  /** `key:` → facet name, from `facets.yaml`. The only place a facet is named. */
  facetKeys: Readonly<Record<string, string>>;
  /** The axis the view groups by, if any — what a bare digit is shorthand for. */
  groupedAxis: string | null;
  /** Something is being typed into, so the keyboard is not ours. */
  inField: boolean;
}

/**
 * Is the keyboard someone else's right now?
 *
 * Duck-typed rather than taking an `HTMLElement`, so it stays in `view/` with the
 * rest of the grammar and can be tested without a DOM. The client hands it
 * `e.target`.
 *
 * There used to be two of these and they disagreed. `App`'s Escape handler tested
 * for a field before clearing the selection; `NotePanel`'s did not, and closed the
 * card on Escape whatever was being typed — which is why the panel's title editor
 * still calls `stopPropagation` on a key it is handling itself. One predicate is
 * what lets that come out.
 */
export function inField(
  target: { tagName?: string; type?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName ?? '';
  if (tag === 'TEXTAREA') return true;
  // A checkbox consumes no text, so `j` typed at one is not the checkbox's — it
  // is the reader walking the filter rail. Same for a radio.
  if (tag === 'INPUT') return !/^(checkbox|radio)$/.test(target.type ?? '');
  /**
   * A `<select>` is not a field either, and that is a trade rather than a
   * definition.
   *
   * It takes no text; what it takes is the browser's type-ahead, and handing `j`
   * and `k` to it costs exactly the letters the map already owns. The rail's four
   * selects are the controls a leader lands on, so being able to walk them is
   * worth more than jumping to `k8s` by typing `k` — which the popover's own
   * search does better anyway.
   */
  return false;
}

/** The shape of a key event, as much of it as any decision here reads. */
export interface KeyStroke {
  /** The character produced. Unreliable under ⌥ on macOS — see `code`. */
  key: string;
  /**
   * The physical key, which is what a digit must be read from.
   *
   * On macOS `⌥1` yields `key === "¡"`, and `⇧1` yields `"!"` — so every
   * modified digit in this map is unreachable through `key` and perfectly
   * reachable through `code`. It is the one place the two genuinely differ, and
   * the bug it prevents is invisible on Linux.
   */
  code: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** `Digit4` → `4`. Anything else → `null`. */
function digitOf(stroke: KeyStroke): number | null {
  const m = /^Digit([0-9])$/.exec(stroke.code);
  return m ? Number(m[1]) : null;
}

export interface Dispatch {
  /** The sequence so far, or `null` when there is none. */
  pending: Pending | null;
  /** What to do, if the stroke completed something. */
  command: Command | null;
  /**
   * Whether the app claimed this stroke. A claimed stroke is `preventDefault`ed
   * even when it produced no command — otherwise the second `g` of an abandoned
   * `gg` scrolls the page, and a fallback that consumes its trigger would still
   * let the browser act on it.
   */
  handled: boolean;
}

const nothing: Dispatch = { pending: null, command: null, handled: false };

const emit = (command: Command | null, pending: Pending | null = null): Dispatch => ({
  pending,
  command,
  handled: true,
});

/**
 * The regions of a card `g` can reach, by letter.
 *
 * In the client rather than the vault, and legitimately: a body is not a facet.
 * These are the parts every note has by construction, which is exactly the set
 * the app is allowed to name.
 */
const REGIONS: Record<string, 'links' | 'facets' | 'body' | 'frontmatter'> = {
  l: 'links',
  f: 'facets',
  c: 'body',
  y: 'frontmatter',
};

/** The rail rows a leader letter reaches, and which of them take a facet. */
const RAIL_LETTERS: Record<string, { control: RailControl; takesFacet: boolean }> = {
  v: { control: 'view', takesFacet: false },
  s: { control: 'shape', takesFacet: false },
  g: { control: 'group', takesFacet: true },
  G: { control: 'thenBy', takesFacet: true },
  o: { control: 'sort', takesFacet: true },
  /* Shift for the sibling, as `,g`/`,G` and `,f`/`,F` already do: `,o` picks what
     to sort by, `,O` flips which way. */
  O: { control: 'sortDir', takesFacet: false },
  f: { control: 'show', takesFacet: true },
  /**
   * Shift for the sibling control, which `,g`/`,G` already established.
   *
   * `,f` is which facets a note *shows*; `,F` is which of their values the query
   * *keeps*. One letter for one family of thing, and the shift says which of the
   * two questions about it you are asking.
   */
  F: { control: 'filter', takesFacet: false },
  w: { control: 'focus', takesFacet: false },
  c: { control: 'clear', takesFacet: false },
  '\\': { control: 'collapse', takesFacet: false },
};

/**
 * One keystroke, against the sequence so far.
 *
 * Pure, and total: every path returns, so there is no stroke this cannot say
 * something about. The four early guards are the whole of "is this key mine",
 * and they are here rather than at three window listeners because that is what
 * they were — `App` tested for a text field, `NotePanel` did not, and the panel's
 * title editor has to `stopPropagation` to this day to avoid closing the card it
 * is renaming.
 */
export function bind(pending: Pending | null, stroke: KeyStroke, ctx: KeyContext): Dispatch {
  /**
   * A modifier on its own is not a keystroke.
   *
   * It arrives as a `keydown` like anything else, and holding ⇧ to type `,F`
   * therefore sends **three**: `,`, then `Shift`, then `F`. Without this the
   * middle one is fed to the pending sequence, matches nothing, and clears it —
   * so `,F` and `,G` did nothing at all, and neither did `g` plus a shifted axis
   * letter. Every shifted completion in the map, broken by the key that makes it
   * shifted.
   *
   * It survived testing because a synthetic `KeyboardEvent` with `shiftKey: true`
   * is one event, where a keyboard is two. `test/keys.test.ts` sends the modifier
   * now.
   */
  // Passed through rather than ignored: `nothing` clears the pending sequence,
  // which is the very thing this guard exists to stop happening.
  if (/^(Shift|Control|Alt|Meta|CapsLock|AltGraph)$/.test(stroke.key)) {
    return { pending, command: null, handled: false };
  }

  // A browser shortcut is not ours to take. ⌥ is, and is used for exactly two
  // things: reordering within a column, and landing on a saved view.
  if (stroke.metaKey || stroke.ctrlKey) return nothing;

  /**
   * A field owns every key it is given, Escape included.
   *
   * Escape was the tempting exception — it closes the panel, so surely it is the
   * app's — and it is exactly the key that must not be. The rail's search box
   * clears itself on Escape and the panel's title editor abandons a rename, so
   * taking it here would close the card you were in the middle of renaming.
   * `NotePanel`'s handler does take it, which is why that editor has to
   * `stopPropagation` on a key it is handling itself; one predicate in one place
   * is what lets that come out.
   */
  if (ctx.inField) return nothing;

  // Escape ends a sequence before it can mean anything else.
  if (stroke.key === 'Escape') {
    return pending ? emit(null) : emit({ kind: 'escape' });
  }

  if (pending) return resolve(pending, stroke, ctx);
  return start(stroke, ctx);
}

/** A stroke arriving mid-sequence: the awaited key, or the prefix's fallback. */
function resolve(pending: Pending, stroke: KeyStroke, ctx: KeyContext): Dispatch {
  switch (pending.kind) {
    /**
     * `g` is the goto prefix, and everything reachable from a card hangs off it.
     *
     * `gg` is vim's, kept. The rest is the vault's own vocabulary again: `g`
     * followed by an axis's `key:` follows that axis, and the **shifted** form
     * follows it backwards. So on a vault where `a` is `parent`, `ga` goes to the
     * container and `gA` shows what this note contains — one prefix, no new
     * top-level keys, and a vault that declares no keys simply has no gotos.
     *
     * `gl` is the exception that names something in the client, and legitimately:
     * a link is not a facet. `l` is reserved, so no vault can be shadowed by it.
     */
    case 'goto': {
      if (stroke.key === 'g') return emit({ kind: 'moveTo', end: 'first' });
      // Regions before axes, which is only safe because their letters are
      // reserved — see `RESERVED`. Reading them second would let a vault shadow
      // one silently, and reading them first without reserving would shadow the
      // vault instead.
      const region = REGIONS[stroke.key];
      if (region) return emit({ kind: 'gotoRegion', region });
      /**
       * The shifted region: the *door* rather than the room.
       *
       * `gf` walks the facet rows a card already has; `gF` opens the list of the
       * ones it has not, which is the same axis of the same panel and so the same
       * letter. It is the one shifted completion that is not an inverse relation,
       * and it reads as one anyway — the rows you have, and the rows you do not.
       */
      if (stroke.key === 'F') return emit({ kind: 'gotoRegion', region: 'addFacet' });
      const facet = ctx.facetKeys[stroke.key.toLowerCase()];
      if (!facet) return emit(null);
      return emit(
        stroke.key === stroke.key.toUpperCase()
          ? { kind: 'gotoInverse', facet }
          : { kind: 'gotoRef', facet },
      );
    }

    case 'axis': {
      const digit = digitOf(stroke);
      if (digit !== null && !stroke.shiftKey && !stroke.altKey) {
        return emit({ kind: 'setAxisValue', facet: pending.facet, ordinal: digit });
      }
      // The double-tap — `pp` — is the deliberate way to reach the control, and
      // any other key takes the same fallback rather than acting on its own.
      return emit(pending.fallback);
    }

    case 'rail': {
      const row = RAIL_LETTERS[stroke.key];
      if (!row) return emit(null);
      if (!row.takesFacet) return emit({ kind: 'rail', control: row.control });
      /**
       * Reach the row *now*, and stay open for an axis letter.
       *
       * It used to only set the pending, so `,g` did nothing at all until a
       * second key arrived — and the second key was then swallowed by the
       * fallback, so `,g j j` focused the control and stepped it once. Doing the
       * reach on the prefix makes `,g` a complete gesture and leaves the axis
       * letter as the shortcut it was meant to be.
       */
      return emit({ kind: 'rail', control: row.control }, {
        kind: 'railAxis',
        control: row.control,
      });
    }

    case 'railAxis': {
      const facet = ctx.facetKeys[stroke.key];
      if (facet) return emit({ kind: 'rail', control: pending.control, facet });
      // Not an axis letter. The leader has already done its half, so this key is
      // the reader's — `j` steps the control that is now focused rather than
      // being eaten by a fallback that has nothing left to do.
      return start(stroke, ctx);
    }
  }
}

/** A stroke arriving with nothing pending. */
function start(stroke: KeyStroke, ctx: KeyContext): Dispatch {
  const { key, shiftKey, altKey } = stroke;

  // ⌥ first: it is the only modifier this map spends, and reading it before the
  // bare keys is what stops `⌥j` also meaning `j`.
  if (altKey) {
    const digit = digitOf(stroke);
    if (digit !== null && digit > 0) return emit({ kind: 'view', ordinal: digit });
    // `code`, not `key`, for the same reason the digits use it: ⌥j on macOS
    // yields `∆` and ⌥k yields `˚`, so a `key` test here works everywhere except
    // on the machine this is written for.
    if (stroke.code === 'KeyJ') return emit({ kind: 'reorder', delta: 1 });
    if (stroke.code === 'KeyK') return emit({ kind: 'reorder', delta: -1 });
    return nothing;
  }

  /**
   * A digit, which is the map's one-keystroke write.
   *
   * Shorthand, and expanded here: a bare digit is `⟨the key of the axis you are
   * grouped by⟩⟨digit⟩` with the key left out, so an ungrouped board — which has
   * no columns to number — produces no command rather than a wrong one.
   *
   * **Unshifted only**, and that is a decision rather than an oversight. The plan
   * had ⇧1–9 reaching the *lane* axis, which reads well until you notice that ⇧8
   * is `*`: on a US layout the shifted digits are `!@#$%^&*()`, so the row is not
   * a row of digits at all and binding it costs the punctuation. A lane axis has
   * a `key:` like any other axis and is reachable through it, which is what made
   * this the cheapest thing in the map to give up.
   */
  const digit = digitOf(stroke);
  if (digit !== null && !shiftKey) {
    return ctx.groupedAxis
      ? emit({ kind: 'setAxisValue', facet: ctx.groupedAxis, ordinal: digit })
      : emit(null);
  }

  switch (key) {
    // motion
    case 'j':
      return emit({ kind: 'move', along: 'row', delta: 1 });
    case 'k':
      return emit({ kind: 'move', along: 'row', delta: -1 });
    case 'h':
      return emit({ kind: 'move', along: 'column', delta: -1 });
    case 'l':
      return emit({ kind: 'move', along: 'column', delta: 1 });
    case '[':
      return emit({ kind: 'move', along: 'lane', delta: -1 });
    case ']':
      return emit({ kind: 'move', along: 'lane', delta: 1 });
    case 'g':
      return emit(null, { kind: 'goto', fallback: null });
    case 'G':
      return emit({ kind: 'moveTo', end: 'last' });

    // the trail. `H`/`L` rather than a jumplist chord: this is a browser, where
    // back and forward are already the shifted forms of the horizontal motion
    // keys in every vim-for-the-web anyone has used.
    case 'H':
      return emit({ kind: 'trail', delta: -1 });
    case 'L':
      return emit({ kind: 'trail', delta: 1 });

    // opening
    case 'Enter':
    case 'o':
      return emit({ kind: 'open' });

    // selection
    case 'x':
      return emit({ kind: 'select', how: 'toggle' });
    case 'J':
      return emit({ kind: 'select', how: 'extend', delta: 1 });
    case 'K':
      return emit({ kind: 'select', how: 'extend', delta: -1 });
    case '*':
      return emit({ kind: 'select', how: 'all' });

    // undo. `U` rather than a chord: this is not a modal editor, and a pair you
    // reach for as often as these two should be one hand and no modifier.
    case 'u':
      return emit({ kind: 'undo' });
    case 'U':
      return emit({ kind: 'redo' });

    // leaders and the rest
    case ',':
      return emit(null, { kind: 'rail', fallback: null });
    case '.':
      return emit({ kind: 'palette' });
    case '/':
      return emit({ kind: 'search' });
    case '?':
      return emit({ kind: 'help' });
    case 'n':
      return emit({ kind: 'newCard' });
    /**
     * Hand this note to a session. See `Command`'s `work` for why it is a bare
     * mark and why that mark is this one.
     *
     * Above the facet fallthrough like every other case here, but uniquely
     * safe there: `!` is not a letter, so no vocabulary can reach it and this is
     * not shadowing anything even in principle.
     */
    case '!':
      return emit({ kind: 'work' });
  }

  /**
   * A facet key, last — so a vault can never shadow the map.
   *
   * `RESERVED` is what makes this safe to put at the bottom rather than making
   * the bottom the thing that decides: a declaration that would reach a letter
   * already handled above is refused by `pj check`, so falling through to here is
   * proof the letter is the vault's.
   */
  const facet = ctx.facetKeys[key];
  if (facet) {
    return emit(null, { kind: 'axis', facet, fallback: { kind: 'openAxisControl', facet } });
  }
  return nothing;
}

// ---------------------------------------------------------------- the cheatsheet

/**
 * The map, as the reader meets it.
 *
 * Beside `bind` rather than in the component that draws it, because `?` restating
 * the bindings in its own words is exactly how a cheatsheet comes to describe a
 * key that was renamed a month ago. The two are not derived from one another —
 * `bind` resolves things a table cannot express — so this is a list the
 * dispatcher's tests hold it against, which is the next best thing.
 *
 * The dynamic rows say what they are rather than enumerating themselves: the
 * digits mean whatever the current grouping axis declares, and the facet keys are
 * the vault's. `?` fills both in from the payload it has.
 *
 * **Only what works is listed.** `bind` emits commands nothing consumes yet —
 * `openAxisControl`, `newCard`, `reorder`, `palette` — and they were on this table
 * until it was read as a promise rather than a plan. A cheatsheet naming a key
 * that does nothing is worse than one that is short: the reader presses it,
 * nothing happens, and now every other row is in doubt. They are filed in
 * README's *Not bound yet*, where a list of intentions belongs.
 */
export interface KeyRow {
  keys: string;
  does: string;
}

export const KEYMAP: { section: string; rows: KeyRow[] }[] = [
  {
    section: 'The cursor',
    rows: [
      { keys: 'j k', does: 'down / up a column' },
      { keys: 'h l', does: 'across columns' },
      { keys: '[ ]', does: 'across lanes' },
      { keys: 'gg G', does: 'first / last' },
      { keys: '⏎ o', does: 'open the note' },
      { keys: 'H L', does: 'back / forward through visited cards' },
      { keys: 'esc', does: 'close · leave a list · deselect' },
    ],
  },
  {
    section: 'Into a note',
    rows: [
      { keys: 'g ⟨axis⟩', does: 'the note it names there' },
      { keys: 'g ⇧⟨axis⟩', does: 'what names this note there' },
      { keys: 'g f', does: 'its facet rows' },
      { keys: 'g ⇧F', does: 'add an axis it lacks' },
      { keys: 'g l', does: 'its links' },
      { keys: 'g c', does: 'edit the body' },
      { keys: 'g y', does: 'edit the frontmatter' },
      { keys: '⟨axis⟩⟨axis⟩', does: 'one axis’s row' },
      // The one row here that acts rather than reaching, which the wording has to
      // carry on its own: every other line in this section moves the keyboard.
      { keys: '!', does: 'start work on it — worktrees, briefing, a session' },
    ],
  },
  {
    // Stated once rather than repeated per list: which key walks and which steps
    // out follows how the list is drawn, and that is the whole rule.
    section: 'In a list',
    rows: [
      { keys: 'j k', does: 'a stacked list — links, refs, filters' },
      { keys: 'h l', does: 'a facet’s values; j k change axis' },
      { keys: '⏎', does: 'take what is under the cursor' },
      { keys: 'esc', does: 'back to the cards' },
    ],
  },
  {
    section: 'Choosing',
    rows: [
      { keys: 'x', does: 'add this card to the selection' },
      { keys: 'J K', does: 'extend the selection' },
      { keys: '*', does: 'everything on screen' },
    ],
  },
  {
    section: 'Writing',
    rows: [
      { keys: '1–9', does: 'move to the nth column' },
      { keys: '0', does: 'clear the grouped axis' },
      { keys: '⟨axis⟩ 1–9', does: 'set that axis to its nth value' },
      { keys: 'n', does: 'new card in this column' },
      { keys: 'u U', does: 'undo · redo' },
    ],
  },
  {
    section: 'The view',
    rows: [
      { keys: ', v', does: 'saved view' },
      { keys: ', s', does: 'shape' },
      { keys: ', g', does: 'group by (+ axis key sets it)' },
      { keys: ', G', does: 'then by' },
      { keys: ', o', does: 'sort' },
      { keys: ', O', does: 'flip the direction' },
      { keys: ', f', does: 'which facets show' },
      { keys: ', F', does: 'the filter rail' },
      { keys: ', w', does: 'focus: walk from a note' },
      { keys: ', c', does: 'clear the filters' },
      { keys: ', \\', does: 'collapse the rail' },
      { keys: '⌥1–9', does: 'the nth saved view' },
      { keys: '/', does: 'search' },
      { keys: '?', does: 'this' },
    ],
  },
];

/** Which shapes offer motion. A canvas is a plane; `j` has no meaning on it. */
export const MOVES: readonly Shape[] = ['board', 'table'];
