import { useEffect, useState } from 'react';
import { Button } from './components/Button.tsx';
import { api } from './api.ts';
import { defaultSides, foldResult, type FoldRow, type Side } from '../schema/fold.ts';

/**
 * What folding this candidate into the note it extends would change.
 *
 * A sweep can now discover that something already tracked has *moved* — a ticket
 * blocked, a branch merged, a thread that made it urgent — and a merge refuses to
 * touch the survivor's labels, correctly, because combining two `status` values
 * would be a guess about which note you meant. So the guess is not made: the two
 * values are put side by side and the person picks.
 *
 * **The left column is selected to begin with**, which is exactly what folding did
 * before this dialog existed. That is the point of the default rather than
 * timidity: a dialog whose default changes something has to be read before it can
 * be dismissed, and this one can be dismissed unread and behave as it always did.
 * Taking every proposal is then one click on the other heading.
 *
 * A heading sets its whole column; a cell sets its own row; the two compose in the
 * order clicked, so "all theirs, except the status" is two clicks.
 */
export function FoldDialog({
  id,
  title,
  onClose,
  onFolded,
}: {
  id: string;
  title: string;
  onClose: () => void;
  /** The candidate is gone afterwards, so the caller decides where to look next. */
  onFolded: (into: string) => void;
}) {
  const [plan, setPlan] = useState<{ into: string; title: string; rows: FoldRow[] } | null>(null);
  const [sides, setSides] = useState<Record<string, Side>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .foldPlan(id)
      .then((p) => {
        if (!alive) return;
        setPlan(p);
        setSides(defaultSides(p.rows));
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setAll = (side: Side) =>
    setSides(Object.fromEntries((plan?.rows ?? []).map((r) => [r.facet, side])));

  async function confirm() {
    if (!plan) return;
    setBusy(true);
    try {
      await api.fold(id, plan.into, foldResult(plan.rows, sides));
      onFolded(plan.into);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const taken = (plan?.rows ?? []).filter((r) => sides[r.facet] === 'after').length;
  const rows = plan?.rows ?? [];

  return (
    <>
      <div className="scrim cheatsheet-scrim" onClick={onClose} />
      <div className="cheatsheet fold" aria-label={`Fold ${title}`}>
        <div className="declined-head">
          <h3>Fold in</h3>
          <span className="declined-count">
            {plan ? `into “${plan.title}”` : error ? '' : 'reading…'}
          </span>
          <Button tone="ghost" size="tiny" onClick={onClose}>
            close
          </Button>
        </div>

        {error && <div className="emptystate">{error}</div>}

        {plan && rows.length === 0 && (
          <div className="emptystate">
            Nothing to decide — this proposes no change to what “{plan.title}” already says. Its body,
            links and provenance still move across.
          </div>
        )}

        {plan && rows.length > 0 && (
          <table className="table fold-table">
            <thead>
              <tr>
                <th>Axis</th>
                {/* A heading is a control, and says so: clicking it answers every
                    row the same way, which is the common case in both directions. */}
                <th>
                  <button type="button" className="fold-col" onClick={() => setAll('before')}>
                    keep all
                  </button>
                </th>
                <th>
                  <button type="button" className="fold-col" onClick={() => setAll('after')}>
                    take all
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.facet}>
                  <td className="fold-axis">{r.facet}</td>
                  <td>
                    <button
                      type="button"
                      className={`fold-cell ${sides[r.facet] === 'before' ? 'is-chosen' : ''}`}
                      aria-pressed={sides[r.facet] === 'before'}
                      onClick={() => setSides((s) => ({ ...s, [r.facet]: 'before' }))}
                    >
                      {/* An axis the note does not carry has nothing to keep, and
                          saying so is clearer than an empty cell that reads as a
                          rendering fault. */}
                      {r.before.length ? r.before.join(', ') : <span className="fold-none">nothing</span>}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`fold-cell ${sides[r.facet] === 'after' ? 'is-chosen' : ''}`}
                      aria-pressed={sides[r.facet] === 'after'}
                      onClick={() => setSides((s) => ({ ...s, [r.facet]: 'after' }))}
                    >
                      {r.after.join(', ')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {plan && (
          <div className="fold-foot">
            <span className="declined-count">
              {rows.length === 0
                ? 'body, links and provenance move across'
                : `${taken} of ${rows.length} taken · body, links and provenance move across either way`}
            </span>
            <Button tone="primary" size="small" disabled={busy} onClick={() => void confirm()}>
              {busy ? 'folding…' : 'fold in'}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
