import { useState } from 'react';
import { RecordPicker } from './RecordPicker.tsx';
import type { FacetDef } from '../types.ts';
import type { FacetMode } from '../panel/write.ts';
import { Button } from './Button.tsx';

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
 */
export function FacetEditor({
  name,
  def,
  values,
  onChange,
}: {
  name: string;
  def: FacetDef;
  values: string[];
  onChange: (next: string[], mode: FacetMode) => void;
}) {
  const [adding, setAdding] = useState('');
  const [picking, setPicking] = useState(false);

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

  if (def.type === 'ref') {
    return (
      <div className="facetedit">
        <div className="facetedit-label">{def.label}</div>
        <div className="facetedit-values">
          {values.map((v) => (
            <button key={v} className="togglechip is-on" onClick={() => drop(v)} title="remove">
              {v}
            </button>
          ))}
          {picking ? null : (
            <Button tone="ghost" size="small" onClick={() => setPicking(true)}>
              + record
            </Button>
          )}
        </div>
        {picking && (
          <RecordPicker
            exclude={values}
            placeholder={`${def.label.toLowerCase()}…`}
            onCancel={() => setPicking(false)}
            onPick={(id) => {
              setPicking(false);
              if (id) take(id);
            }}
          />
        )}
        <input type="hidden" name={name} />
      </div>
    );
  }

  if (def.type === 'date') {
    // A date is single by nature: there is one value, and setting it replaces.
    return (
      <div className="facetedit">
        <div className="facetedit-label">{def.label}</div>
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
        <input type="hidden" name={name} />
      </div>
    );
  }

  return (
    <div className="facetedit">
      {/* No "open" badge: the `+ new` field is present exactly when new values are
          accepted, so it already says so. */}
      <div className="facetedit-label">{def.label}</div>
      <div className="facetedit-values">
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
      <input type="hidden" name={name} />
    </div>
  );
}
