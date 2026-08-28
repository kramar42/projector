import { PopoverButton } from '../components/Popover.tsx';
import { Button } from '../components/Button.tsx';
import { KeyHint } from '../components/KeyHint.tsx';
import { SHAPES } from '../query.ts';
import { setGroupBy, setShape, setShow, setSort } from '../../view/intents.ts';
import type { Edit, Meta, QueryResponse, Shape } from '../types.ts';

// ---------------------------------------------------------------- shape

/**
 * Shape, and the grouping controls that turned out not to belong to it.
 *
 * `group`, `then by` and `sort` read identically for a board's columns and a
 * table's sections — they are properties of *grouping*, not of boards, which is
 * why they live here once rather than twice.
 *
 * **Nothing here appears or disappears with the shape.** The three controls that
 * only a canvas can honour — which edges are drawn, whether context is kept, and
 * what a handle-drag creates — float over the canvas itself, so the rail is the
 * same rail in every shape and switching does not reflow it.
 */
export function ShapeSection({ data, edit }: { data: QueryResponse | null; edit: Edit }) {
  const spec = data?.spec;
  const shape: Shape = spec?.shape ?? 'board';
  const composed = Boolean(spec?.lists?.length);
  const query = spec?.query ?? {};
  const group = query.groupBy ?? [];
  const facets = data?.counts.map((c) => ({ value: c.facet, label: c.label })) ?? [];

  return (
    <>
      <div className="rail-row">
        <label className="rail-label">
          Shape
          <KeyHint keys="s" means="comma then s" />
        </label>
        {/*
          * Disabled on a composition, which has no query to project. `lists` is
          * not among the options for that reason, so a select left live here
          * would show a blank value and turn the view into its own empty filter
          * — the whole vault as one flat list — on the first nudge.
          */}
        <select
          className="rail-select"
          data-rail="shape"
          value={composed ? '' : shape}
          disabled={composed}
          title={composed ? 'a lists view draws other views, so it has no shape to switch' : undefined}
          onChange={(e) => edit((spec) => setShape(spec, e.target.value as Shape))}
        >
          {composed && <option value="">Lists</option>}
          {SHAPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="rail-row">
        <label className="rail-label">
          Group by
          <KeyHint keys="g" means="comma then g — then an axis key to set it outright" />
        </label>
        <select
          className="rail-select"
          data-rail="group"
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
            <label className="rail-label">
              Then by
              <KeyHint keys="G" means="comma then shift-G" />
            </label>
            <select
              className="rail-select"
              data-rail="thenBy"
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
          <Button
            tone="ghost" size="tiny" extra="sort-direction"
            title={`Sort ${dir === 'asc' ? 'ascending' : 'descending'}; change direction`}
            aria-label={`Sort ${dir === 'asc' ? 'ascending' : 'descending'}; change direction`}
            onClick={() => edit((spec) => setSort(spec, key, dir === 'asc' ? 'desc' : 'asc'))}
          >
            {dir === 'asc' ? '↑' : '↓'}
          </Button>
        )}
        {/* After the direction, not before it: the hint is the last thing in every
            label box in the rail, so putting it here is what keeps all seven of
            them in one column. The arrow takes the auto margin and the hint sits
            against the inner edge behind it. */}
        <KeyHint keys="o" means="comma then o — the same axis twice flips the direction" />
      </div>
      <select
        className="rail-select"
        data-rail="sort"
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
 * Which facets show on a note. One row: the list is a popover so a long
 * selection cannot push the filter panel off screen.
 *
 * A board and a canvas draw them as chips, a table draws them as columns — one
 * parameter, so switching shape never asks the same question twice.
 */
export function FacetsSection({
  meta,
  data,
  edit,
}: {
  meta: Meta;
  data: QueryResponse | null;
  edit: Edit;
}) {
  const show = data?.spec.show ?? [];
  /**
   * The vault's axes, then the app's computed ones.
   *
   * The picker offered only `meta.facets`, so the five computed axes were the one
   * thing you could filter, group and sort by and not *see* — while `show` already
   * accepted them everywhere else: `validateViews` passed them, the table read
   * their label off `counts` and drew the header, and every cell came out empty
   * because a face reads stored values. The gap was in this list and in the DTO,
   * never in the model.
   *
   * Computed last and marked, rather than mixed in: a vault's own vocabulary is
   * what you reach for, and `ƒ` is the mark the filter rail already uses for the
   * same fact.
   */
  const available = [
    ...Object.entries(meta.facets).map(([name, def]) => ({
      name,
      label: def.label,
      ref: def.type === 'ref',
      computed: false,
    })),
    ...meta.computed.map((c) => ({ ...c, ref: false, computed: true })),
  ];
  const table = data?.spec.shape === 'table';
  const canvas = data?.spec.shape === 'canvas';

  return (
    <div className="rail-row">
      <label className="rail-label">
        Facets
        <KeyHint keys="f" means="comma then f" />
      </label>
      <PopoverButton
        minWidth={210}
        rail="show"
        label={table ? columnsLabel(show) : chipsLabel(show)}
        title="which facets this view surfaces — a reference facet also draws on a canvas, and the first one lays it out"
        render={() => (
          <>
            <div className="pop-head">{table ? 'Columns' : 'Shown on a note'}</div>
            {available.map((f) => (
              <label key={f.name} className="pop-check">
                <input
                  type="checkbox"
                  data-nav="tick"
                  checked={show.includes(f.name)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...show, f.name]
                      : show.filter((c) => c !== f.name);
                    edit((spec) => setShow(spec, next));
                  }}
                />
                {/* The last control in the app the browser was still drawing. It
                    had no `appearance: none`, so the shared text-field rule was
                    dressing an OS checkbox in an input's border, radius and
                    `5px 8px` padding — which under `box-sizing: border-box`
                    floors the box at 18 × 12 whatever width it is given. Same
                    markup as a filter row, so it takes the same drawn box. */}
                <span className="checkbox" aria-hidden="true" />
                {f.label}
                {f.computed && (
                  <span className="computed" title="computed from the cards, not stored on them">
                    ƒ
                  </span>
                )}
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

