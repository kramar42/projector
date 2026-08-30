import { useEffect, useState } from 'react';
import { VaultSwitcher } from '../VaultSwitcher.tsx';
import { railControlDescription } from '../../view/keys.ts';
import { FilterPanel } from './FilterPanel.tsx';
import { SavedViews } from './SavedViews.tsx';
import { FacetsSection, ShapeSection } from './QueryControls.tsx';
import { FocusSection } from './FocusSection.tsx';
import { IconButton } from '../components/Button.tsx';
import { MARK_STATES, MarkGlyph, PinIcon, stateMeans, tallyMarks } from '../components/CardBody.tsx';
import { type Patch } from '../query.ts';
import { clearFilters, setSearch } from '../../view/intents.ts';
import type { NoteDTO, Edit, Meta, QueryResponse, ViewSpec } from '../types.ts';

/**
 * The sidebar *is* the view.
 *
 * There is no top bar. Everything a header would have carried has a better home:
 * the numbers sit in the footer next to the filter that produced them, "dragging
 * sets priority" sits under the control that decides it, and transient
 * shape-local actions (Save layout, + node, the bulk bar) float over the content
 * instead — a button that appears and vanishes mid-rail makes the whole thing
 * jump.
 *
 * Sections are grouped by purpose, and exactly one of them scrolls.
 */


