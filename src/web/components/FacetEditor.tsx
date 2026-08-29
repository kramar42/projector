import { useState } from 'react';
import { RecordPicker } from './RecordPicker.tsx';
import { PopoverButton } from './Popover.tsx';
import type { NoteDetail, FacetDef } from '../types.ts';
import type { FacetMode } from '../panel/write.ts';
import { Button, IconButton } from './Button.tsx';
import { RecordMark } from './CardBody.tsx';
import { useHue } from '../vocabulary.tsx';
import { KeyHint } from './KeyHint.tsx';
import { isAppAxis } from '../hue.ts';

/**
 * Edit one facet's values against the vocabulary in facets.yaml.
 *
 * A closed facet offers exactly its declared values; an open one also accepts a
 * new value typed in. A `single` facet picks one and replaces rather than
 * accumulating, so `status` cannot end up holding `planning` and `done` at once.
 *
 * The **type** picks the control, so no facet is named here: a reference holds
 * note ids and gets a note picker, a date gets a date input, and everything
 * else gets the toggle list. `due` needed a bespoke field in the panel before it
 * was typed; now a date facet declared tomorrow gets the same editor for free.
 *
 * What each control *says* matters as much as what it draws. A control that
 * replaces an axis says `set`; a toggle on a multi-valued axis says `add` or
 * `remove`. The difference is a lost update: this component knows the axis only
 * as of its last render, so "the axis is now exactly this" reverts a value an
 * agent added a moment ago — inside the write gate's tolerance, with nothing to
 * report. A delta cannot.
 *
 * **There is no disclosure here any more.** An axis carrying nothing used to
 * draw a collapsed head, so thirteen axes drew thirteen rows and nine of them
 * said only their own name — the panel restating facets.yaml instead of
 * describing the note. The caller now renders a row only for an axis that is
 * carried or was asked for, which is the filter rail's own policy ("empty facets
 * are absent"), and what is left needs no caret: a row is here because it has
 * something to show.
 *
 * That also retired the last `font-family`-less button in the app. `.facetedit-head`
 * was a `<button>` declaring no font, so when the label's explicit `--mono` was
 * removed to match the rail, the label fell through to the UA form-control font
 * and rendered in Arial — the divergence the change set out to close, in a font
 * belonging to neither stack. A label in a grid cell inherits from the panel.
 */
