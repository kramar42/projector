import { useEffect, useState } from 'react';
import { VaultSwitcher } from '../VaultSwitcher.tsx';
import { FilterPanel } from './FilterPanel.tsx';
import { SavedViews } from './SavedViews.tsx';
import { FacetsSection, ShapeSection } from './QueryControls.tsx';
import { FocusSection } from './FocusSection.tsx';
import { Button } from '../components/Button.tsx';
import { GLYPH_OF, ROLES, tallyMeans, tallyRoles } from '../components/CardBody.tsx';
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
  onAddVault,
  onOpenNote,
  collapsed,
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
  onAddVault: () => void;
  onOpenNote: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const spec = data?.spec;
  /**
   * What the collapsed ribbon reports: the notes on screen, tallied by what
   * their own mark says.
   *
   * It used to read the `type` computed axis and name three of its values, which
   * was wrong twice over: it named a facet in the UI (C4), and it answered the
   * question from a different source than the marks did — `type`'s `node` counts a
   * note named by *any* reference facet, where a drawn `○` then meant the
   * `parent` facet alone. The mark has since taken the broader meaning, so the two
   * agree on the definition; counting through `markOf` is what stops them drifting
   * apart again, and it names no facet.
   */
  const marks = tallyRoles(
    (data?.ids ?? []).map((id) => data!.notes[id]).filter((c): c is NoteDTO => Boolean(c)),
  );

  if (collapsed) {
    return (
      <nav className="sidebar sidebar-collapsed" aria-label="Collapsed sidebar">
        <button
          className="sidebar-toggle"
          type="button"
          title="Expand sidebar"
          aria-label="Expand sidebar"
          onClick={onToggleCollapsed}
        >
          »
        </button>
        {/* One row per role, from one table — rather than three blocks each
            spelling its own glyph beside a count read from somewhere else. */}
        {ROLES.map((role) => (
          <div
            key={role}
            className="sidebar-ribbon-info"
            title={`${tallyMeans(role, marks[role])} in this query`}
          >
            <span className="sidebar-ribbon-icon" aria-hidden="true">
              {GLYPH_OF[role]}
            </span>
            <span>{marks[role]}</span>
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav className="sidebar">
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
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            onClick={onToggleCollapsed}
          >
            «
          </button>
        </div>
        <div className="rail-stats">
          {meta.counts.notes} notes · {meta.counts.projects} projects
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
        <ActiveStats
          data={data}
          edit={edit}
          declined={meta.declined}
          onShowDeclined={onShowDeclined}
        />
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
 */
function ActiveStats({
  data,
  edit,
  declined,
  onShowDeclined,
}: {
  data: QueryResponse | null;
  edit: Edit;
  /** Candidates a sweep turned down. Not notes, so not part of `data`. */
  declined: number;
  onShowDeclined: () => void;
}) {
  if (!data) return <div className="rail-active">…</div>;
  const hidden = Math.max(0, data.universe - data.total);
  const active = Object.values(data.spec.query.filter ?? {}).filter((v) => v.length).length;
  const extra = data.spec.query.q ? active + 1 : active;

  return (
    <div className="rail-active">
      <b>{data.total}</b> shown
      {hidden > 0 && <> · {hidden} filtered out</>}
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
      {/*
        * The other reason there is less on screen than you expected, and the one
        * no filter explains: a sweep judged something not worth a note. This
        * section exists so "it isn't there and I don't know why" always has an
        * answer, and until now it only answered for the filter.
        */}
      {declined > 0 && (
        <>
          {' '}
          ·{' '}
          <button
            type="button"
            className="rail-declined"
            onClick={onShowDeclined}
            title="What a sweep turned down, and why"
          >
            {declined} declined
          </button>
        </>
      )}
      {extra > 0 && (
        <Button tone="ghost" size="tiny" onClick={() => edit(clearFilters)}>
          clear
        </Button>
      )}
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
           * Clear, then leave.
           *
           * A field owns every key it is given, so the app's chain never sees this
           * one — which meant Escape emptied the box and left the keyboard in it,
           * with no way back to the cards but the mouse. Two steps rather than
           * one because they are two different regrets: the search was wrong, or
           * you are done searching.
           */
          if (text) return setText('');
          e.currentTarget.blur();
        }}
      />
    </div>
  );
}
