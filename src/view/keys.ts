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
   * The regions of a note, reached by `g` — `gc` its body, `gf` its facets, `gy`
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
  | 'collapse'
  /**
   * Write the overrides into the saved view they are overriding.
   *
   * The ✓ beside the view name, which appears only when there is something to
   * write. Its sibling — the ↺ that throws the overrides away — deliberately gets
   * no letter of its own: `,v` and picking the view you are already on *is* the
   * revert, since landing on a view replaces the query wholesale. One act, one
   * key; the other was already reachable and a second letter would have been a
   * second name for it.
   */
  | 'save';

/**
 * Reader-facing names for rail acts.
 *
 * An act can appear in the sidebar, command palette and cheatsheet. This is
 * its single phrase in all of those places, so a key never promises a subtly
 * different operation from the control it reaches.
 */
const RAIL_CONTROL_DESCRIPTIONS: Record<RailControl, string> = {
  view: 'saved views',
  shape: 'change the shape',
  group: 'group by',
  thenBy: 'then by',
  sort: 'sort',
  sortDir: 'flip the sort direction',
  show: 'which facets show',
  focus: 'focus: walk from a note',
  filter: 'the filter rail',
  clear: 'clear the filters',
  collapse: 'collapse sidebar',
  save: 'save changes into this view',
};