export function FacetEditor({
  name,
  lit = false,
  def,
  values,
  refs,
  selfId,
  onChange,
  onOpen,
}: {
  /**
   * The axis's key, which is what its hue is looked up by.
   *
   * It was not passed before, and could not be: `FacetDef` carries the label and
   * the vocabulary but not its own name, so the editor knew every fact about an
   * axis except which one it was — and drew every lit value in the accent as a
   * result. The accent is the app speaking; a value of a note is drawn in that
   * note's axis's family.
   */
  name: string;
  /**
   * This axis just moved and the reader did not move it — wash the row.
   *
   * The row and not the chip: which value is new is exactly what the reader should
   * find for themselves, and lighting the changed chip would be the app reading it
   * out to them. Lighting the row puts their eye in the right place and stops.
   */
  lit?: boolean;
  def: FacetDef;
  values: string[];
  /** Titles for reference values. Absent for a label or date axis. */
  refs?: NoteDetail['refs'];
  /** The note being edited, so it cannot be made its own reference. */
  selfId?: string;
  onChange: (next: string[], mode: FacetMode) => void;
  /** Modifiers ride along: ⌥ pins the target, ⇧ pins this note and follows. */
  onOpen?: (id: string, mods?: { altKey?: boolean; shiftKey?: boolean }) => void;
}) {
  const [adding, setAdding] = useState('');

  /**
   * Taking a value on. A single-valued axis genuinely replaces, so it is the one
   * case that may say `set`; a multi-valued one only ever adds to whatever is
   * there, which it does not need to have seen.
   */
  const take = (v: string) => (def.single ? onChange([v], 'set') : onChange([v], 'add'));
  const drop = (v: string) => onChange([v], 'remove');

  const toggle = (v: string) => (values.includes(v) ? drop(v) : take(v));

  const addNew = () => {
    const v = adding.trim();
    if (!v || values.includes(v)) return;
    take(v);
    setAdding('');
  };

  // Values already on the note that the vocabulary does not declare — shown so
  // they can be removed rather than silently hidden.
  const extras = values.filter((v) => !def.values.includes(v));

  // The axis's family, which the chips wear rather than the accent. Hueless for
  // a hint axis and for anything the map does not name, exactly as a card face
  // resolves it — one map, so the two cannot disagree.
  const tone = useHue(name);
  /**
   * The app's own axis, which is the one allowed to draw in the accent.
   *
   * Off the definition rather than off the name: `builtin` is what says so, and
   * a client that knows a facet by name is the thing C4 rules out. The container
   * stays the panel's — a `.refchip` is a box with a go and an unlink — and only
   * the colour comes from the axis, which is the same division a label value
   * follows between a tinted face chip and a bordered toggle here.
   */
  const app = isAppAxis(def);

  const body = () => {
    if (def.type === 'ref') {
      return (
        <>
          {values.map((v) => (
            // A reference is a note, so it reads as one: the title, and a
            // click that goes there. Removing is its own mark — the row used
            // to remove on click and say so only in a hover title, which put
            // "go to this note" and "unlink this note" on the same gesture.
            <span key={v} className={`refchip ${app ? 'is-app' : ''}`}>
              {/* The mark sits inside the button, because it is part of the
                  note's identity rather than a control beside it — the same
                  order a card face and the panel title lead with, and the
                  arrangement the per-glyph optical nudges were measured for. */}
              <button
                className="refchip-go"
                data-nav="ref"
                // ⇧ means "pin this note and follow" — swallowed at mousedown
                // so the click does not also grow a text selection.
                onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                onClick={(e) => onOpen?.(v, { altKey: e.altKey, shiftKey: e.shiftKey })}
                title={v}
              >
                <RecordMark card={refs?.[v] ?? { isProject: false, refCount: 0 }} />
                <span className="truncate refchip-title">{refs?.[v]?.title ?? v}</span>
              </button>
              <IconButton glyph="close" title={`remove ${refs?.[v]?.title ?? v}`} onClick={() => drop(v)} />
            </span>
          ))}
          {/*
              A popover, like every other picker in the app.

              It used to render `inline`, in the flow of the panel — so opening it
              pushed the body, the links and the whole workshop tier down by the
              height of a forty-row list, and there was no way out but Escape. The
              component's own note gave the reason as one-region-scrolls-per-axis,
              which is an argument against a *scroller* inside the panel and not
              an argument for occupying it: the sidebar's focus rail has always
              floated this same picker in a popover, and `.popover .picker-list`
              exists precisely so the popover does the scrolling. Floating it here
              also makes the three add-controls in this panel — `+ facet`,
              `+ ref`, `+ note` — one gesture with one dismissal.
          */}
          <PopoverButton
            className="addbtn"
            minWidth={320}
            fitContent
            label="+ note"
            title={`add a note to ${def.label}`}
            render={(close) => (
              <RecordPicker
                exclude={selfId ? [...values, selfId] : values}
                placeholder={`${def.label}…`}
                clearLabel={def.single && values.length ? `— no ${def.label} —` : undefined}
                onCancel={close}
                onPick={(id) => {
                  close();
                  if (id) take(id);
                  else onChange([], 'set');
                }}
              />
            )}
          />
        </>
      );
    }

    if (def.type === 'date') {
      // A date is single by nature: there is one value, and setting it replaces.
      return (
        <>
          <input
            type="date"
            className="dateinput"
            value={values[0] ?? ''}
            onChange={(e) => onChange(e.target.value ? [e.target.value] : [], 'set')}
          />
          {values[0] && (
            // `small`, and measured rather than assumed: against the date input's
            // 22.67px a `small` ghost button is 25.67 and a `tiny` one 19.4, so
            // `tiny` is marginally further out, not closer. The two are vertically
            // centred and this is the one row with no chips in it to disagree
            // with — the date input's height is a native control's, not a step of
            // ours, which is the actual reason nothing here lines up exactly.
            <Button tone="ghost" size="small" onClick={() => onChange([], 'set')}>
              clear
            </Button>
          )}
        </>
      );
    }

    return (
      <>
        {/* No "open" badge: the `+ new` field is present exactly when new values
            are accepted, so it already says so. */}
        {[...def.values, ...extras].map((v) => (
          <button
            key={v}
            className={`togglechip ${tone} ${values.includes(v) ? 'is-on' : ''} ${
              def.values.includes(v) ? '' : 'is-extra'
            }`}
            /* Walkable, which is the whole keyboard path to an axis that declares
               no `key:`: `gf` enters the grid, `h`/`l` find the row, `j`/`k` and
               `⏎` pick the value. */
            data-nav="value"
            aria-pressed={values.includes(v)}
            onClick={() => toggle(v)}
          >
            {v}
          </button>
        ))}
        {def.open && (
          <span className="facetrow-add">
            <input
              value={adding}
              placeholder="+ new"
              /**
               * Walkable **only when it is the row's only control.**
               *
               * An axis that declares no values and accepts new ones — `owner`, in
               * the shipped vault — draws no chips at all, so without this the row
               * held nothing to land on: `gf` and `j` could not reach it, and
               * adding it with `gF` left focus nowhere.
               *
               * Not when there are chips beside it, and that is the whole of the
               * restraint. It is a text field, so it owns every key it is given —
               * `j` typed at it is a `j` — and putting one in the middle of a walk
               * that is otherwise all buttons would be a stop you have to press
               * Escape to get out of, on rows that have a perfectly good chip to
               * land on instead.
               */
              data-nav={[...def.values, ...extras].length ? undefined : 'new'}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addNew();
                if (e.key !== 'Escape') return;
                e.stopPropagation();
                // Clear, then leave — the rail's search box's rule, for the same
                // reason: a field the app cannot take keys back from has to hand
                // focus back itself, or the walk ends here.
                if (adding) return setAdding('');
                e.currentTarget.blur();
              }}
            />
          </span>
        )}
      </>
    );
  };

  return (
    // `data-axis` is how `g⟨key⟩` finds this row's chips. The keyboard addresses
    // an axis by the letter the *vault* declared, and this is where that letter
    // lands in the DOM — the client still names no facet.
    /* `row`: a facet's values are chips laid across the row, so `h`/`l` walk them
       and `j`/`k` step to the axis above or below — which is how they are drawn. */
    <div
      className={`facetrow ${lit ? 'is-touched' : ''}`}
      data-navlist="axis"
      data-nav-flow="row"
      data-axis={name}
    >
      <span className="facetrow-label">
        {def.label}
        {/* The axis's own letter, from the vault. An axis that declares none draws
            nothing, which is the half that stops you guessing at one. */}
        {def.key && (
          <KeyHint
            keys={def.key}
            means={`${def.key} then 1-9 sets ${def.label}; ${def.key}${def.key} opens it`}
          />
        )}
      </span>
      <div className="facetrow-values">{body()}</div>
    </div>
  );
}
