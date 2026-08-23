import { useState } from 'react';
import { ApiError, api } from '../api.ts';
import { plural } from '../plural.ts';
import { NONE } from '../../schema/vocabulary.ts';
import { RecordPicker } from './RecordPicker.tsx';
import { Button } from './Button.tsx';
import { FACET_TONE } from './CardBody.tsx';
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
  const [pickParent, setPickParent] = useState(false);
  const [facet, setFacet] = useState('');
  const editable = counts.filter((c) => !c.pseudo);
  const chosen = editable.find((c) => c.facet === facet);

  const run = (fn: () => Promise<unknown>) =>
    fn()
      .then(onDone)
      .catch((e: ApiError) => onProblem(e.message));

  return (
    <div className="bulkbar">
      <span className="bulkbar-count">{ids.length} selected</span>

      <Button size="small" onClick={() => setPickParent((v) => !v)}>
        Set parent…
      </Button>

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
                // The axis's own family, from the same map the card face and the
                // panel read. These chips name values of the facet chosen in the
                // select beside them, so they are properties of records exactly
                // as the panel's are — a hueless chip here would put the same
                // value in two colours on one screen, which is the drift the map
                // is shared to prevent.
                className={`togglechip ${FACET_TONE[facet] ?? 'facet-muted'}`}
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

      {pickParent && (
        <div className="bulkbar-picker">
          <RecordPicker
            exclude={ids}
            placeholder="parent for all selected…"
            onCancel={() => setPickParent(false)}
            onPick={(pid) => {
              setPickParent(false);
              void run(() => api.bulk({ ids, op: 'parent', parent: pid }));
            }}
          />
        </div>
      )}
    </div>
  );
}