export function railControlDescription(control: RailControl): string {
  return RAIL_CONTROL_DESCRIPTIONS[control];
}

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
   * The other end as a *query*, in one keystroke: bare `⇧⟨axis key⟩`.
   *
   * `gotoInverse` prefers the drawn row when there is one, which is right — three
   * children on screen do not need the view reshaped around them. But that leaves
   * the reshape reachable only when the row is *absent*, so the long lists, the
   * ones actually worth a query, were the ones the keyboard could not ask for.
   * This is the unconditional half of the same act.
   *
   * **Shifted and bare, and neither is arbitrary.** Shift already means *the
   * other end* on this map — `g⟨key⟩` walks out along a relation and `g⇧⟨key⟩`
   * comes back — so this borrows the established word rather than adding a second
   * one. And a bare axis letter is already a namespace: `p3` sets priority's third
   * value and `pp` opens its control, so a vault declaring `key: p` already owns
   * that letter and gains `⇧P` with it, needing no new leader and no new entry in
   * `RESERVED` — which the comment there argues hard against spending.
   *
   * It cannot collide, and that is checkable rather than hopeful: the bare
   * uppercase letters `start` binds are `G H L J K U`, every one the shifted form
   * of a letter already in `RESERVED`. A legal `key:` is a–z and not reserved, so
   * its shifted form is unbound by construction.
   */
  | { kind: 'focusInverse'; facet: string }
  /**
   * A region of the open note: its links, its facet rows, its body, its raw
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
  /**
   * Judge this candidate — one verb, because the queue has one question.
   *
   * What it does is read off the card rather than chosen by the reader: a
   * candidate carrying `extends` **folds** into that note, and one carrying
   * none is **accepted** as its own. It was two keys, `+` and `=`, and the
   * choice they offered was the wrong one to have to make in advance — you
   * pressed one before you could see what target the classifier had picked,
   * and the targets come off a spectrum from a working directory (certain) to
   * shared words (a guess). The fold dialog names the target, so choosing after
   * opening it is choosing informed.
   *
   * Keeping a card that proposes a target separate is therefore removing the
   * `extends` reference and judging it again — deliberately the longer path,
   * because it is the rarer intent and it is a claim about the target rather
   * than about the card.
   *
   * Aimed at the panel's button, like `work`, so the fold's confirm cannot be
   * skipped by arriving from the keyboard.
   */
  | { kind: 'judge' }
  /**
   * Delete the note under the cursor, behind the panel's own confirm.
   *
   * `⌫` rather than a letter, and that is not a preference. Commands here take
   * punctuation so that no vocabulary can shadow them — and `d`, the letter this
   * wants, is spent on `due` by both the seeded vocabulary and the shipped
   * tutorial, where `dd` already means that axis's own row. `RESERVED` settled
   * the same trade for `b`: a command worth one keystroke is not worth a letter
   * a vault wants more.
   *
   * In the queue this is *decline*: the file goes and `deleteNote` records the
   * suppression, so the fingerprint does not come back on the next sweep.
   */
  | { kind: 'remove' }
  /** Open the declined pile — what a sweep turned down, and why. */
  | { kind: 'declined' }
  /**
   * Step into a floating bar — the bulk bar, the canvas toolbar.
   *
   * Neither is a rail row and neither belongs to a note, so no existing address
   * reaches them: they appear over the content, hold most of the writes that act
   * on a *selection* rather than on a card, and were reachable only by Tab. One
   * command rather than one per bar, because the act is identical — put the
   * keyboard on the first thing in it — and the walk that follows is the walk
   * every other list already has.
   */
  | { kind: 'reachList'; list: 'bulk' | 'toolbar' }
  /**
   * The acts with a control and no key.
   *
   * Each is rare enough that a letter would be spent badly and real enough that
   * Tab-only was the wrong answer. They reach the palette instead, which is the
   * job the palette turned out to have once the floating bars got a navlist and
   * took merge, delete and save-layout off the list.
   *
   * All four aim at their button, like `work` and `judge`: the button knows
   * whether it applies — the panel draws no rename on a note it has not loaded —
   * so the command inherits that instead of re-deriving it.
   */
  | { kind: 'rename' }
  | { kind: 'toggleProject' }
  | { kind: 'enrich' }
  | { kind: 'switchVault' }
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
 * note on Escape whatever was being typed — which is why the panel's title editor
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
 * The regions of a note `g` can reach, by letter.
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
  /* Shift for the sibling, as `,g`/`,G` and `,f`/`,F` do: `,v` chooses a view,
     `,V` writes what you have changed into the one you are on. */
  V: { control: 'save', takesFacet: false },
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
 * title editor has to `stopPropagation` to this day to avoid closing the note it
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
   * taking it here would close the note you were in the middle of renaming.
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
     * `g` is the goto prefix, and everything reachable from a note hangs off it.
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
       * `gf` walks the facet rows a note already has; `gF` opens the list of the
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
      /**
       * The declined pile is under the leader but is not a rail control.
       *
       * `,` is "the app's own controls", which is the right namespace for it —
       * but `RailControl` is the set of rows in the sidebar, and this opens a
       * surface instead. Making it a rail row to reach it through one table would
       * be the table lying about what it holds.
       */
      if (stroke.key === 'd') return emit({ kind: 'declined' });
      // Neither is a rail row, so both are named here rather than in
      // `RAIL_LETTERS` — the same exception `,d` is, for the same reason.
      if (stroke.key === 'b') return emit({ kind: 'reachList', list: 'bulk' });
      if (stroke.key === 't') return emit({ kind: 'reachList', list: 'toolbar' });
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

  /**
   * The two prefixes, which are the only strokes here that open a sequence rather
   * than meaning something. They stay written out because what follows them is a
   * machine — a sub-table, a fallback, and a re-entry into this function — and
   * none of the three is a row in `BINDINGS`.
   */
  if (key === 'g') return emit(null, { kind: 'goto', fallback: null });
  if (key === ',') return emit(null, { kind: 'rail', fallback: null });

  /**
   * Everything flat, from the registry.
   *
   * This was twenty-four `case` arms. Their reasoning moved to the entries, which
   * is where it belonged — it explains a binding, not a branch — and the lookup
   * is what makes a key impossible to bind without something the cheatsheet and
   * the tests can see.
   *
   * Before the facet fallthrough, exactly as the switch was: `RESERVED` and
   * `pj check` between them guarantee no vault declares a letter claimed here, so
   * reaching the lines below is proof the letter is the vault's.
   */
  const flat = FLAT.get(key);
  if (flat) return emit(flat.command);

  /**
   * A facet key, last — so a vault can never shadow the map.
   *
   * `RESERVED` is what makes this safe to put at the bottom rather than making
   * the bottom the thing that decides: a declaration that would reach a letter
   * already handled above is refused by `pj check`, so falling through to here is
   * proof the letter is the vault's.
   *
   * Shifted first, and only because it has to be read from the same table: an
   * axis key is stored lower-cased, so `⇧R` has to fold before it can be looked
   * up, and folding first would make `r` and `⇧R` the same stroke. The switch
   * above has already claimed every shifted letter the map wants, so anything
   * arriving here shifted is the vault's too — see `focusInverse`.
   */
  if (shiftKey) {
    const inverted = ctx.facetKeys[key.toLowerCase()];
    return inverted ? emit({ kind: 'focusInverse', facet: inverted }) : nothing;
  }
  const facet = ctx.facetKeys[key];
  if (facet) {
    return emit(null, { kind: 'axis', facet, fallback: { kind: 'openAxisControl', facet } });
  }
  return nothing;
}

