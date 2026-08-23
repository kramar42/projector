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
import type { CardDTO, Edit, Meta, QueryResponse, ViewSpec } from '../types.ts';

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
  onAddVault,
  onOpenCard,
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
  /** The query half of it, which is what a save records. */
  wire: string;
  /** Non-spec URL keys — switching to a saved view, mainly. */
  patch: (p: Patch) => void;
  /** Edit the view itself: a control says what it wants of the spec. */
  edit: Edit;
  onSwitchVault: (path: string) => void;
  onAddVault: () => void;
  onOpenCard: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const spec = data?.spec;
  /**
   * What the collapsed ribbon reports: the records on screen, tallied by what
   * their own mark says.
   *
   * It used to read the `type` pseudo-facet and name three of its values, which
   * was wrong twice over: it named a facet in the UI (C4), and it answered the
   * question from a different source than the marks did — `type`'s `node` counts a
   * record named by *any* reference facet, where a drawn `○` then meant the
   * `parent` facet alone. The mark has since taken the broader meaning, so the two
   * agree on the definition; counting through `markOf` is what stops them drifting
   * apart again, and it names no facet.
   */
  const marks = tallyRoles(
    (data?.ids ?? []).map((id) => data!.cards[id]).filter((c): c is CardDTO => Boolean(c)),
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
      <div className="rail-block">
        {/* Labelled like every other rail row, and for the same reason: the two
            controls that name *where you are looking* were the only ones a reader
            had to identify from their value alone — and a vault called `work`
            beside a view called `Ad-hoc query` is two unlabelled words. The
            collapse toggle rides in this row rather than in one of its own. */}
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
          {meta.counts.records} records · {meta.counts.projects} projects
        </div>
        <SavedViews
          views={data?.views ?? meta.views}
          current={spec}
          spec={data?.spec ?? null}
          savedSpec={data?.savedSpec ?? null}
          search={search}
          patch={patch}
          apiSearch={wire}
        />
      </div>

      {/* One group, because these are one job: everything that decides what the
          query is and how it is drawn. Focus sat behind a hairline of its own,
          which said it was a different kind of control — it is not, it is the
          traversal half of the same query. */}
      <div className="rail-block">
        <ShapeSection data={data} edit={edit} />
        <FacetsSection meta={meta} data={data} edit={edit} />
        <FocusSection meta={meta} data={data} edit={edit} onOpenCard={onOpenCard} />
      </div>

      {/* The only scrolling region. */}
      <div className="rail-filter">
        {data ? <FilterPanel counts={data.counts} edit={edit} /> : null}
      </div>

      <div className="rail-foot">
        <ActiveStats data={data} edit={edit} />
        <SearchBox spec={data?.spec} edit={edit} />
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- footer

/**
 * What is on screen, and why it is not more.
 *
 * The worst failure mode of global filtering is "the card isn't there and I don't
 * know why", so the count of what is hidden and a one-click clear are always
 * visible — right under the filter that caused it.
 */
function ActiveStats({
  data,
  edit,
}: {
  data: QueryResponse | null;
  edit: Edit;
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
            <span title="a record has one position, so a card in several groups is drawn in the first the axis declares">
              {data.placements - data.total} drawn in their first group only
            </span>
          </>
        ) : (
          <>
            {' '}
            ·{' '}
            <span title="a card whose grouped facet holds several values appears in each matching group">
              {data.placements - data.total} extra placements
            </span>
          </>
        ))}
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
        value={text}
        placeholder="search title and body"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setText('');
        }}
      />
    </div>
  );
}
