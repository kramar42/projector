import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './components/Button.tsx';
import { KeyHint } from './components/KeyHint.tsx';
import { useDialogFocus } from './components/useDialogFocus.ts';
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
 *
 * ## Why it borrows the table shape and not `TableView`
 *
 * The rows are drawn with `.table`, so the row a keyboard is on wears the same
 * inset accent edge it wears in the table shape, and the head, the rules and the
 * hover are one stylesheet rule rather than two. That is the half worth sharing.
 *
 * `TableView` itself is not: every one of its parameters — `chips` off
 * `spec.show`, `NoteDTO`, buckets, roll-ups, sections off the grouping axis, the
 * selection, the bulk bar, a `Spot` into the motion grid — is a fact about
 * *notes*, and a declined candidate has none of them. Reusing the component would
 * mean making all of that optional to serve one caller that wants none of it,
 * which is a deeper coupling than the six columns it would save.
 *
 * ## Why it owns the keyboard outright
 *
 * The pile pages rather than scrolls, and `[`/`]` are the pages — which are the
 * board's lane keys, and `j`/`k` are its motion keys. There is no board in front
 * of you, so a stroke that reached the dispatcher would move something behind the
 * scrim: exactly the failure the landing comment below was written for, one layer
 * further in. So a capture listener takes every key that is not a browser
 * shortcut, the way `Cheatsheet` already does, and the dispatcher never sees one.
 */

/**
 * Rows per page.
 *
 * Sized so a page is a screenful rather than a scroller: a surface that scrolls
 * without being a field of text is an invitation to lose your place, and the
 * pile's own answer to "there is more" is `]`. The prose columns are clipped for
 * the same reason — a wrapping reason makes a row two rows tall, and twenty of
 * those fit on nobody's screen.
 */
const PAGE = 20;

