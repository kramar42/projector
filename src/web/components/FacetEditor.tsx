import { useState } from 'react';
import { RecordPicker } from './RecordPicker.tsx';
import type { FacetDef } from '../types.ts';

/**
 * Edit one facet's values against the vocabulary in facets.yaml.
 *
 * A closed facet offers exactly its declared values; an open one also accepts a
 * new value typed in. A `single` facet picks one and replaces rather than
 * accumulating, so `status` cannot end up holding `planning` and `done` at once.
 *
 * A **reference** facet holds record ids, so its vocabulary is the whole vault
 * and a toggle list is the wrong control — it picks a record instead. That falls
 * out of `ref`, so `project` needs no handling of its own here, and a reference
 * facet declared tomorrow gets the same editor for free.
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
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState('');
  const [picking, setPicking] = useState(false);

  const toggle = (v: string) => {
    if (values.includes(v)) return onChange(values.filter((x) => x !== v));
    onChange(def.single ? [v] : [...values, v]);
  };

  const addNew = () => {
    const v = adding.trim();
    if (!v || values.includes(v)) return;
    onChange(def.single ? [v] : [...values, v]);
    setAdding('');
  };

  // Values already on the card that the vocabulary does not declare — shown so
  // they can be removed rather than silently hidden.
  const extras = values.filter((v) => !def.values.includes(v));

  if (def.ref) {
    return (
      <div className="facetedit">
        <div className="facetedit-label">{def.label}</div>
        <div className="facetedit-values">
          {values.map((v) => (
            <button key={v} className="togglechip is-on" onClick={() => toggle(v)} title="remove">
              {v}
            </button>
          ))}
          {picking ? null : (
            <button className="btn ghost small" onClick={() => setPicking(true)}>
              + record
            </button>
          )}
        </div>
        {picking && (
          <RecordPicker
            exclude={values}
            placeholder={`${def.label.toLowerCase()}…`}
            onCancel={() => setPicking(false)}
            onPick={(id) => {
              setPicking(false);
              if (id) onChange(def.single ? [id] : [...values, id]);
            }}
          />
        )}
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
