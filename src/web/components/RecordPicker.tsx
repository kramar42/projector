import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { markOf } from './CardBody.tsx';
import type { CardDTO } from '../types.ts';

/**
 * Pick a record.
 *
 * Used wherever a value *is* a record: setting a parent, and adding a value to a
 * reference facet. Projects sort first, since they are the usual landmarks —
 * which is also what makes this the right control for `project` without knowing
 * that facet by name.
 */
export function RecordPicker({
  exclude = [],
  placeholder = 'search records…',
  clearLabel,
  onPick,
  onCancel,
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

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const skip = new Set(exclude);
    return all
      .filter((r) => !skip.has(r.id))
      .filter((r) => !needle || r.title.toLowerCase().includes(needle) || r.id.includes(needle))
      .sort((a, b) => {
        if (a.isProject !== b.isProject) return a.isProject ? -1 : 1;
        return a.title.localeCompare(b.title);
      })
      .slice(0, 40);
  }, [all, q, exclude]);

  return (
    <div className="picker">
      <input
        autoFocus
        value={q}
        placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel?.();
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
            <span className="picker-mark">{markOf(r).glyph}</span>
            <span className="picker-title">{r.title}</span>
            {r.facets.project?.length ? (
              <span className="picker-proj">{r.facets.project.join(', ')}</span>
            ) : null}
          </button>
        ))}
        {!matches.length && <div className="picker-empty">nothing matches</div>}
      </div>
    </div>
  );
}
