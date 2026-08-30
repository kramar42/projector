import { useEffect, useRef, useState } from 'react';
import { Button } from './components/Button.tsx';
import { useDialogFocus } from './components/useDialogFocus.ts';
import { focusSoon } from './cursor.ts';
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
  const [byModel, setByModel] = useState(0);
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
          setByModel(res.byModel);
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
    /*
     * Where the walk was, so it can be put back on the far side of the fetch.
     *
     * `data-nav-more` elsewhere reveals rows that are already in hand, so
     * `focusSoon`'s three frames are enough to land on them. Here the next page is
     * a request, which outlasts the retries every time — and a cursor left sitting
     * on a spent `more` button is the walk stopping dead at the fold.
     */
    const wasAt = document.activeElement;
    const held = (rows ?? []).length;
    try {
      const res = await api.declined({ before: last.at, ...(q ? { q } : {}) });
      setRows((prev) => [...(prev ?? []), ...res.rows]);
      setMore(res.more);
      if (wasAt instanceof HTMLElement && wasAt.dataset.navMore !== undefined) {
        focusSoon(() => box.current?.querySelectorAll<HTMLElement>('[data-nav]')[held]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /**
   * The keyboard lands in the pile, however the pile was opened.
   *
   * This used to be `,d`'s job — the dispatcher opened the surface and then aimed
   * focus at the first row — which made the keyboard a property of *how you got
   * here*. Opened from the footer's count, focus stayed on the link in the rail,
   * which is outside any navlist, so `j` and `k` fell through to the board behind
   * the scrim: the surface in front of you was inert and the thing behind it moved.
   * A surface that owns a keyboard has to claim it on arrival, not be handed it.
   *
   * Guarded on focus already being inside, so a landing never steals the caret
   * back out of the search field on the re-read that a keystroke there caused.
   */
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box);
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || rows === null || !rows.length) return;
    landed.current = true;
    if (box.current?.contains(document.activeElement)) return;
    focusSoon(() => box.current?.querySelector<HTMLElement>('[data-nav]'));
  }, [rows]);

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
      if (rows?.find((r) => r.fingerprint === fingerprint)?.decidedBy === 'model') {
        setByModel((n) => Math.max(0, n - 1));
      }
      onRestored();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="scrim cheatsheet-scrim" onClick={onClose} />
      <div ref={box} className="cheatsheet declined" role="dialog" aria-modal="true" aria-label="Declined candidates" tabIndex={-1}>
        <div className="declined-head">
          <h3>Declined</h3>
          {/*
            One population, said once.
            
            This read `21 — 12 by the classifier`, which was wrong twice: the em
            dash reads as a minus, and the two numbers were not the same
            population — `total` is the whole pile, and the second was counted
            over the rows currently loaded, so a `more` moved one and not the
            other. Both now come from the same scan (`suppressions`), and the
            sentence says which of the two is a subset of which.
          */}
          <span className="declined-count">
            {rows === null
              ? 'reading…'
              : q
                ? `${rows.length}${more ? '+' : ''} of ${total} declined`
                : `${total} declined, ${byModel} of them by the classifier`}
          </span>
          {/* Over title, reason and fingerprint: someone hunting for a card they
              half-remember may remember how the refusal was worded. */}
          <input
            className="field-recessed declined-search"
            type="search"
            value={q}
            placeholder="search titles and reasons"
            aria-label="Search declined candidates"
            onChange={(e) => setQ(e.target.value)}
            /*
             * Escape leaves the field, and only the field.
             *
             * The same two-step the rail's search box makes, and for the same
             * reason: a field owns every key it is given, so Escape typed in here
             * used to reach the surface's own listener and shut the whole pile
             * while you were part-way through a search. Stopping it is what makes
             * the second Escape — now typed at the surface, not at the field —
             * mean close. `preventDefault` because this is `type="search"` and
             * clearing is the browser's own action for it.
             */
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.blur();
            }}
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
                {/* The sort key, down the left edge. The pile is newest first and
                    pages on this column, so leaving it out made the order of the
                    table something you had to already know. */}
                <th>When</th>
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
                  {/* The day, with the whole instant on hover: two of these a
                      minute apart are one sweep, which is worth being able to see
                      without it costing a column of width. */}
                  <td className="declined-when" title={r.at}>
                    {r.at.slice(0, 10)}
                  </td>
                  {/*
                    Who decided, in the meta register rather than as a chip.

                    A chip is a *facet value* everywhere else in the app, and this
                    is not a facet — it is a property of the record. It also wore
                    the accent, which `.rail-declined` two rules away argues at
                    length that a standing, always-present state must not: an
                    accent worn permanently stops pointing at anything. The
                    classifier's row still reads louder than yours, because its
                    decision is the checkable one, but it does it on the ink
                    ladder (the App Voice Rule).
                  */}
                  <td className={`declined-by ${r.decidedBy === 'model' ? 'is-model' : ''}`}>
                    {r.decidedBy === 'model' ? 'classifier' : 'you'}
                  </td>
                  <td>{r.channel ?? '—'}</td>
                  {/* The fingerprint when there is no title: a row that cannot
                      say what it was is worse than a row showing an opaque id. */}
                  <td className="declined-what">{r.title || r.fingerprint}</td>
                  <td className="declined-why">{r.reason}</td>
                  <td className="declined-act">
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
              {/*
                The fold, inside the list rather than under it.
                
                `data-nav-more` is the attribute the panel's link lists and the
                rail's facets already use for "the next one is behind this": the
                walk opens it and carries on onto what it revealed, instead of
                treating it as scenery and stopping. It has to be *in* the tbody
                for that, because a navlist walks its own descendants — which is
                also the honest reading, since this is the last row of the table
                and not a control beside it.
              */}
              {more && (
                <tr className="declined-more">
                  <td colSpan={6}>
                    <Button
                      size="small"
                      data-nav-more=""
                      disabled={busy === 'more'}
                      onClick={() => void readMore()}
                    >
                      {busy === 'more' ? 'reading…' : 'more'}
                    </Button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
