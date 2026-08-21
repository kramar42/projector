import { useState } from 'react';
import { RecordPicker } from './RecordPicker.tsx';
import type { CardDetail, FacetDef } from '../types.ts';
import type { FacetMode } from '../panel/write.ts';
import { Button, IconButton } from './Button.tsx';

/**
 * Edit one facet's values against the vocabulary in facets.yaml.
 *
 * A closed facet offers exactly its declared values; an open one also accepts a
 * new value typed in. A `single` facet picks one and replaces rather than
 * accumulating, so `status` cannot end up holding `planning` and `done` at once.
 *
 * The **type** picks the control, so no facet is named here: a reference holds
 * record ids and gets a record picker, a date gets a date input, and everything
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
 * An axis carrying nothing draws its label and stops. The vocabulary is a
 * *picker*, not a readout: thirteen axes rendered whole is 48 chips of which
 * four are usually lit, so the panel spent its first screen restating
 * facets.yaml instead of describing the card. This is the disclosure the filter
 * rail already uses, on the same rule — an axis you are using stays open.
 */
export function FacetEditor({
  name,
  def,
  values,
  refs,
  selfId,
  onChange,
  onOpen,
}: {
  name: string;
  def: FacetDef;
  values: string[];
  /** Titles for reference values. Absent for a label or date axis. */
  refs?: CardDetail['refs'];
  /** The card being edited, so it cannot be made its own reference. */
  selfId?: string;
  onChange: (next: string[], mode: FacetMode) => void;
  onOpen?: (id: string) => void;
}) {
  const [adding, setAdding] = useState('');
  const [picking, setPicking] = useState(false);
  // Same rule as the filter rail: an axis you are using is open, one you are
  // not starts collapsed. A date counts as carried when it holds a value.
  const [open, setOpen] = useState(values.length > 0);

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

  // Values already on the card that the vocabulary does not declare — shown so
  // they can be removed rather than silently hidden.
  const extras = values.filter((v) => !def.values.includes(v));

  const head = (
    <button className="facetedit-head" onClick={() => setOpen((v) => !v)}>
      <span className={`facet-caret ${open ? 'is-open' : ''}`} aria-hidden="true" />
      <span className="facetedit-label">{def.label}</span>
      {!open && values.length > 0 && <span className="facetedit-count">{values.length}</span>}
    </button>
  );

  const body = () => {
    if (def.type === 'ref') {
      return (
        <>
          <div className="facetedit-values">
            {values.map((v) => (
              // A reference is a record, so it reads as one: the title, and a
              // click that goes there. Removing is its own mark — the row used
              // to remove on click and say so only in a hover title, which put
              // "go to this card" and "unlink this card" on the same gesture.
              <span key={v} className="refchip">
                {/* `▣` when the record owns a project block, `·` otherwise. The
                    `○` case needs a child count this payload does not carry, and
                    inventing a fourth mark to cover that would be worse than
                    under-reporting with the vocabulary that already exists. */}
                <span
                  className={`recordmark ${refs?.[v]?.isProject ? 'is-project' : 'is-leaf'}`}
                  aria-hidden="true"
                >
                  {refs?.[v]?.isProject ? '▣' : '·'}
                </span>
                <button className="refchip-go" onClick={() => onOpen?.(v)} title={v}>
                  {refs?.[v]?.title ?? v}
                </button>
                <IconButton glyph="close" title={`remove ${refs?.[v]?.title ?? v}`} onClick={() => drop(v)} />
              </span>
            ))}
            {!picking && (
              <Button tone="ghost" size="small" onClick={() => setPicking(true)}>
                + record
              </Button>
            )}
          </div>
          {picking && (
            <RecordPicker
              exclude={selfId ? [...values, selfId] : values}
              placeholder={`${def.label.toLowerCase()}…`}
              clearLabel={def.single && values.length ? `— no ${def.label.toLowerCase()} —` : undefined}
              onCancel={() => setPicking(false)}
              onPick={(id) => {
                setPicking(false);
                if (id) take(id);
                else onChange([], 'set');
              }}
            />
          )}
        </>
      );
    }

    if (def.type === 'date') {
      // A date is single by nature: there is one value, and setting it replaces.
      return (
        <div className="facetedit-values">
          <input
            type="date"
            className="dateinput"
            value={values[0] ?? ''}
            onChange={(e) => onChange(e.target.value ? [e.target.value] : [], 'set')}
          />
          {values[0] && (
            <Button tone="ghost" size="small" onClick={() => onChange([], 'set')}>
              clear
            </Button>
          )}
        </div>
      );
    }

    return (
      <div className="facetedit-values">
        {/* No "open" badge: the `+ new` field is present exactly when new values
            are accepted, so it already says so. */}
        {[...def.values, ...extras].map((v) => (
          <button
            key={v}
            className={`togglechip ${values.includes(v) ? 'is-on' : ''} ${
              def.values.includes(v) ? '' : 'is-extra'
            }`}
            onClick={() => toggle(v)}
          >
            {v}
          </button>
        ))}
        {def.open && (
          <span className="facetedit-add">
            <input
              value={adding}
              placeholder="+ new"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addNew();
                if (e.key === 'Escape') setAdding('');
              }}
            />
          </span>
        )}
      </div>
    );
  };

  return (
    <div className={`facetedit ${values.length ? 'is-carried' : ''}`}>
      {head}
      {open && body()}
      <input type="hidden" name={name} />
    </div>
  );
}