// ---------------------------------------------------------------- the registry

/**
 * One stroke, one command, no context.
 *
 * The flat half of the grammar, declared rather than switched. Twenty-four of the
 * roughly forty addressable strokes are this shape: a key that always means the
 * same thing, whatever the vault declares and whatever is on screen. The rest —
 * a digit standing for an axis value, a prefix awaiting a letter, the guards in
 * `bind` — cannot be a table and are not one.
 *
 * **Why it is a table now.** `bind`, `KEYMAP` and `MANUAL.md` are three places one
 * binding has to be written, and the comment on `KEYMAP` below has always said the
 * tests hold them together. They hold the *commands*: `test/keys.test.ts` checks
 * that every kind the grammar emits is one the dispatcher acts on. Nothing held
 * the *strokes*, and in one afternoon two drifted — `⌥j`/`⌥k` shipped bound,
 * documented, and absent from `?`, and `⌫` grew a second meaning its row never
 * mentioned. A key that cannot be bound without an entry here cannot do either.
 *
 * The per-binding reasoning lives on the entry rather than beside a switch arm,
 * which is where it belonged: it explains the binding, not the branch.
 */
export interface Binding {
  /** Stable, and what a palette will key on. Not shown to a reader. */
  id: string;
  /** As `bind` sees it — `KeyboardEvent.key`, so `Backspace` and not `⌫`. */
  stroke: string;
  /** As a reader sees it, where the two differ. */
  glyph?: string;
  /**
   * What the palette calls this, when it belongs there.
   *
   * Absent for motion. A palette is a list of *acts* — things that change
   * something or open something — and "move down one card" in a searchable list
   * of commands is a row nobody will ever pick, on a surface whose whole value is
   * that everything in it is worth picking.
   *
   * Its own wording rather than the cheatsheet's: `does` is terse because it sits
   * beside a key that carries half the meaning, and a palette row has only itself.
   */
  palette?: string;
  command: Command;
}

export const BINDINGS: readonly Binding[] = [
  { id: 'move.down', stroke: 'j', command: { kind: 'move', along: 'row', delta: 1 } },
  { id: 'move.up', stroke: 'k', command: { kind: 'move', along: 'row', delta: -1 } },
  { id: 'move.left', stroke: 'h', command: { kind: 'move', along: 'column', delta: -1 } },
  { id: 'move.right', stroke: 'l', command: { kind: 'move', along: 'column', delta: 1 } },
  { id: 'lane.prev', stroke: '[', command: { kind: 'move', along: 'lane', delta: -1 } },
  { id: 'lane.next', stroke: ']', command: { kind: 'move', along: 'lane', delta: 1 } },
  { id: 'cursor.last', stroke: 'G', command: { kind: 'moveTo', end: 'last' } },

  /**
   * The trail. `H`/`L` rather than a jumplist chord: this is a browser, where back
   * and forward are already the shifted forms of the horizontal motion keys in
   * every vim-for-the-web anyone has used.
   */
  { id: 'trail.back', stroke: 'H', command: { kind: 'trail', delta: -1 } },
  { id: 'trail.forward', stroke: 'L', command: { kind: 'trail', delta: 1 } },

  { id: 'open.enter', stroke: 'Enter', glyph: '⏎', command: { kind: 'open' } },
  { id: 'open.o', stroke: 'o', command: { kind: 'open' } },

  { id: 'select.toggle', stroke: 'x', command: { kind: 'select', how: 'toggle' } },
  { id: 'select.down', stroke: 'J', command: { kind: 'select', how: 'extend', delta: 1 } },
  { id: 'select.up', stroke: 'K', command: { kind: 'select', how: 'extend', delta: -1 } },
  { id: 'select.all', stroke: '*', palette: 'Select everything on screen', command: { kind: 'select', how: 'all' } },

  /**
   * `U` rather than a chord: this is not a modal editor, and a pair you reach for
   * as often as these two should be one hand and no modifier.
   */
  { id: 'undo', stroke: 'u', palette: 'Undo', command: { kind: 'undo' } },
  { id: 'redo', stroke: 'U', palette: 'Redo', command: { kind: 'redo' } },

  { id: 'palette', stroke: '.', palette: undefined, command: { kind: 'palette' } },
  { id: 'search', stroke: '/', palette: 'Search notes', command: { kind: 'search' } },
  { id: 'help', stroke: '?', palette: 'Show the keyboard map', command: { kind: 'help' } },
  { id: 'newCard', stroke: 'n', palette: 'New card in this column', command: { kind: 'newCard' } },

  /**
   * Hand this note to a session. See `Command`'s `work` for why it is a bare mark
   * and why that mark is this one. Safe among the letters because `!` is not one:
   * no vocabulary can reach it, so it shadows nothing even in principle.
   */
  { id: 'work', stroke: '!', palette: 'Start work on this note', command: { kind: 'work' } },
  /**
   * Judge a candidate: fold it if it extends something, accept it if not.
   *
   * Punctuation for the same reason `!` is. `+` because both outcomes are *this
   * belongs in the vault*, which is the one question the queue asks. `=` held the
   * fold and is free again — the two acts turned out to be one decision the card
   * had already made.
   */
  { id: 'judge', stroke: '+', palette: 'Judge this candidate', command: { kind: 'judge' } },
  /**
   * Delete, confirmed by whatever it is aimed at. Not a letter: `d` is spent on
   * `due` by both shipped vocabularies, where `dd` already means that axis's row.
   */
  { id: 'remove', stroke: 'Backspace', glyph: '⌫', palette: 'Delete', command: { kind: 'remove' } },
];

