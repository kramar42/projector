import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { CardDTO } from '../types.ts';

/**
 * Pick a record — used to set a parent, meaning "this card is part of that one".
 * Project membership is a separate thing entirely: it is the `project` facet.
 * Projects still sort first, since they are the usual landmarks.
 */
export function RecordPicker({
  exclude = [],
  placeholder = 'search records…',
  onPick,
  onCancel,
}: {
  exclude?: string[];
  placeholder?: string;
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
        <button className="picker-item is-clear" onClick={() => onPick(null)}>
          — no parent —
        </button>
        {matches.map((r) => (
          <button key={r.id} className="picker-item" onClick={() => onPick(r.id)}>
            <span className="picker-mark">{r.isProject ? '▣' : r.kind === 'node' ? '○' : '·'}</span>
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