export function Sidebar({
  meta,
  data,
  search,
  wire,
  patch,
  edit,
  onSwitchVault,
  onShowDeclined,
  pins,
  onShowPins,
  onAddVault,
  onOpenNote,
  collapsed,
  covered,
  onToggleCollapsed,
}: {
  meta: Meta;
  data: QueryResponse | null;
  /**
   * The raw location, needed for exactly one thing: clearing the `f.<facet>`
   * overrides that are currently set. Every *control* reads the resolved spec and
   * writes through `edit` — that gap is what the two filter bugs lived in.
   */
  search: string;
  /** The query half of it, which is what a save notes. */
  wire: string;
  /** Non-spec URL keys — switching to a saved view, mainly. */
  patch: (p: Patch) => void;
  /** Edit the view itself: a control says what it wants of the spec. */
  edit: Edit;
  onSwitchVault: (path: string) => void;
  /** Open the declined pile — a surface over the view, not a query. */
  onShowDeclined: () => void;
  /** The session's reading set, reported with the current-query counts. */
  pins: number;
  /** Show that reading set on its own spread, without turning it into a query. */
  onShowPins: () => void;
  onAddVault: () => void;
  onOpenNote: (id: string) => void;
  collapsed: boolean;
  /** A full-screen reading surface is painted over the rail. */
  covered: boolean;
  onToggleCollapsed: () => void;
}) {
  const spec = data?.spec;
  /**
   * What the collapsed ribbon reports, in three groups.
   *
   * It used to be one: three rows tallying the notes on screen by their mark.
   * That was the right *kind* of thing to put in 38px — a mark and a number — and
   * far too little of it, because collapsing the rail hid every count the
   * expanded one carries. A reader working collapsed could not see that a sweep
   * had left four candidates unjudged, or that the filter was hiding half the
   * vault, or how many notes they were holding.
   *
   * So: **what is here**, tallied by mark; **what is waiting on a person**, which
   * is a fact about the vault; and **what this view is doing**, which is a fact
   * about the query. Three questions, three groups, a hairline between them —
   * the same division the expanded rail already makes between its stats block and
   * its footer, at a width where a heading will not fit.
   *
   * The first group always draws all four states, zeros included, because it is a
   * vocabulary and its shape should not change under the reader. The other two
   * hide a row that is zero: they are exceptions, and an exception that is not
   * happening should not take a line to say so.
   */
  const marks = tallyMarks(
    (data?.ids ?? []).map((id) => data!.notes[id]).filter((c): c is NoteDTO => Boolean(c)),
  );
  const hidden = Math.max(0, (data?.universe ?? 0) - (data?.total ?? 0));
  const unjudged = meta.counts.unjudged ?? 0;

  if (collapsed) {
    return (
      <nav className="sidebar sidebar-collapsed" aria-label="Collapsed sidebar" inert={covered}>
        <button
          className="sidebar-toggle"
          type="button"
          title="Expand sidebar"
          aria-label="Expand sidebar"
          onClick={onToggleCollapsed}
        >
          »
        </button>

        {/* What is on screen. One row per state, from one table — rather than
            blocks each spelling their own glyph beside a count read from
            somewhere else, which is how the ribbon and the board came to
            disagree. The drawing is the real `MarkGlyph`, not a lookalike. */}
        <div className="ribbon-group" role="group" aria-label="On screen, by mark">
          {MARK_STATES.map((state, i) => (
            <div
              key={`${state.isProject}${state.referenced}`}
              className="sidebar-ribbon-info"
              title={`${stateMeans(state, marks[i]!)}, in this view`}
            >
              <span className="sidebar-ribbon-icon">
                <MarkGlyph isProject={state.isProject} referenced={state.referenced} pinned={false} />
              </span>
              <span>{marks[i]}</span>
            </div>
          ))}
        </div>

        {/*
          Waiting on a person. A fact about the vault rather than about the query,
          which is why it is its own group and why the number does not move when
          the filter does — the expanded rail makes the same split for the reason.

          The declined pile is deliberately *not* here. It is the one count that is
          neither what you are looking at nor what is waiting on you: it is a log
          of what a sweep already decided, read when something is missing and not
          otherwise. In 38px it would be a permanent number for an occasional
          question, which is the opposite of what a collapsed rail is for. The
          expanded rail still carries it, and `,d` still opens it.
        */}
        {unjudged > 0 && (
          <div className="ribbon-group" role="group" aria-label="Waiting on a person">
            <div className="sidebar-ribbon-info" title={`${unjudged} unjudged — + judges the one under the cursor`}>
              <kbd className="keyhint">+</kbd>
              <span>{unjudged}</span>
            </div>
          </div>
        )}

        {/*
          What this view is doing. `shown` is deliberately absent: the four counts
          above already sum to it, and a number that is the sum of the four
          directly on top of it is the duplication this pass has been removing.
          The selection is absent for the same reason — the bulk bar *is* its
          readout, floats over the view, and is drawn whether or not the rail is.

          Filtered-out names its key, having no mark of its own. Pinned draws the
          thumbtack, because it *has* one — the same two paths a mark's tack is
          built from, upright here because nothing is holding it.
        */}
        {(hidden > 0 || pins > 0) && (
          <div className="ribbon-group" role="group" aria-label="This view">
            {hidden > 0 && (
              <div className="sidebar-ribbon-info" title={`${hidden} filtered out — , ⇧F opens the filter`}>
                <kbd className="keyhint">,F</kbd>
                <span>{hidden}</span>
              </div>
            )}
            {pins > 0 && (
              <button
                type="button"
                className="sidebar-ribbon-info is-act"
                onClick={onShowPins}
                title={`${pins} pinned — " spreads them side by side`}
              >
                <span className="sidebar-ribbon-icon is-pin">
                  <PinIcon />
                </span>
                <span>{pins}</span>
              </button>
            )}
          </div>
        )}
      </nav>
    );
  }

  return (
    <nav className="sidebar" inert={covered}>
      {/* Which vault, and how much is in it. The row is labelled like every other
          rail row now: `Vault` was one of two that a reader had to identify from
          its value alone, and a folder name on its own is a word, not a control.
          The collapse toggle rides in this row rather than in one of its own. */}
      <div className="rail-block">
        <div className="rail-row">
          <label className="rail-label">Vault</label>
          <VaultSwitcher meta={meta} onSwitch={onSwitchVault} onAdd={onAddVault} />
          <button
            className="sidebar-toggle"
            type="button"
            title={railControlDescription('collapse')}
            aria-label={railControlDescription('collapse')}
            onClick={onToggleCollapsed}
          >
            «
          </button>
        </div>
        {/*
          * Two lines, because these are two questions. The first is how big the
          * vault is; the second is how much of it is waiting on a person — the
          * unjudged queue and the pile a sweep turned down. Both of those used to
          * live at the far end of the rail, in the footer's sentence about the
          * current query, where a fact about the vault reads as a fact about the
          * result set and moves every time the filter does.
          */}
        <div className="rail-stats">
          <div>
            {meta.counts.notes} notes · {meta.counts.projects} projects
          </div>
          <div>
            {meta.counts.unjudged ?? 0} unjudged ·{' '}
            {meta.declined > 0 ? (
              <button
                type="button"
                className="rail-declined"
                onClick={onShowDeclined}
                title="What a sweep turned down, and why"
              >
                {meta.declined} declined
              </button>
            ) : (
              <>0 declined</>
            )}
          </div>
        </div>
      </div>

      {/* One group, because these are one job: the query. The saved view is where
          it starts from, and shape, grouping, faces and focus are the overrides on
          top — which is exactly what a save writes back into the file. Both had a
          hairline of their own, and each said the same wrong thing: that picking a
          starting point belongs with the vault, and that a traversal is a
          different kind of control from the axis it walks. */}
      <div className="rail-block">
        <SavedViews
          views={data?.views ?? meta.views}
          current={spec}
          spec={data?.spec ?? null}
          savedSpec={data?.savedSpec ?? null}
          search={search}
          patch={patch}
          apiSearch={wire}
        />
        <ShapeSection data={data} edit={edit} />
        <FacetsSection meta={meta} data={data} edit={edit} />
        <FocusSection meta={meta} data={data} edit={edit} onOpenNote={onOpenNote} />
      </div>

      {/* The only scrolling region. */}
      <div className="rail-filter">
        {data ? <FilterPanel counts={data.counts} edit={edit} /> : null}
      </div>

      <div className="rail-foot">
        <ActiveStats data={data} edit={edit} pins={pins} onShowPins={onShowPins} />
        <SearchBox spec={data?.spec} edit={edit} />
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- footer

/**
 * What is on screen, and why it is not more.
 *
 * The worst failure mode of global filtering is "the note isn't there and I don't
 * know why", so the count of what is hidden and a one-click clear are always
 * visible — right under the filter that caused it.
 *
 * The declined pile is the one answer that moved out. It is a fact about the
 * vault rather than about this query, so it reads wrong in a sentence that
 * changes every time the filter does; it sits with the vault stats at the top of
 * the rail now.
 */
function ActiveStats({
  data,
  edit,
  pins,
  onShowPins,
}: {
  data: QueryResponse | null;
  edit: Edit;
  pins: number;
  onShowPins: () => void;
}) {
  if (!data) return <div className="rail-active">…</div>;
  const hidden = Math.max(0, data.universe - data.total);
  const active = Object.values(data.spec.query.filter ?? {}).filter((v) => v.length).length;
  const extra = data.spec.query.q ? active + 1 : active;
  /*
   * Against the clause it undoes, rather than parked at the end of the row.
   *
   * It clears the filter and the search, and `filtered out` is the count those
   * two produce — so it sits tight against that clause while the rest of the
   * sentence keeps its `·` spacing. At the end it read as acting on whichever
   * clause happened to be last, which on a canvas is a remark about drawing
   * order. The fallback is for the case where there is nothing to sit beside: a
   * search matching everything hides nothing and still needs clearing.
   *
   * The size is inline because the glyph table's 15px is a button metric and this
   * is a mark inside a 10px mono line; `IconButton` spreads the override for
   * exactly this.
   */
  const clear = extra > 0 && (
    <IconButton
      glyph="close"
      extra="rail-clear"
      style={{ fontSize: '12px' }}
      title="Clear the filter and the search"
      aria-label="Clear the filter and the search"
      onClick={() => edit(clearFilters)}
    />
  );

  return (
    <div className="rail-active">
      <b>{data.total}</b> shown
      {' · '}
      {pins > 0 ? (
        <button
          type="button"
          className="rail-pins"
          onClick={onShowPins}
          title="Show only the pinned notes"
        >
          <b>{pins}</b> pinned
        </button>
      ) : (
        <>0 pinned</>
      )}
      {hidden > 0 && (
        <>
          {' '}
          {/* The count and the control that clears it are one clause. Without
              the wrapper the ✕ is an inline-flex box the line can break before,
              and in the rail's width it does: it dropped onto a second line, on
              its own, centred under the counts — which is the first thing the
              shipped tutorial draws, since its `home` view filters. */}
          · <span className="rail-clause">{hidden} filtered out{clear}</span>
        </>
      )}
      {data.context.length > 0 && (
        <> · <span title="unmatched ancestors kept so the graph stays connected">{data.context.length} for context</span></>
      )}
      {data.placements > data.total &&
        (data.spec.shape === 'canvas' ? (
          <>
            {' '}
            ·{' '}
            <span title="a note has one position, so a card in several groups is drawn in the first the axis declares">
              {data.placements - data.total} drawn in their first group only
            </span>
          </>
        ) : (
          <>
            {' '}
            ·{' '}
            <span title="a note whose grouped facet holds several values appears in each matching group">
              {data.placements - data.total} extra placements
            </span>
          </>
        ))}
      {hidden === 0 && clear}
    </div>
  );
}

/** Live, debounced, and just another predicate in the same query. */
function SearchBox({ spec, edit }: { spec: ViewSpec | undefined; edit: Edit }) {
  // Off the resolved spec, so a saved view's own `q:` shows in the box instead of
  // leaving it blank while the query is filtered.
  const current = spec?.query.q ?? '';
  const [text, setText] = useState(current);

  // Adopt an external change (a saved view, the back button) without fighting
  // whatever is being typed right now.
  useEffect(() => setText(current), [current]);

  useEffect(() => {
    if (text === current) return;
    const t = setTimeout(() => edit((s) => setSearch(s, text), true), 200);
    return () => clearTimeout(t);
  }, [text, current, edit]);

  return (
    <div className="rail-search">
      <input
        type="search"
        className="field-recessed"
        data-rail="search"
        value={text}
        placeholder="search title and body"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          /**
           * Leave. Only leave.
           *
           * A field owns every key it is given, so the app's chain never sees
           * this one and the box has to answer for itself. It used to clear
           * first and leave on a second press — two regrets, the reasoning went:
           * the search was wrong, or you are done searching.
           *
           * The wrong one was first. **Escape means *step out* everywhere else in
           * this app** — the map says "close · leave a list · deselect" and not
           * one of those destroys anything — so the single place it emptied
           * something was the outlier, and it emptied the one piece of query state
           * the app deliberately *keeps*: `CARRIED` carries the search across a
           * change of view because what you are looking for is not something a
           * view answers. Throwing it away on the key that means "I am done here"
           * fought that.
           *
           * Clearing has other doors and always did — `,c` empties the filters and
           * the search together, and the box is a text field with a whole keyboard
           * pointed at it. Getting *out* had exactly one, and it cost you the
           * query to use it.
           *
           * Blur rather than a landing: with focus off the field the shell's chain
           * has the key back, so a second Escape does whatever it would have done
           * anyway.
           *
           * **`preventDefault` is the whole of it, and it is not defensive.** This
           * is `type="search"`, and clearing on Escape is the *browser's* default
           * action for one — so removing our own clear left the behaviour exactly
           * as it was, from a second source. DESIGN.md already records the sibling
           * of this: the UA's cancel button is hidden because it draws the app's
           * own Escape twice. Same key, same UA affordance, and the half that is
           * not a button had to be turned off too.
           */
          e.preventDefault();
          e.currentTarget.blur();
        }}
      />
    </div>
  );
}
