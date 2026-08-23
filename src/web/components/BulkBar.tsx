import { useState } from 'react';
import { ApiError, api } from '../api.ts';
import { plural } from '../plural.ts';
import { NONE } from '../../schema/vocabulary.ts';
import { RecordPicker } from './RecordPicker.tsx';
import { Button } from './Button.tsx';
import { useHue, useVocabulary } from '../vocabulary.tsx';
import type { QueryResponse } from '../types.ts';

/**
 * Bulk actions across a selection — what makes cleaning 130 imported cards
 * feasible, and structure-only, so it stays on the gesture side of C10.
 *
 * The facet list comes from the query's own histogram, so it offers the axes
 * actually present in what is on screen rather than the whole vocabulary.
 */
export function BulkBar({
  ids,
  counts,
  onDone,
  onClear,
  onProblem,
}: {
  ids: string[];
  counts: QueryResponse['counts'];
  onDone: () => void;
  onClear: () => void;
  onProblem: (m: string) => void;
}) {
  /**
   * Pointing a selection at one note: the vault's first *single-valued*
   * relation, which is what "put all of these under one thing" means.
   *
   * The button said "Set parent…" and posted a bulk op named `parent`, which was
   * an ordinary facet write wearing a facet's name — so a vault that calls its
   * containment relation something else had a button for a facet it does not
   * have, and no button for the one it does.
   */
  const facets = useVocabulary();
  const container = Object.entries(facets).find(([, d]) => d.type === 'ref' && d.single)?.[0];
  const [pickRelation, setPickRelation] = useState(false);
  const [facet, setFacet] = useState('');
  const editable = counts.filter((c) => !c.computed);
  const chosen = editable.find((c) => c.facet === facet);
  const hue = useHue(facet);

  const run = (fn: () => Promise<unknown>) =>
    fn()
      .then(onDone)
      .catch((e: ApiError) => onProblem(e.message));

  return (
    <div className="bulkbar">
      <span className="bulkbar-count">{ids.length} selected</span>

      {container && (
        <Button size="small" onClick={() => setPickRelation((v) => !v)}>
          Set {facets[container]!.label.toLowerCase()}…
        </Button>
      )}

      <select className="bulkbar-select" value={facet} onChange={(e) => setFacet(e.target.value)}>
        <option value="">set a facet…</option>
        {editable.map((c) => (
          <option key={c.facet} value={c.facet}>
            {c.label}
          </option>
        ))}
      </select>
      {chosen && (
        <span className="bulkbar-values">
          {chosen.values
            .filter((v) => v.value !== NONE)
            .map((v) => (
              <button
                key={v.value}
                // The axis's own family, from the same vocabulary the card face
                // and the panel read. These chips name values of the facet
                // chosen in the select beside them, so they are properties of
                // notes exactly as the panel's are — a hueless chip here would
                // put the same value in two colours on one screen, which is the
                // drift one source is shared to prevent.
                className={`togglechip ${hue}`}
                onClick={() =>
                  void run(() => api.bulk({ ids, op: 'facet', facet, values: [v.value], mode: 'set' }))
                }
              >
                {v.value}
              </button>
            ))}
          <button
            className="togglechip is-clear"
            onClick={() => void run(() => api.bulk({ ids, op: 'facet', facet, values: [], mode: 'set' }))}
          >
            clear
          </button>
        </span>
      )}

      <Button
        tone="danger" size="small"
        onClick={() => {
          if (!confirm(`Delete ${plural(ids.length, 'card')}?\n\nThe files are in git, so this is recoverable.`))
            return;
          void run(() => api.bulk({ ids, op: 'delete' }));
        }}
      >
        Delete
      </Button>
      <Button tone="ghost" size="small" onClick={onClear}>
        Clear selection
      </Button>

      {pickRelation && container && (
        <div className="bulkbar-picker">
          <RecordPicker
            exclude={ids}
            placeholder={`${facets[container]!.label.toLowerCase()} for all selected…`}
            onCancel={() => setPickRelation(false)}
            onPick={(pid) => {
              setPickRelation(false);
              void run(() =>
                api.bulk({ ids, op: 'facet', facet: container, values: pid ? [pid] : [], mode: 'set' }),
              );
            }}
          />
        </div>
      )}
    </div>
  );
}
