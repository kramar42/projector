import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { CardDTO } from '../types.ts';

/**
 * Pick a record — used to set a parent, which is how a card acquires a project:
 * project membership is derived from the parent chain, never typed in directly.
 * Projects sort first, since they are what a loose card usually needs.
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
    // The Everything canvas is simply every record — a cheap way to list them.
    api.canvas('all').then((d) => setAll(d.nodes), () => setAll([]));
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
            {r.projectKey && <span className="picker-proj">{r.projectKey}</span>}
          </button>
        ))}
        {!matches.length && <div className="picker-empty">nothing matches</div>}
      </div>
    </div>
  );
}
