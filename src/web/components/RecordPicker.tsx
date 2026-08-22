import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { RecordMark } from './CardBody.tsx';
import type { CardDTO } from '../types.ts';

/**
 * Pick a record.
 *
 * Used wherever a value *is* a record: setting a parent, and adding a value to a
 * reference facet. Projects sort first, since they are the usual landmarks —
 * which is also what makes this the right control for `project` without knowing
 * that facet by name.
 */
/** Rows drawn at once. Enough that typing is the faster path past it. */
const CAP = 40;

export function RecordPicker({
  exclude = [],
  placeholder = 'search records…',
  clearLabel,
  onPick,
  onCancel,
  inline = false,
}: {
  exclude?: string[];
  placeholder?: string;
  /**
   * The word for "pick nothing", when the caller has a use for it.
   *
   * It used to be an unconditional row reading "— no parent —", inside a
   * component whose whole point is that it knows no facet by name. In the three
   * callers that were not the parent it offered another axis's word and then did
   * nothing at all when clicked. Omitted means no row, which is the honest
   * default: a multi-valued facet clears by removing a chip.
   */
  clearLabel?: string;
  onPick: (id: string | null) => void;
  onCancel?: () => void;
  /**
   * Rendered in the flow of a scrolling surface rather than floating over one, so
   * the list must not scroll on its own — one region scrolls per axis.
   */
  inline?: boolean;
}) {
  const [all, setAll] = useState<CardDTO[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    // An empty query is every record, which is exactly the list to pick from —
    // no saved view needed, and it no longer depends on one existing.
    api.query('').then(
      (d) => setAll(Object.values(d.cards)),
      () => setAll([]),
    );
  }, []);

  // Held before the slice, so a capped list can say so. Chained into one
  // expression, `matches.length === CAP` cannot tell a cap from exactly that many
  // genuine matches — and the reader who scrolls to the end of forty and stops
  // has no way to know the record they wanted was the forty-first.
  const found = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const skip = new Set(exclude);
    return all
      .filter((r) => !skip.has(r.id))
      .filter((r) => !needle || r.title.toLowerCase().includes(needle) || r.id.includes(needle))
      .sort((a, b) => {
        if (a.isProject !== b.isProject) return a.isProject ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
  }, [all, q, exclude]);
  const matches = found.slice(0, CAP);

  return (
    <div className={`picker ${inline ? 'is-inline' : ''}`}>
      <input
        autoFocus
        value={q}
        placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          // The picker has no cancel control and no outside-click handler, so
          // this is its only way out — it must not take the panel with it.
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel?.();
          }
          if (e.key === 'Enter' && matches[0]) onPick(matches[0].id);
        }}
      />
      <div className="picker-list">
        {clearLabel && (
          <button className="picker-item is-clear" onClick={() => onPick(null)}>
            {clearLabel}
          </button>
        )}
        {matches.map((r) => (
          <button key={r.id} className="picker-item" onClick={() => onPick(r.id)}>
            {/* The real mark, not a second copy of it. This was a bare span
                holding `markOf(r).glyph`: the size happened to be right — 10px
                is exactly the 0.8em of this row's `--text-body` that the shared
                rule computes — but it carried neither the per-glyph optical
                nudge nor, more to the point, the `means` string. The picker is
                where a reader is choosing between records, so it is the one
                place the mark most needs to say what it means. */}
            <RecordMark card={r} />
            <span className="truncate picker-title">{r.title}</span>
            {r.facets.project?.length ? (
              <span className="truncate picker-proj">{r.facets.project.join(', ')}</span>
            ) : null}
          </button>
        ))}
        {!matches.length && <div className="emptystate picker-empty">nothing matches</div>}
      </div>
      {/* Outside the scroller: inside it this sits below the fold until you have
          already scrolled all forty, which is exactly the reader who has
          concluded the record is not there. A bare count, because the app is
          counting — mono and tabular, like every other number it reports. */}
      {found.length > matches.length && (
        <div className="quietcount picker-capped">
          {matches.length} of {found.length}
        </div>
      )}
    </div>
  );
}
