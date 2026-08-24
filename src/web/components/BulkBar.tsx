import { useState } from 'react';
import { ApiError, api } from '../api.ts';
import { plural } from '../plural.ts';
import { NONE } from '../../schema/vocabulary.ts';
import { RecordPicker } from './RecordPicker.tsx';
import { RecordMark } from './CardBody.tsx';
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
  notes,
  counts,
  onDone,
  onClear,
  onProblem,
}: {
  ids: string[];
  /**
   * The notes on screen, for the one action here that has to name them: choosing
   * which of a selection survives a merge. Every other control works on ids alone.
   */
  notes: QueryResponse['notes'];
  counts: QueryResponse['counts'];
  onDone: () => void;
  onClear: () => void;
  onProblem: (m: string) => void;
}) {
  const facets = useVocabulary();
  /**
   * Merging asks one question — which note survives — and it can only be answered
   * from inside the selection, so this lists what is selected rather than reusing
   * the `RecordPicker` beside it. Picking any other note would not be a merge.
   */
  const [merging, setMerging] = useState(false);
  const [facet, setFacet] = useState('');
  const editable = counts.filter((c) => !c.computed);
  const chosen = editable.find((c) => c.facet === facet);
  /**
   * **Every facet is edited through the control its type picks** — the rule the
   * note panel has always followed, arriving here.
   *
   * A reference facet's values are notes, so the thing that picks one is the note
   * picker. Drawn as value chips they were ids, and only the ids that happened to
   * occur in the current result set: on a board of 27 notes the histogram offered
   * `parent` exactly one pickable value. That is what the bar had a *second*
   * control for — a "Set part of…" button, hard-wired to the vault's first
   * single-valued relation, which searched every note and did the same write. So
   * the generic path was unusable for references and the usable path reached
   * exactly one of them: `project` and `blocked_by` had neither.
   *
   * `single` decides what a pick *means*, because cardinality is vocabulary. One
   * slot can only be replaced. An axis that holds several would silently drop the
   * memberships nobody mentioned, so a pick adds to it and the `clear` chip beside
   * it is how you empty one — which is also the answer to "and how do I undo
   * that", and the reason `clear` is drawn for every facet rather than only the
   * ones with chips.
   */
  const def = facets[facet];
  const picksANote = def?.type === 'ref';
  /** A reference facet's values are drawn by the picker below, never as chips. */
  const chips = chosen && !picksANote ? chosen.values.filter((v) => v.value !== NONE) : [];
  const hue = useHue(facet);

  const run = (fn: () => Promise<unknown>) =>
    fn()
      .then(onDone)
      .catch((e: ApiError) => onProblem(e.message));

  return (
    <div className="bulkbar">
      <span className="bulkbar-count">{ids.length} selected</span>

      {/* One picker floats above the bar at a time: choosing an axis to write and
          choosing which note survives a merge are different questions, and the
          two would land on top of each other. */}
      <select
        className="bulkbar-select"
        value={facet}
        onChange={(e) => {
          setMerging(false);
          setFacet(e.target.value);
        }}
      >
        <option value="">set a facet…</option>
        {editable.map((c) => (
          <option key={c.facet} value={c.facet}>
            {c.label}
          </option>
        ))}
      </select>
      {chosen && (
        <span className="bulkbar-values">
          {chips.map((v) => (
            <button
              key={v.value}
              // The axis's own family, from the same vocabulary the card face and
              // the panel read. These chips name values of the facet chosen in the
              // select beside them, so they are properties of notes exactly as the
              // panel's are — a hueless chip here would put the same value in two
              // colours on one screen, which is the drift one source is shared to
              // prevent.
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

      {/* Two notes are the least that can be merged, so with one selected there is
          no question to ask and no button to ask it with. */}
      {ids.length > 1 && (
        <Button
          size="small"
          onClick={() => {
            setFacet('');
            setMerging((v) => !v);
          }}
        >
          Merge…
        </Button>
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

      {merging && (
        <div className="bulkbar-picker">
          <div className="picker">
            <div className="picker-ask">
              Keep which one? The others are folded into it and their files removed.
            </div>
            <div className="picker-list">
              {ids.map((id) => {
                const note = notes[id];
                return (
                  <button
                    key={id}
                    className="picker-item"
                    onClick={() => {
                      const others = ids.filter((other) => other !== id);
                      if (
                        !confirm(
                          `Merge ${plural(others.length, 'note')} into "${note?.title ?? id}"?\n\n` +
                            'Their bodies become sections, their links and references move across, ' +
                            'and their files are removed. The files are in git, so this is recoverable.',
                        )
                      )
                        return;
                      setMerging(false);
                      void run(() => api.bulk({ ids: others, op: 'merge', into: id }));
                    }}
                  >
                    {/* The real mark, as the record picker draws it: it says
                        whether anything hangs off this note, which is the fact
                        that decides which of two notes should be the survivor. */}
                    {note && <RecordMark card={note} />}
                    <span className="truncate picker-title">{note?.title ?? id}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {chosen && picksANote && (
        <div className="bulkbar-picker">
          <RecordPicker
            // A note in the selection would be pointing at itself, which no
            // reference facet may say.
            exclude={ids}
            placeholder={
              def.single
                ? `${def.label.toLowerCase()} for all selected…`
                : `add ${def.label.toLowerCase()} to all selected…`
            }
            onCancel={() => setFacet('')}
            onPick={(pid) => {
              setFacet('');
              void run(() =>
                api.bulk({
                  ids,
                  op: 'facet',
                  facet,
                  values: pid ? [pid] : [],
                  mode: def.single || !pid ? 'set' : 'add',
                }),
              );
            }}
          />
        </div>
      )}
    </div>
  );
}