/** Where a page starts: the row before it, both halves. See `api.declined`. */
type Start = { at: string; fingerprint: string };

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
  const [matching, setMatching] = useState(0);
  const [byModel, setByModel] = useState(0);
  const [q, setQ] = useState('');
  /** `q` after the debounce — what is actually asked for. See the effect below. */
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * What has been brought back, still drawn.
   *
   * Dropping the row is the obvious thing and the wrong one now that pages are
   * fixed: a page of twenty that loses a row is nineteen rows and a gap, and the
   * row under the cursor is suddenly a different row. Kept in place, struck
   * through, it says what happened and the page stays the page you were reading.
   * It is gone on the next fetch, which is when the pile has genuinely resettled.
   */
  const [broughtBack, setBroughtBack] = useState<Set<string>>(new Set());

  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  /** Which row the keyboard is on, as an index into the drawn page. */
  const [cursor, setCursor] = useState(0);

  /**
   * The search, held back from the request.
   *
   * A `LIKE` over a table that only grows, and a keystroke is not a question.
   * 200ms is below the point a reader reads it as lag and above the rate anyone
   * types. Paging is not debounced, because `]` *is* the question.
   */
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q), q ? 200 : 0);
    return () => clearTimeout(timer);
  }, [q]);

  /**
   * Where each page begins, kept as a stack.
   *
   * The pile is paged on a cursor rather than an offset — it grows at the end
   * being read from, so an offset walk interrupted by a sweep shows a row twice
   * and never shows another. A cursor pages forward on its own; going *back*
   * needs the boundary that page started at, so each fetch writes the next one
   * down and `[` is a step back into a value already held. Nothing is stored for
   * page 0, which is what "no cursor" means.
   */
  const starts = useRef<(Start | undefined)[]>([undefined]);

  useEffect(() => {
    let alive = true;
    const before = starts.current[page];
    api
      .declined({ limit: PAGE, ...(term ? { q: term } : {}), ...(before ? { before } : {}) })
      .then((res) => {
        if (!alive) return;
        setRows(res.rows);
        setMore(res.more);
        setTotal(res.total);
        setMatching(res.matching);
        setByModel(res.byModel);
        setBroughtBack(new Set());
        const last = res.rows.at(-1);
        if (last) starts.current[page + 1] = { at: last.at, fingerprint: last.fingerprint };
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [term, page]);

  /**
   * A new page starts at the top of itself.
   *
   * Keyed on the payload rather than on `page`, so a re-read that returns fewer
   * rows than the cursor's index cannot leave the keyboard pointing past the end.
   */
  useEffect(() => setCursor(0), [rows]);

  /**
   * The keyboard lands in the pile, however the pile was opened.
   *
   * This used to be `,d`'s job — the dispatcher opened the surface and then aimed
   * focus at the first row — which made the keyboard a property of *how you got
   * here*. Opened from the footer's count, focus stayed on the link in the rail,
   * which is outside the surface, so `j` and `k` fell through to the board behind
   * the scrim: the surface in front of you was inert and the thing behind it moved.
   * A surface that owns a keyboard has to claim it on arrival, not be handed it.
   *
   * The box takes focus first and synchronously, before `useDialogFocus`'s effect
   * runs, because that hook aims at the first *control* — which is the search
   * field, and landing in a field would mean `j` typed a `j`. Holding the dialog
   * itself is what leaves the landing below free to put the cursor on a row.
   */
  useLayoutEffect(() => box.current?.focus(), []);
  useDialogFocus(box);

  /**
   * Put the browser's focus where the cursor is — the table shape's arrangement,
   * for its reasons (`useCursorFocus`): a real focus is what makes `⏎` mean
   * activate and what a screen reader can follow.
   *
   * Never out of the search field, so a re-read caused by typing does not yank
   * the caret back out mid-word.
   */
  useEffect(() => {
    if (document.activeElement === search.current) return;
    box.current?.querySelectorAll<HTMLElement>('tr[data-fp]')[cursor]?.focus();
  }, [cursor, rows]);

  const pages = Math.max(1, Math.ceil(matching / PAGE));
  /**
   * Whether `]` has somewhere to go.
   *
   * `more` alone is not the question, because it is a fact about the page that
   * has *landed* — so two presses in the time one fetch takes both read the same
   * `true`, and the second asks for page 3 with page 2's cursor still unwritten,
   * which fetches page 2's rows and labels them 3. The boundary of the next page
   * is only recorded when this one arrives, so testing for it is both "there is
   * more" and "we know where it starts", said once.
   */
  const canNext = more && starts.current[page + 1] !== undefined;

  /**
   * Bring one back, and say so where the row is.
   *
   * The count moves immediately, because the answer is known — it is no longer
   * declined — and a refetch would repaint the whole page to say the one thing
   * the press already said.
   */
  async function restore(fingerprint: string) {
    // A row stays drawn after it is brought back, so the act has to refuse a
    // second press on the same row rather than un-declining a fingerprint the
    // pile no longer holds.
    if (broughtBack.has(fingerprint)) return;
    setBusy(fingerprint);
    try {
      await api.restoreDeclined(fingerprint);
      setBroughtBack((prev) => new Set(prev).add(fingerprint));
      setTotal((n) => Math.max(0, n - 1));
      setMatching((n) => Math.max(0, n - 1));
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

  /**
   * Every key, decided here.
   *
   * Capture at the window, so the application's dispatcher never sees a stroke
   * aimed at the pile — see the note at the top of the file. Everything that is
   * not a browser shortcut is swallowed, including the keys this surface has no
   * use for: a modal surface that lets a stroke through is a surface you can move
   * the board behind without seeing it happen.
   *
   * Registered once, and everything it reads comes through this one ref — the
   * device `App`'s dispatcher uses, for its reason: a `keydown` listener
   * re-registered on every render is how a stroke arriving mid-teardown lands on
   * nothing. A ref written during render is also always current, which a
   * dependency array is not.
   */
  const state = useRef({ rows, canNext, cursor, busy, restore, onClose });
  state.current = { rows, canNext, cursor, busy, restore, onClose };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Not ours: a browser shortcut, and the modifier keys themselves, which
      // arrive as their own `keydown`.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^(Shift|Control|Alt|Meta|CapsLock|AltGraph)$/.test(event.key)) return;
      // The dialog's own focus loop owns Tab — see `useDialogFocus`.
      if (event.key === 'Tab') return;

      const here = state.current;
      const inSearch = event.target === search.current;

      /**
       * Escape, once.
       *
       * It used to take two from the search box — the field blurred on the first
       * and the surface closed on the second — which is the rail's two-step, and
       * the rail is a control on a page you can still see. Here the first press
       * blurred into *nothing*: focus went to the body, so `j` and `k` stopped
       * working and the only way on was the mouse. So the first press hands the
       * pile back instead, which is a step forward rather than a step nowhere,
       * and from a row — where you land, and where you spend the visit — Escape
       * closes on the first press.
       */
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!inSearch) return here.onClose();
        search.current?.blur();
        return box.current?.querySelectorAll<HTMLElement>('tr[data-fp]')[0]?.focus();
      }

      // A field owns every other key it is given.
      if (inSearch) return;

      event.preventDefault();
      event.stopPropagation();

      const count = here.rows?.length ?? 0;
      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          return setCursor((i) => Math.min(count - 1, i + 1));
        case 'k':
        case 'ArrowUp':
          return setCursor((i) => Math.max(0, i - 1));
        // The pages. They stop rather than wrap, for the reason a list walk does:
        // a pile that cycles gives no signal you have reached the end of it.
        case '[':
          return setPage((n) => Math.max(0, n - 1));
        case ']':
          return here.canNext ? setPage((n) => n + 1) : undefined;
        case '/':
          return search.current?.focus();
        case 'Enter': {
          const row = here.rows?.[here.cursor];
          if (row && !here.busy) void here.restore(row.fingerprint);
          return;
        }
        default:
          // Swallowed, and deliberately — see the comment above this effect.
          return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            sentence says which of the two is a subset of which. The searching
            case says `matching` for the same reason: counting the page against
            the whole pile was two denominators in one sentence.
          */}
          <span className="declined-count">
            {rows === null
              ? 'reading…'
              : term
                ? `${matching} of ${total} declined`
                : `${total} declined, ${byModel} of them by the classifier`}
          </span>
          {/* Over title, reason and fingerprint: someone hunting for a card they
              half-remember may remember how the refusal was worded. */}
          <input
            ref={search}
            className="field-recessed declined-search"
            type="search"
            value={q}
            placeholder="search titles and reasons"
            aria-label="Search declined candidates"
            /* Typing is always a return to the first page: a search narrowing to
               four rows while you sit on page three shows you nothing, and the
               held cursors belong to the population you just left. */
            onChange={(e) => {
              setQ(e.target.value);
              starts.current = [undefined];
              setPage(0);
            }}
          />
          <Button tone="ghost" size="tiny" onClick={onClose}>
            close
          </Button>
        </div>

        {error && <div className="emptystate">{error}</div>}

        {rows !== null && rows.length > 0 && (
          /* The one scroller, and it is a safety net rather than the mechanism.
             Twenty rows fit the surface at any ordinary window height; a window
             short enough to clip them still has to be able to reach the last row,
             and `]` cannot help with that. */
          <div className="declined-rows">
            <table className="table declined-table">
              {/*
                The six widths, in one place and in the markup.

                `table-layout: fixed` sizes a column from the first row alone, so
                these cannot live on the cells that carry the classes — see the
                note on `.declined-table`. They sum to 100 because a column left
                to `auto` takes an equal share of the remainder rather than what
                it is worth, which handed the button column as much room as a
                sentence.
              */}
              <colgroup>
                <col style={{ width: '11%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '30%' }} />
                <col style={{ width: '30%' }} />
                <col style={{ width: '12%' }} />
              </colgroup>
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
              <tbody>
                {rows.map((r, i) => {
                  const back = broughtBack.has(r.fingerprint);
                  return (
                    <tr
                      key={r.fingerprint}
                      data-fp={r.fingerprint}
                      /*
                       * A roving tabindex and the row as the target, exactly as in
                       * the table shape. The cursor used to be the `bring back`
                       * button, so what was lit was a control inside a row rather
                       * than the row — and the row is what you are choosing
                       * between. `.table tbody tr.is-cursor` draws it, which is
                       * the whole of what the shape shares.
                       */
                      tabIndex={i === cursor ? 0 : -1}
                      className={`${i === cursor ? 'is-cursor' : ''} ${back ? 'is-restored' : ''}`}
                      // A pointer landing on a row is the keyboard landing there
                      // too — the one gesture every shape agrees on.
                      onClick={() => setCursor(i)}
                    >
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
                          say what it was is worse than a row showing an opaque id.
                          Both prose cells carry the full text as a title, because
                          the page clips them to keep a row one row tall. */}
                      <td className="declined-what" title={r.title || r.fingerprint}>
                        {r.title || r.fingerprint}
                      </td>
                      <td className="declined-why" title={r.reason}>
                        {r.reason}
                      </td>
                      <td className="declined-act">
                        {back ? (
                          <span className="declined-done">brought back</span>
                        ) : (
                          <Button
                            size="tiny"
                            // Not a tab stop and not the cursor: the row is both,
                            // and two focusable things per row would make `⏎` mean
                            // one of two things depending on which you were on.
                            tabIndex={-1}
                            disabled={busy === r.fingerprint}
                            onClick={() => void restore(r.fingerprint)}
                            title="Offer this again — the channel's cursor goes back, so the next sweep re-fetches it and writes a fresh card"
                          >
                            bring back
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {rows !== null && rows.length === 0 && (
          <div className="emptystate">
            {term
              ? 'Nothing matching.'
              : 'Nothing has been declined yet. A sweep that judges puts what it turned down here, with its reason.'}
          </div>
        )}

        {/*
          The pager, and the keys that reach it.

          Drawn whenever there is a pile at all rather than only past the first
          page, so `page 1 of 1` is the answer to "is there more" instead of an
          absence you have to interpret. The hints sit beside it because this is
          the one surface whose grammar is not the app's — `?` lists the view's
          keyboard, and none of these five keys mean here what they mean there.
        */}
        {rows !== null && rows.length > 0 && (
          <div className="declined-foot">
            <Button tone="ghost" size="tiny" disabled={page === 0} onClick={() => setPage((n) => Math.max(0, n - 1))}>
              ‹ prev
            </Button>
            <span className="declined-page">
              page {page + 1} of {pages}
            </span>
            <Button tone="ghost" size="tiny" disabled={!canNext} onClick={() => setPage((n) => n + 1)}>
              next ›
            </Button>
            <span className="declined-hints">
              <KeyHint keys="j k" means="walk the rows" />
              <KeyHint keys="[ ]" means="the page before / after this one" />
              <KeyHint keys="/" means="search the pile" />
              <KeyHint keys="⏎" means="bring the row under the cursor back" />
              <KeyHint keys="esc" means="close the pile" />
            </span>
          </div>
        )}
      </div>
    </>
  );
}
