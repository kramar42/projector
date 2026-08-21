import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { PopoverButton } from '../components/Popover.tsx';
import { RecordPicker } from '../components/RecordPicker.tsx';
import { VaultSwitcher } from '../VaultSwitcher.tsx';
import { FilterPanel } from './FilterPanel.tsx';
import { SHAPES, relations, type Patch } from '../query.ts';
import { DIRS } from '../../schema/vocabulary.ts';
import {
  clearFilters,
  clearFocus,
  setFocus,
  setGroupBy,
  setSearch,
  setShape,
  setShow,
  setSort,
  setUncategorised,
} from '../../view/intents.ts';
import type { Dir, Meta, QueryResponse, SavedViewSummary, Shape, ViewSpec } from '../types.ts';

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
/** `out` follows a record's own references; `in` finds the records naming it. */
const DIR_MEANS: Record<string, string> = {
  out: 'follows — what this record points at',
  in: 'referenced by — what points at this record',
  both: 'both directions, as two separate walks',
};

/** A control names what it wants of the spec; App turns it into URL overrides. */
export type Edit = (fn: (spec: ViewSpec) => ViewSpec, replace?: boolean) => void;

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
  search: string;
  /** The query half of `search`, which is what a save records. */
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
  const typeValues = data?.counts.find((facet) => facet.facet === 'type')?.values;
  const typeCount = (type: string) => typeValues?.find((value) => value.value === type)?.count ?? 0;

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
        <div className="sidebar-ribbon-info" title={`${typeCount('project')} projects in this query`}>
          <span className="sidebar-ribbon-icon" aria-hidden="true">▣</span>
          <span>{typeCount('project')}</span>
        </div>
        <div className="sidebar-ribbon-info" title={`${typeCount('node')} linked nodes in this query`}>
          <span className="sidebar-ribbon-icon" aria-hidden="true">○</span>
          <span>{typeCount('node')}</span>
        </div>
        <div className="sidebar-ribbon-info" title={`${typeCount('plain')} plain cards in this query`}>
          <span className="sidebar-ribbon-icon" aria-hidden="true">·</span>
          <span>{typeCount('plain')}</span>
        </div>
      </nav>
    );
  }

  return (
    <nav className="sidebar">
      <div className="rail-block">
        <div className="sidebar-vault-row">
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
          search={search}
          patch={patch}
          apiSearch={wire}
        />
      </div>

      <div className="rail-block">
        <ShapeSection data={data} edit={edit} />
        <FacetsSection meta={meta} data={data} edit={edit} />
      </div>

      <div className="rail-block">
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

// ---------------------------------------------------------------- saved views

/**
 * Which starting point, and whether it still is one.
 *
 * Once shape, face and filter are all live controls, opening a saved view and
 * changing one of them leaves you somewhere ambiguous. Naming the divergence is
 * what keeps a saved view worth saving.
 */
function SavedViews({
  views,
  current,
  search,
  patch,
  apiSearch,
}: {
  views: SavedViewSummary[];
  current: QueryResponse['spec'] | undefined;
  search: string;
  patch: (p: Patch) => void;
  apiSearch: string;
}) {
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  const overridden = [...params.keys()].filter((k) => k !== 'view' && k !== 'card');
  const modified = Boolean(current?.name) && overridden.length > 0;
  const [naming, setNaming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = (name: string, title?: string) =>
    api
      .saveView(name, apiSearch, title)
      .then((r) => {
        setNaming(false);
        setProblem(null);
        // Land on the saved view with no overrides: the query is the file now.
        patch({ ...blankQuery(params), view: r.name });
      })
      .catch((e: ApiError) => setProblem(e.message));

  return (
    <>
      <div className="rail-row">
        <PopoverButton
          className="viewbtn"
          panelClassName="viewmenu"
          minWidth={240}
          label={current?.title ?? current?.name ?? 'Ad-hoc query'}
          render={(close) => (
            <>
              <div className="pop-head">Saved views</div>
              {views.map((v) => (
                <button
                  key={v.name}
                  className={`pop-pick ${v.name === current?.name ? 'is-current' : ''}`}
                  onClick={() => {
                    close();
                    // Picking a view replaces the query wholesale: the old
                    // overrides belonged to the old view.
                    patch({ ...blankQuery(params), view: v.name });
                  }}
                >
                  <span className="pop-pick-name">{v.title}</span>
                  <span className="pop-count">{v.shape}</span>
                </button>
              ))}
              <button
                className="pop-action"
                onClick={() => {
                  close();
                  setNaming(true);
                }}
              >
                Save current as…
              </button>
              <button
                className="pop-action"
                onClick={() => {
                  close();
                  patch(blankQuery(params));
                }}
              >
                Start from nothing
              </button>
            </>
          )}
        />
        {modified && (
          <span className="rail-dirty" title="This saved view has unsaved changes">
            <button
              className="btn ghost tiny icon-button icon-check"
              title="write these changes into the saved view — its layout and card order are kept"
              aria-label="Save changes to this view"
              onClick={() => void save(current!.name!, current!.title)}
            >
              ✓
            </button>
            <button
              className="btn ghost tiny icon-button icon-revert"
              title="discard the overrides and go back to the saved view"
              aria-label="Revert changes to this view"
              onClick={() => patch(blankQuery(params, current?.name ?? null))}
            >
              ↶
            </button>
          </span>
        )}
      </div>

      {naming && <SaveAsRow onCancel={() => setNaming(false)} onSave={(t) => void save(t, t)} />}
      {problem && <div className="rail-problem">{problem}</div>}
    </>
  );
}

/**
 * Naming a query is what turns it into a place — and the only way it can hold
 * arrangement, since positions and card order live in a file or nowhere (C9).
 */
function SaveAsRow({ onCancel, onSave }: { onCancel: () => void; onSave: (title: string) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="rail-row">
      <input
        className="rail-input"
        autoFocus
        value={text}
        placeholder="name this view"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && text.trim()) onSave(text.trim());
        }}
      />
      <button className="btn primary small" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
        Save
      </button>
    </div>
  );
}