/**
 * The acts with no stroke, and the constant rail controls.
 *
 * Two kinds of thing the registry above cannot hold. The first four have a
 * control and no key at all — too rare to spend a letter on, too real to leave
 * on Tab — and are why the palette exists at all. The rest are reached by the
 * `,` leader, which is a sequence rather than a binding, so their keys are
 * written here for the palette to show; the ones that take an axis letter are
 * *templates* and are left out until the palette can expand them.
 */
export interface Act {
  id: string;
  palette: string;
  command: Command;
  /** The sequence that also reaches it, where one does. */
  keys?: string;
}

export const ACTS: readonly Act[] = [
  { id: 'act.rename', palette: 'Rename this note', command: { kind: 'rename' } },
  { id: 'act.project', palette: 'Make / unmake a project', command: { kind: 'toggleProject' } },
  { id: 'act.enrich', palette: 'Re-fetch this note’s links', command: { kind: 'enrich' } },
  { id: 'act.vault', palette: 'Switch vault', command: { kind: 'switchVault' } },

  { id: 'act.view', palette: railControlDescription('view'), keys: ', v', command: { kind: 'rail', control: 'view' } },
  { id: 'act.save', palette: railControlDescription('save'), keys: ', V', command: { kind: 'rail', control: 'save' } },
  { id: 'act.shape', palette: railControlDescription('shape'), keys: ', s', command: { kind: 'rail', control: 'shape' } },
  { id: 'act.sortDir', palette: railControlDescription('sortDir'), keys: ', O', command: { kind: 'rail', control: 'sortDir' } },
  { id: 'act.filter', palette: railControlDescription('filter'), keys: ', F', command: { kind: 'rail', control: 'filter' } },
  { id: 'act.focus', palette: railControlDescription('focus'), keys: ', w', command: { kind: 'rail', control: 'focus' } },
  { id: 'act.clear', palette: railControlDescription('clear'), keys: ', c', command: { kind: 'rail', control: 'clear' } },
  { id: 'act.collapse', palette: railControlDescription('collapse'), keys: ', \\', command: { kind: 'rail', control: 'collapse' } },
  { id: 'act.declined', palette: 'What a sweep declined, and why', keys: ', d', command: { kind: 'declined' } },
  { id: 'act.bulk', palette: 'The bulk bar', keys: ', b', command: { kind: 'reachList', list: 'bulk' } },
  { id: 'act.toolbar', palette: 'The canvas toolbar', keys: ', t', command: { kind: 'reachList', list: 'toolbar' } },
];

