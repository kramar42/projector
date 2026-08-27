import { useEffect, useState } from 'react';
import { Button } from './components/Button.tsx';
import { api } from './api.ts';
import type { Declined } from './types.ts';

/**
 * What a sweep saw and nobody filed.
 *
 * **Why this is a surface and not a view.** A view is a query over notes (C9),
 * and a declined candidate is not a note — it never became a file, which is the
 * whole point of declining it. So there is nothing for the query compiler to
 * answer and no shape to draw it in. It is reached with `?declined=1` over the
 * single route, exactly the way `?note=` reaches the panel: no second route, still
 * deep-linkable, and the back button still works.
 *
 * **Why it exists.** Once a classifier is deciding, an empty board has two
 * meanings — nothing happened, or everything was hidden — and until now no way to
 * tell them apart. This is the audit trail for a decision the app made on its own.
 * It is also the only place a wrong one can be put right, and that direction is
 * the asymmetric one: a card kept in error costs a glance, a card hidden in error
 * costs the thing itself.
 *
 * The `by` column is the point of the table rather than a detail. A model's
 * decline is a guess you may want to check; your own is not, and a pile that
 * cannot tell them apart is one you would have to read entirely or not at all.
 */
export function DeclinedPanel({
  onClose,
  onRestored,
}: {
  onClose: () => void;
  /** The footer's count lives on `meta`, so a restore has to invalidate it. */
  onRestored: () => void;
}) {
  const [rows, setRows] = useState<Declined[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .declined()
      .then((res) => alive && setRows(res.declined))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  // Escape closes, as everywhere else that opens over the view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Bring one back, and drop the row.
   *
   * Removed from the list rather than refetched: the answer is known — it is no
   * longer declined — and a refetch would repaint the whole table to say the one
   * thing the click already said.
   */
  async function restore(fingerprint: string) {
    setBusy(fingerprint);
    try {
      await api.restoreDeclined(fingerprint);
      setRows((prev) => (prev ?? []).filter((r) => r.fingerprint !== fingerprint));
      onRestored();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const byModel = (rows ?? []).filter((r) => r.decidedBy === 'model').length;

  return (
    <>
      <div className="scrim cheatsheet-scrim" onClick={onClose} />
      <div className="cheatsheet declined" aria-label="Declined candidates">
        <div className="declined-head">
          <h3>Declined</h3>
          <span className="declined-count">
            {rows === null
              ? 'reading…'
              : rows.length === 0
                ? 'nothing declined'
                : `${rows.length} — ${byModel} by the classifier`}
          </span>
          <Button tone="ghost" size="tiny" onClick={onClose}>
            close
          </Button>
        </div>

        {error && <div className="emptystate">{error}</div>}

        {rows !== null && rows.length > 0 && (
          <table className="table declined-table">
            <thead>
              <tr>
                <th>By</th>
                <th>Source</th>
                <th>What it was</th>
                <th>Why it was declined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.fingerprint}>
                  <td>
                    <span className={`chip ${r.decidedBy === 'model' ? 'is-model' : ''}`}>
                      {r.decidedBy === 'model' ? 'classifier' : 'you'}
                    </span>
                  </td>
                  <td>{r.channel ?? '—'}</td>
                  {/* The fingerprint when there is no title: a row that cannot
                      say what it was is worse than a row showing an opaque id. */}
                  <td className="declined-what">{r.title || r.fingerprint}</td>
                  <td className="declined-why">{r.reason}</td>
                  <td>
                    <Button
                      size="tiny"
                      disabled={busy === r.fingerprint}
                      onClick={() => void restore(r.fingerprint)}
                      title="Offer this again on the next sweep"
                    >
                      bring back
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rows !== null && rows.length === 0 && (
          <div className="emptystate">
            Nothing has been declined yet. A sweep that judges puts what it turned down here, with its
            reason.
          </div>
        )}
      </div>
    </>
  );
}
