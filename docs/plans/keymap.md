# Plan: a keymap

**Status:** agreed, not built. Stage 0 landed (`Palette` answers Escape itself).

## The problem

There is no keymap. There is a *grammar* — `bind()` in `src/view/keys.ts`, pure and well tested — but
which physical stroke means which act is spread across four kinds of place that do not know about
each other:

| where | what it decides | configurable |
|---|---|---|
| `bind()` in `src/view/keys.ts` | every global stroke, as `stroke.key === '…'` literals | no |
| `facets.yaml` `key:` | which letter follows `g` / `,` for an axis | yes — the only part that is |
| a field's own `onKeyDown` — `Palette`, `Sidebar`'s search, `CommitInput`, `NotePanel`'s title, `Declined` | every stroke while focus is inside it, because `bind` stands aside for a field | no |
| CodeMirror's keymap in `useDocumentEditor` | every stroke inside a document editor | no |

Two consequences, both already observed:

- **Adding a synonym is a four-file edit.** `esc` and `ctrl-c` should be one act with two strokes. On
  macOS `ctrl-c` is not copy and the pairing is idiomatic; on Windows and Linux it is copy, so the
  synonym is platform-conditional — which is a fact a table can hold and a `===` cannot.
- **A field can silently swallow a global key.** `bind` returns `nothing` when `inField`
  (`src/view/keys.ts:509`), so the shell's Escape chain could not fire while the palette — which opens
  with focus in its own input — was open. Escape did nothing at all, and nothing failed: no test can
  catch a key that is never delivered to the thing under test.

## Shape

Four stages, each shippable and useful alone.

### 1 — Name the acts, normalise the strokes

`Command` is already a closed union; `paletteFor` already half-derives a table from it. Promote that to
the real thing: one `ACTS` table of act → label, and two pure functions in `view/` —

- `strokeOf(e: KeyStroke): string` → a canonical form: `esc`, `ctrl-c`, `shift-g`, `,` `s`.
- `parse(spec: string): KeyStroke` → the reverse, for reading a table.

`bind()` is rewritten to look the normalised stroke up in a map instead of comparing literals. No
behaviour change, no new surface, and the DOM stays out of `view/`.

### 2 — The default keymap as data

One `DEFAULTS: Record<Act, string[]>` — a **list** per act, so synonyms cost a comma. `esc: ['esc',
'ctrl-c']` becomes the one-line change it should be, gated on platform where it must be.

The cheatsheet and the palette's key column then read from the same table rather than from strings
written beside them, which retires the standing worry in `Palette`'s own doc comment about being a
second copy of the keyboard. **`C8` implication:** the cheatsheet must show *every* stroke bound to an
act, not the first, or two readers describing the same key will disagree.

Stages 1–2 alone deliver `ctrl-c`.

### 3 — Scopes, so a field stops being a special case

This is the structural win. `inField` stops being a veto and becomes a *scope*: a stroke resolves
against the innermost active scope and falls through to the next when that scope declares it
unhandled. Roughly `field` → `overlay` → `shell`.

`Palette` then declares `{esc: close, down: next, up: prev, enter: run}` and inherits the rest; its
`onKeyDown` and `Declined`'s `window` listener both disappear, and so does the whole class of bug where
a surface opened over the view has no keyboard because focus happens to sit somewhere the shell ignores.

Two things need care and neither is optional:

- **The panel's unsaved-changes prompt.** `NotePanel` owns Escape because closing can be refused. In
  scope terms that is a scope that handles the act and may decline to complete it — not one that
  passes it up.
- **CodeMirror keeps its own keymap** and should keep owning Escape inside a dirty document. The scope
  boundary is the editor, not the key.

### 4 — Vault overrides

`.projector/keys.yaml`, merged over `DEFAULTS`, validated the way `facets.yaml` is
(`src/view/validate.ts`): an unknown act, an unparseable stroke, and a collision *within one scope* are
all load-time errors, not surprises at press time. Served on `meta`, so `bind`, the cheatsheet and the
palette cannot disagree about what is bound.

## Costs, named up front

- **`ctrl-c` is copy off macOS.** Bind it per platform, and defer to the browser when a text selection
  exists — a synonym that eats copy is worse than no synonym.
- **Every surface with a keymap must appear in the cheatsheet**, or stage 3 has moved the problem
  rather than solved it.
- **A vault that rebinds is a vault whose screenshots and manual are wrong.** MANUAL's keymap section
  documents the defaults and must say so once, in those words.

## What this does not do

It does not make acts scriptable, and does not add a `pj keys` command. An act is reachable by key, by
palette, and by pointer; a third caller is a different question — see [NEXT.md](../NEXT.md).
