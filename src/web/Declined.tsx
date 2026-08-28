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
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * The first page, and again whenever the search changes.
   *
   * Debounced, because this is a `LIKE` over a table that only grows and a
   * keystroke is not a question. 200ms is below the point a reader reads it as
   * lag and above the rate anyone types.
   */
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api
        .declined(q ? { q } : {})
        .then((res) => {
          if (!alive) return;
          setRows(res.rows);
          setMore(res.more);
          setTotal(res.total);
        })
        .catch((e: Error) => alive && setError(e.message));
    }, q ? 200 : 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  /**
   * The next page, from the last row's timestamp.
   *
   * A cursor rather than an offset: the list grows at the end being read from, so
   * a sweep landing mid-walk would shift every row down one and the reader would
   * see a row twice and never see another.
   */
  async function readMore() {
    const last = rows?.at(-1);
    if (!last) return;
    setBusy('more');
    try {
      const res = await api.declined({ before: last.at, ...(q ? { q } : {}) });
      setRows((prev) => [...(prev ?? []), ...res.rows]);
      setMore(res.more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

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
      setTotal((n) => Math.max(0, n - 1));
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
              : q
                ? `${rows.length}${more ? '+' : ''} of ${total}`
                : `${total} — ${byModel} by the classifier`}
          </span>
          {/* Over title, reason and fingerprint: someone hunting for a card they
              half-remember may remember how the refusal was worded. */}
          <input
            className="declined-search"
            type="search"
            value={q}
            placeholder="search titles and reasons"
            aria-label="Search declined candidates"
            onChange={(e) => setQ(e.target.value)}
          />
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
            {/*
              A navlist, so the pile can be worked without a pointer.

              The rows are the whole surface and each has one act, so `j`/`k` walk
              them and `⏎` brings one back — which is the shape the panel's link
              list already has. There is no palette entry for restoring: a palette
              row names an act with no argument, and this one is always *which*.
            */}
            <tbody data-navlist="declined" data-nav-flow="column">
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
                      data-nav="pick"
                      disabled={busy === r.fingerprint}
                      onClick={() => void restore(r.fingerprint)}
                      title="Offer this again — the channel's cursor goes back, so the next sweep re-fetches it and writes a fresh card"
                    >
                      bring back
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {more && (
          <div className="declined-more">
            <Button size="small" disabled={busy === 'more'} onClick={() => void readMore()}>
              {busy === 'more' ? 'reading…' : 'more'}
            </Button>
          </div>
        )}

        {rows !== null && rows.length === 0 && (
          <div className="emptystate">
            {q
              ? 'Nothing matching.'
              : 'Nothing has been declined yet. A sweep that judges puts what it turned down here, with its reason.'}
          </div>
        )}
      </div>
    </>
  );
}