/** What the palette lists: every act, keyed or not, in one declared order. */
export interface PaletteEntry {
  id: string;
  label: string;
  command: Command;
  /** Shown beside the row, so the palette teaches the key rather than replacing it. */
  keys?: string;
}

/** By stroke, for `start`. Built once; a duplicate stroke is a test failure. */
const FLAT = new Map(BINDINGS.map((b) => [b.stroke, b]));

/** By id, for the cheatsheet rows that name what they cover. */
const BY_ID = new Map(BINDINGS.map((b) => [b.id, b]));

// ---------------------------------------------------------------- the cheatsheet

/**
 * The map, as the reader meets it.
 *
 * Beside `bind` rather than in the component that draws it, because `?` restating
 * the bindings in its own words is exactly how a cheatsheet comes to describe a
 * key that was renamed a month ago.
 *
 * It used to say the two "are not derived from one another — `bind` resolves
 * things a table cannot express — so this is a list the dispatcher's tests hold
 * it against, which is the next best thing." Half of that was right. A table
 * cannot express the prefix machine or the guards in `bind`; it expresses the
 * flat strokes exactly, and those are twenty-four of the forty. So the flat rows
 * *are* derived now — their keys come from `BINDINGS` and cannot be spelled
 * wrongly here — and only the rows that describe a sequence or a template still
 * write their own.
 *
 * The dynamic rows say what they are rather than enumerating themselves: the
 * digits mean whatever the current grouping axis declares, and the facet keys are
 * the vault's. `?` fills both in from the payload it has.
 *
 * **Only what works is listed**, and everything now does. This paragraph used to
 * name the commands `bind` emitted that nothing consumed — `openAxisControl`,
 * `newCard`, `reorder`, and last of all `palette` — because a cheatsheet naming a
 * key that does nothing is worse than one that is short: the reader presses it,
 * nothing happens, and every other row is in doubt.
 *
 * The list outlived each of them by months, which is the failure mode a list of
 * names has. `test/keys.test.ts` asserts the set instead, from both directions,
 * so a command with no way in fails and a note claiming an exception that is no
 * longer one fails too.
 */
export interface KeyRow {
  keys: string;
  does: string;
}

/**
 * A row as it is written, before its keys are filled in.
 *
 * `ids` names the bindings the row accounts for. Where the row is nothing but
 * those bindings, the keys are *derived* from them and there is no second place
 * to spell `j k` wrongly. Where it is not — `gg G` pairs a sequence with a
 * binding, `⟨axis⟩ 1–9` is a template — `keys` is written out and `ids` still
 * says what it covers, so the coverage test holds either way.
 *
 * The prose stays hand-written on purpose. `down / up a column` is better than
 * anything a machine would assemble from two bindings, and it is the whole value
 * of the cheatsheet.
 */
interface RowSpec {
  does: string;
  /** Literal, when the row is more than its bindings. */
  keys?: string;
  /** Binding ids this row accounts for. */
  ids?: string[];
}

