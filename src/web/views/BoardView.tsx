import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { CardBody } from '../components/CardBody.tsx';
import type { BoardResponse } from '../types.ts';

export function BoardView({ name, onOpen }: { name: string; onOpen: (id: string) => void }) {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api.board(name).then(setData, (e: Error) => setError(e.message));
  }, [name]);

  if (error) return <div className="pane-error">{error}</div>;
  if (!data) return <div className="pane-loading">loading…</div>;

  const multi = data.placements - data.total;

  return (
    <div className="board-wrap">
      <div className="board-head">
        <h1>{data.view.title}</h1>
        <span className="board-sub">
          grouped by <b>{data.view.groupBy}</b> · {data.total} cards
          {multi > 0 && (
            <>
              {' '}
              ·{' '}
              <span
                className="multi-note"
                title="A card whose grouped facet holds several values appears in each matching column. That is the model, not a duplicate."
              >
                {multi} in more than one column
              </span>
            </>
          )}
        </span>
      </div>

      <div className="board">
        {data.groups.map((g) => (
          <section className={`column ${g.value === '(none)' ? 'is-none' : ''}`} key={g.value}>
            <header className="column-head">
              <span className="column-name">{g.value}</span>
              <span className="column-count">{g.cards.length}</span>
            </header>
            <div className="column-body">
              {g.cards.map((card) => (
                <div className="column-card" key={card.id} onClick={() => onOpen(card.id)}>
                  <CardBody card={card} size="card" showFacets={data.view.cardFacets} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
