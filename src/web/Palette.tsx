import { useEffect, useMemo, useRef, useState } from 'react';
import { paletteFor, type Command, type PaletteAxis } from '../view/keys.ts';
import { fuzzy } from '../view/fuzzy.ts';
import { useDialogFocus } from './components/useDialogFocus.ts';
import type { Meta } from './types.ts';

/**
 * Every act, by name, for the ones with no key.
 *
 * **What it is not** is a second copy of the keyboard. `PALETTE` is derived from
 * the binding registry, so a row exists here because a binding declared a label
 * or because `ACTS` names an act with no stroke — there is no list to keep in
 * step, which was the standing objection to building this at all.
 *
 * Its actual job is every named action that does not earn a dedicated stroke:
 * renaming, the project toggle, re-fetching links, switching vault, clearing a
 * selection, calendar paging, canvas actions and saved-view changes. A command
 * does not duplicate every *instance* of a control — every filter value, card and
 * link already has to be chosen in the surface that gives it context. Everything
 * else it lists is there to *teach* — each row shows the key that also reaches it,
 * so using the palette is how you stop needing it.
 *
 * **The filter narrows and never reorders.** `fuzzy` matches letters in order and
 * returns no score, so the list is always in `PALETTE`'s declared order and a row
 * you have learned the position of stays there (C8).
 */
export function Palette({
  meta,
  onRun,
  onClose,
}: {
  meta: Meta;
  onRun: (command: Command) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);

  /**
   * The vault's axes, which is the half no table could hold.
   *
   * An axis is offered whether or not it declares a `key:`, and the letterless
   * ones are the point: twenty-six letters do not stretch to an arbitrary
   * vocabulary, and before this they were reachable by pointer alone.
   */
  const axes: PaletteAxis[] = useMemo(
    () => [
      ...Object.entries(meta.facets).map(([name, def]) => ({
        name,
        label: def.label,
        ...(def.key ? { key: def.key } : {}),
      })),
      ...meta.computed.map((c) => ({ name: c.name, label: c.label, computed: true })),
    ],
    [meta],
  );

  const all = useMemo(() => paletteFor(axes), [axes]);
  const rows = useMemo(() => all.filter((e) => fuzzy(q.trim(), e.label)), [all, q]);
  /** The list shrinks as you type, so the cursor has to be pulled back with it. */
  const here = Math.min(at, Math.max(0, rows.length - 1));

  /**
   * The walk scrolls the list under the cursor, because the list is taller than
   * its box and the cursor was walking off the bottom of it. `nearest` so a row
   * already on screen does not move the list, which is the same bargain the board
   * makes in `cursor.ts`.
   */
  const list = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);
  useEffect(() => {
    list.current?.querySelector('.is-here')?.scrollIntoView({ block: 'nearest' });
  }, [here, rows.length]);

  const run = (command: Command) => {
    // Closed *before* the act, because several of them open something else — the
    // vault picker, the filter rail, the panel's rename editor — and a palette
    // still on screen would be covering the thing it just opened.
    onClose();
    onRun(command);
  };

  return (
    <>
      <div className="scrim cheatsheet-scrim" onClick={onClose} />
      <div ref={dialog} className="cheatsheet palette" role="dialog" aria-modal="true" aria-label="Commands" tabIndex={-1}>
        <input
          className="palette-input"
          autoFocus
          value={q}
          placeholder="what do you want to do?"
          aria-label="Filter commands"
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          /*
           * The field owns its keys, which is why this is here and not in the
           * shell: `inField` hands every stroke to whatever is being typed into,
           * so the walk, the commit *and the exit* have to be the field's own.
           *
           * Escape used to be left to the shell's chain, on the reasoning that
           * one place should decide what it means. The reasoning was right and
           * the arrangement was wrong: the palette opens with focus in this
           * input, `bind` stands aside for a field before it ever reaches the
           * chain, and so the chain's palette link could not fire while the
           * palette was open. Escape did nothing at all. Until a keymap makes
           * the exit a binding rather than a literal, a field that opens focused
           * closes itself — the same bargain `Sidebar`'s search box makes.
           */
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
              e.preventDefault();
              setAt(Math.min(here + 1, rows.length - 1));
            } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
              e.preventDefault();
              setAt(Math.max(here - 1, 0));
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const row = rows[here];
              if (row) run(row.command);
            }
          }}
        />

        <div ref={list} className="palette-list" data-navlist="palette" data-nav-flow="column">
          {rows.map((e, i) => (
            <button
              key={e.id}
              className={`palette-row ${i === here ? 'is-here' : ''}`}
              data-nav="pick"
              /* The pointer moves the cursor rather than having one of its own,
                 for the reason the board gives: two pointers is one too many. */
              onMouseMove={() => setAt(i)}
              onClick={() => run(e.command)}
            >
              <span className="truncate palette-label">{e.label}</span>
              {e.keys && <span className="palette-keys">{e.keys}</span>}
            </button>
          ))}
          {!rows.length && <div className="emptystate palette-empty">no command matches</div>}
        </div>
        <button type="button" className="palette-row" onClick={onClose}>
          <span className="palette-label">close commands</span>
          <span className="palette-keys">esc</span>
        </button>
      </div>
    </>
  );
}
