import { useState } from 'react';
import type { FacetDef } from '../types.ts';

/**
 * Edit one facet's values against the vocabulary in facets.yaml.
 *
 * A closed facet offers exactly its declared values; an open one also accepts a
 * new value typed in. Every facet is multi-valued, so this is a toggle list
 * rather than a single-choice control — that is the model, not a convenience.
 * `project` is an ordinary facet here, which is why it needs no special handling.
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

  const toggle = (v: string) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);

  const addNew = () => {
    const v = adding.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setAdding('');
  };

  // Values already on the card that the vocabulary does not declare — shown so
  // they can be removed rather than silently hidden.
  const extras = values.filter((v) => !def.values.includes(v));

  return (
    <div className="facetedit">
      <div className="facetedit-label">
        {def.label}
        {def.open && <span className="facetedit-open" title="new values allowed">open</span>}
      </div>
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
      {def.scope?.under && (
        <div className="facetedit-scope">only beneath {def.scope.under}</div>
      )}
      <input type="hidden" name={name} />
    </div>
  );
}
