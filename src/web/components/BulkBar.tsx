import { useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { plural } from '../plural.ts';
import { NONE } from '../../schema/vocabulary.ts';
import { RecordPicker } from './RecordPicker.tsx';
import { RecordMark } from './CardBody.tsx';
import { Button } from './Button.tsx';
import { useEdgeInset } from '../cursor.ts';
import { useHue, useVocabulary } from '../vocabulary.tsx';
import type { QueryResponse } from '../types.ts';

/**
 * Bulk actions across a selection — what makes cleaning 130 imported notes
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
   * The bar floats over the surface it belongs to rather than taking a row of it,
   * so that a selection appearing does not make the whole board jump — and a card
   * scrolled to the bottom edge landed underneath it, because `scrollIntoView`
   * cannot see anything that does not displace the box. So the bar says how much of
   * the bottom it is standing on, and the scrollers inside the same surface read it
   * as `scroll-padding`. Its parent is that surface — the table shell, the board
   * wrap — which is why nothing has to be passed in.
   */
  const bar = useRef<HTMLDivElement>(null);
  useEdgeInset(bar, 'bottom');
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
    <div className="bulkbar" data-navlist="bulk" data-nav-flow="row" ref={bar}>
      <span className="bulkbar-count">{ids.length} selected</span>

      {/* One picker floats above the bar at a time: choosing an axis to write and
          choosing which note survives a merge are different questions, and the
          two would land on top of each other. */}
      <select
        className="bulkbar-select"
        data-nav="facet"
        data-rail="bulk"
        value={facet}
        onChange={(e) => {
          setMerging(false);
          setFacet(e.target.value);
        }}
      >
        <option value="">Set a facet…</option>
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
              data-nav="value"
              onClick={() =>
                void run(() => api.bulk({ ids, op: 'facet', facet, values: [v.value], mode: 'set' }))
              }
            >
              {v.value}
            </button>
          ))}
          <button
            className="togglechip is-clear"
            data-nav="value"
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
          data-nav="act"
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
        // What `⌫` presses when there is a selection, aimed at rather than
        // reimplemented — so the count in the confirm and the ids in the request
        // are one list, and the keyboard cannot reach the delete without the
        // question. See `remove` in `App.tsx`.
        data-act="delete"
        onClick={() => {
          if (!confirm(`Delete ${plural(ids.length, 'note')}?\n\nThe files are in git, so this is recoverable.`))
            return;
          void run(() => api.bulk({ ids, op: 'delete' }));
        }}
      >
        Delete
      </Button>
      <Button tone="ghost" size="small" data-nav="act" onClick={onClear}>
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
                    data-nav="pick"
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
            // The label is the vault's string and arrives already cased, so the
            // sentence is built around it rather than over it: a verb first, and
            // the axis named as what it is.
            placeholder={
              def.single ? `set ${def.label} on all selected…` : `add ${def.label} to all selected…`
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