/** Clear every query key, optionally keeping a `view=`. */
function blankQuery(params: URLSearchParams, view: string | null = null): Patch {
  const patch: Patch = {};
  for (const key of params.keys()) if (key !== 'card') patch[key] = null;
  if (view) patch.view = view;
  return patch;
}

// ---------------------------------------------------------------- shape

/**
 * Shape, and the grouping controls that turned out not to belong to it.
 *
 * `uncategorised` and `sort` read identically for a board's columns and a table's
 * sections — they are properties of *grouping*, not of boards, which is why they
 * live here once rather than twice.
 *
 * **Nothing here appears or disappears with the shape.** The three controls that
 * only a canvas can honour — which edges are drawn, whether context is kept, and
 * what a handle-drag creates — float over the canvas itself, so the rail is the
 * same rail in every shape and switching does not reflow it.
 */
function ShapeSection({ data, edit }: { data: QueryResponse | null; edit: Edit }) {
  const spec = data?.spec;
  const shape: Shape = spec?.shape ?? 'board';
  const query = spec?.query ?? {};
  const group = query.groupBy ?? [];
  const facets = data?.counts.map((c) => ({ value: c.facet, label: c.label })) ?? [];

  return (
    <>
      <div className="rail-row">
        <label className="rail-label">Shape</label>
        <select
          className="rail-select"
          value={shape}
          onChange={(e) => edit((spec) => setShape(spec, e.target.value as Shape))}
        >
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="rail-row">
        <label className="rail-label">Group by</label>
        <select
          className="rail-select"
          value={group[0] ?? ''}
          onChange={(e) => edit((spec) => setGroupBy(spec, 0, e.target.value || null))}
        >
          <option value="">—</option>
          {facets.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {group[0] && (
        <>
          <div className="rail-row">
            <label className="rail-label">Then by</label>
            <select
              className="rail-select"
              value={group[1] ?? ''}
              title="board lanes, table sub-sections. A canvas keeps the value but cannot draw it yet: a node has one position, so it cannot sit in two clusters"
              onChange={(e) => edit((spec) => setGroupBy(spec, 1, e.target.value || null))}
            >
              <option value="">—</option>
              {facets
                .filter((f) => f.value !== group[0])
                .map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
            </select>
          </div>

          <div className="rail-row">
            <label className="rail-label">No value</label>
            <select
              className="rail-select"
              value={query.uncategorised ?? 'end'}
              onChange={(e) =>
                edit((spec) => setUncategorised(spec, e.target.value as 'end' | 'start' | 'hide'))
              }
            >
              <option value="end">last</option>
              <option value="start">first</option>
              <option value="hide">hide</option>
            </select>
          </div>


        </>
      )}

      <SortRow query={query} facets={facets} shape={shape} edit={edit} />
    </>
  );
}

function SortRow({
  query,
  facets,
  shape,
  edit,
}: {
  query: QueryResponse['spec']['query'];
  facets: { value: string; label: string }[];
  shape: Shape;
  edit: Edit;
}) {
  const [key = '', dirRaw = 'asc'] = (query.sort?.[0] ?? '').split(':');
  const dir: 'asc' | 'desc' = dirRaw === 'desc' ? 'desc' : 'asc';
  const note =
    shape === 'canvas'
      ? 'a canvas is arranged by dagre; this seeds the order within each rank'
      : key && key !== 'updated' && key !== 'created' && key !== 'title'
        ? 'ranked by the order declared in facets.yaml'
        : '';
  return (
    <div className="rail-row" title={note}>
      <div className="rail-label-control">
        <label className="rail-label">Sort</label>
        {key && (
          <button
            className="btn ghost tiny sort-direction"
            title={`Sort ${dir === 'asc' ? 'ascending' : 'descending'}; change direction`}
            aria-label={`Sort ${dir === 'asc' ? 'ascending' : 'descending'}; change direction`}
            onClick={() => edit((spec) => setSort(spec, key, dir === 'asc' ? 'desc' : 'asc'))}
          >
            {dir === 'asc' ? '↑' : '↓'}
          </button>
        )}
      </div>
      <select
        className="rail-select"
        value={key}
        onChange={(e) => edit((spec) => setSort(spec, e.target.value, dir))}
      >
        <option value="">—</option>
        <option value="updated">updated</option>
        <option value="created">created</option>
        <option value="title">title</option>
        {facets.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------- face

/**
 * Which facets show on a record. One row: the list is a popover so a long
 * selection cannot push the filter panel off screen.
 *
 * A board and a canvas draw them as chips, a table draws them as columns — one
 * parameter, so switching shape never asks the same question twice.
 */
function FacetsSection({
  meta,
  data,
  edit,
}: {
  meta: Meta;
  data: QueryResponse | null;
  edit: Edit;
}) {
  const show = data?.spec.show ?? [];
  const available = Object.entries(meta.facets).map(([name, def]) => ({
    name,
    label: def.label,
    ref: def.type === 'ref',
  }));
  const table = data?.spec.shape === 'table';
  const canvas = data?.spec.shape === 'canvas';

  return (
    <div className="rail-row">
      <label className="rail-label">Facets</label>
      <PopoverButton
        className="chipsbtn"
        minWidth={210}
        label={table ? columnsLabel(show) : chipsLabel(show)}
        title="which facets this view surfaces — a reference facet also draws on a canvas, and the first one lays it out"
        render={() => (
          <>
            <div className="pop-head">{table ? 'Columns' : 'Shown on a record'}</div>
            {available.map((f) => (
              <label key={f.name} className="pop-check">
                <input
                  type="checkbox"
                  checked={show.includes(f.name)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...show, f.name]
                      : show.filter((c) => c !== f.name);
                    edit((spec) => setShow(spec, next));
                  }}
                />
                {f.label}
                {/* Only a canvas can act on the difference, so only a canvas
                    says it: order decides which relation lays the graph out. */}
                {f.ref && canvas && <span className="pop-note">drawn</span>}
              </label>
            ))}
          </>
        )}
      />
    </div>
  );
}

function chipsLabel(chips: string[]): string {
  if (!chips.length) return 'none';
  return chips.length === 1 ? chips[0]! : `${chips[0]} +${chips.length - 1}`;
}

function columnsLabel(chips: string[]): string {
  return chips.length ? `${chips.length} columns` : 'title only';
}

// ---------------------------------------------------------------- focus

/**
 * Focus is a traversal, not a facet — pick a record and walk edges from it. The
 * pseudo-facets (`kind`, `type`, `blocked`, `triage`, `staleness`) are the
 * facet-like things that aren't facets, and they live in the filter panel,
 * indistinguishable from the real ones.
 */
function FocusSection({
  meta,
  data,
  edit,
  onOpenCard,
}: {
  meta: Meta;
  data: QueryResponse | null;
  edit: Edit;
  onOpenCard: (id: string) => void;
}) {
  const focus = data?.spec.query.focus;
  const title = focus ? (data?.cards[focus.id]?.title ?? focus.id) : null;

  return (
    <>
      <div className="rail-row">
        <label className="rail-label">Focus</label>
        {focus ? (
          <>
            <button className="rail-focus" title={focus.id} onClick={() => onOpenCard(focus.id)}>
              {title ?? focus.id}
            </button>
            <button
              className="btn ghost tiny icon-button icon-close"
              title="clear the focus"
              onClick={() => edit(clearFocus)}
            >
              ✕
            </button>
          </>
        ) : (
          <PopoverButton
            className="focusbtn"
            minWidth={320}
            fitContent
            label="everything"
            render={(close) => (
              <RecordPicker
                placeholder="focus on…"
                onCancel={close}
                onPick={(id) => {
                  close();
                  // The picker offers "no focus" as a pick, which is a clear.
                  edit((spec) => (id ? setFocus(spec, { id }) : clearFocus(spec)));
                }}
              />
            )}
          />
        )}
      </div>

      {focus && (
        <div className="rail-row">
          <select
            className="rail-select"
            value={focus.via}
            title="which relation to walk"
            onChange={(e) => edit((spec) => setFocus(spec, { id: focus!.id, via: e.target.value }))}
          >
            {relations(meta).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <select
            className="rail-select narrow"
            value={focus.dir}
            onChange={(e) =>
              edit((spec) => setFocus(spec, { id: focus!.id, dir: e.target.value as Dir }))
            }
          >
            {DIRS.map((d) => (
              <option key={d} value={d} title={DIR_MEANS[d]}>
                {d}
              </option>
            ))}
          </select>
          <select
            className="rail-select narrow"
            value={focus.depth ?? ''}
            title="how many hops"
            onChange={(e) =>
              edit((spec) =>
                setFocus(spec, { id: focus!.id, depth: Number(e.target.value) || undefined }),
              )
            }
          >
            <option value="">all</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </div>
      )}
    </>
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
        <button className="btn ghost tiny" onClick={() => edit(clearFilters)}>
          clear
        </button>
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