const SPEC: { section: string; rows: RowSpec[] }[] = [
  {
    section: 'The cursor',
    rows: [
      { ids: ['move.down', 'move.up'], does: 'down / up a column' },
      { ids: ['move.left', 'move.right'], does: 'across columns' },
      { ids: ['lane.prev', 'lane.next'], does: 'across lanes' },
      // `gg` is a sequence and `G` a binding, so the keys are written and the
      // coverage is declared.
      { keys: 'gg G', ids: ['cursor.last'], does: 'first / last' },
      { ids: ['open.enter', 'open.o'], does: 'open the note' },
      { ids: ['trail.back', 'trail.forward'], does: 'back / forward through visited cards' },
      // Escape is decided in `bind` before the registry is consulted — it has to
      // end a pending sequence, which no binding can express.
      { keys: 'esc', does: 'close · leave a list · deselect' },
    ],
  },
  {
    section: 'Into a note',
    rows: [
      { keys: 'g ⟨axis⟩', does: 'the note it names there' },
      { keys: 'g ⇧⟨axis⟩', does: 'what names this note there' },
      // Beside `g ⇧⟨axis⟩` because they are the same question, and the wording has
      // to carry the difference: that one reaches the drawn list when there is
      // one, this one always makes it the view.
      { keys: '⇧⟨axis⟩', does: 'show everything that names this note there' },
      { keys: 'g f', does: 'its facet rows' },
      { keys: 'g ⇧F', does: 'add an axis it lacks' },
      { keys: 'g l', does: 'its links' },
      { keys: 'g c', does: 'edit the body' },
      { keys: 'g y', does: 'edit the frontmatter' },
      { keys: '⟨axis⟩⟨axis⟩', does: 'one axis’s row' },
      // The one row here that acts rather than reaching, which the wording has to
      // carry on its own: every other line in this section moves the keyboard.
      { ids: ['work'], does: 'start work on it — worktrees, briefing, a session' },
      { ids: ['judge'], does: 'judge a candidate — fold it in, or accept it as its own note' },
      { ids: ['remove'], does: 'delete — the selection if there is one, else this note. One confirm' },
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
      { ids: ['select.toggle'], does: 'add this card to the selection' },
      { ids: ['select.down', 'select.up'], does: 'extend the selection' },
      { ids: ['select.all'], does: 'everything on screen' },
    ],
  },
  {
    section: 'Writing',
    rows: [
      { keys: '1–9', does: 'move to the nth column' },
      { keys: '0', does: 'clear the grouped axis' },
      { keys: '⟨axis⟩ 1–9', does: 'set that axis to its nth value' },
      { ids: ['newCard'], does: 'new card in this column' },
      // `⌥` is read before the registry, so the two reorder strokes are not
      // bindings and their keys are written out.
      { keys: '⌥j ⌥k', does: 'move this card down · up its column (a saved view)' },
      { ids: ['undo', 'redo'], does: 'undo · redo' },
    ],
  },
  {
    section: 'The view',
    rows: [
      { keys: ', v', does: railControlDescription('view') },
      { keys: ', V', does: railControlDescription('save') },
      { keys: ', s', does: railControlDescription('shape') },
      { keys: ', g', does: 'group by (+ axis key sets it)' },
      { keys: ', G', does: 'then by' },
      { keys: ', o', does: 'sort' },
      { keys: ', O', does: railControlDescription('sortDir') },
      { keys: ', f', does: 'which facets show' },
      { keys: ', F', does: railControlDescription('filter') },
      { keys: ', w', does: railControlDescription('focus') },
      { keys: ', c', does: railControlDescription('clear') },
      { keys: ', \\', does: railControlDescription('collapse') },
      { keys: ', d', does: 'what a sweep declined, and why' },
      { keys: ', b', does: 'the bulk bar, when something is selected' },
      { keys: ', t', does: 'the canvas toolbar' },
      { keys: '⌥1–9', does: 'the nth saved view' },
      { ids: ['search'], does: 'search' },
      { ids: ['help'], does: 'this' },
      { ids: ['palette'], does: 'every command by name — the ones with no key included' },
    ],
  },
];

/** What a reader is shown for a stroke: `Backspace` is `⌫` on the page. */
const glyphOf = (id: string): string => {
  const b = BY_ID.get(id);
  if (!b) throw new Error(`the cheatsheet names a binding that does not exist: ${id}`);
  return b.glyph ?? b.stroke;
};

/**
 * The map, resolved. Rows keep their prose; their keys come from the registry
 * wherever the row is nothing but bindings.
 */
export const KEYMAP: { section: string; rows: KeyRow[] }[] = SPEC.map(({ section, rows }) => ({
  section,
  rows: rows.map((r) => ({
    does: r.does,
    keys: r.keys ?? (r.ids ?? []).map(glyphOf).join(' '),
  })),
}));

/** Which binding ids the cheatsheet accounts for — `test/keys.test.ts` holds it. */
export const CHEATSHEET_IDS: readonly string[] = SPEC.flatMap((s) => s.rows.flatMap((r) => r.ids ?? []));

/**
 * The acts that take an axis, and the reason the palette was worth building.
 *
 * `g⟨axis⟩`, `⇧⟨axis⟩` and the four `,`-leader rows that accept a letter all
 * address an axis by the `key:` it declares — and a vault has twenty-six letters
 * and no obligation to stop at twenty-six axes. An axis with no letter is
 * reachable by pointer and by nothing else, which is the condition NEXT.md named
 * as the trigger for building this: *more axes worth reaching than there are
 * letters*.
 *
 * Expanded at draw time from the vault's own vocabulary, because that is the one
 * thing a static table cannot hold (C4 — the client names no facet). A letterless
 * axis gets a row with no key beside it, which is exactly the honest rendering:
 * there is no key.
 */
export interface AxisTemplate {
  id: string;
  label: (axis: string) => string;
  command: (facet: string) => Command;
  /** How the stroke reads, for an axis that declares a letter. */
  keys?: (key: string) => string;
  /** Whether a computed axis can take this. Most can; walking *from* one cannot. */
  computed: boolean;
}

export const AXIS_TEMPLATES: readonly AxisTemplate[] = [
  {
    id: 'axis.group',
    label: (a) => `Group by ${a}`,
    command: (facet) => ({ kind: 'rail', control: 'group', facet }),
    keys: (k) => `, g ${k}`,
    computed: true,
  },
  {
    id: 'axis.thenBy',
    label: (a) => `Then by ${a}`,
    command: (facet) => ({ kind: 'rail', control: 'thenBy', facet }),
    keys: (k) => `, G ${k}`,
    computed: true,
  },
  {
    id: 'axis.sort',
    label: (a) => `Sort by ${a}`,
    command: (facet) => ({ kind: 'rail', control: 'sort', facet }),
    keys: (k) => `, o ${k}`,
    computed: true,
  },
  {
    id: 'axis.show',
    label: (a) => `Show ${a} on the cards`,
    command: (facet) => ({ kind: 'rail', control: 'show', facet }),
    keys: (k) => `, f ${k}`,
    computed: true,
  },
  /**
   * The two that walk the graph, and the reason `computed` is a flag rather than
   * an assumption: `blocked` and `type` are computed *about* a note and name no
   * other note, so there is nothing to go to and nothing that names this one back.
   */
  {
    id: 'axis.goto',
    label: (a) => `Go to the note this names on ${a}`,
    command: (facet) => ({ kind: 'gotoRef', facet }),
    keys: (k) => `g ${k}`,
    computed: false,
  },
  {
    id: 'axis.inverse',
    label: (a) => `Show everything that names this note on ${a}`,
    command: (facet) => ({ kind: 'focusInverse', facet }),
    keys: (k) => `⇧${k.toUpperCase()}`,
    computed: false,
  },
];

/** What the palette needs to know about one axis to offer it. */
export interface PaletteAxis {
  name: string;
  label: string;
  /** The letter it declares, if it declares one. */
  key?: string;
  computed?: boolean;
}

/**
 * The whole list, for a vault.
 *
 * Constant rows first in their declared order, then one block per template. Not
 * a ranking — the filter narrows this and never reorders it, so a row's place is
 * stable and worth learning (C8).
 */
export function paletteFor(axes: readonly PaletteAxis[]): PaletteEntry[] {
  const rows: PaletteEntry[] = [...PALETTE];
  for (const t of AXIS_TEMPLATES) {
    for (const axis of axes) {
      if (axis.computed && !t.computed) continue;
      rows.push({
        id: `${t.id}:${axis.name}`,
        label: t.label(axis.label),
        command: t.command(axis.name),
        ...(axis.key && t.keys ? { keys: t.keys(axis.key) } : {}),
      });
    }
  }
  return rows;
}

/**
 * The palette's rows: the bindings that are acts, then the acts with no binding.
 *
 * Derived, so there is no list to keep in step — a binding that gains a
 * `palette:` label appears here, and one that loses it goes. Declared order, not
 * a ranking: the filter narrows this list and never reorders it, so where a row
 * sat is where it stays (C8).
 */
export const PALETTE: readonly PaletteEntry[] = [
  ...BINDINGS.filter((b) => b.palette).map((b) => ({
    id: b.id,
    label: b.palette!,
    command: b.command,
    keys: b.glyph ?? b.stroke,
  })),
  ...ACTS.map((a) => ({ id: a.id, label: a.palette, command: a.command, ...(a.keys ? { keys: a.keys } : {}) })),
];

/** Which shapes offer motion. A canvas is a plane; `j` has no meaning on it. */
export const MOVES: readonly Shape[] = ['board', 'table'];
