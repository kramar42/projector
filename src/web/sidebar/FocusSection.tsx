import { PopoverButton } from '../components/Popover.tsx';
import { RecordPicker } from '../components/RecordPicker.tsx';
import { RecordMark } from '../components/CardBody.tsx';
import { IconButton } from '../components/Button.tsx';
import { DIRS } from '../../schema/vocabulary.ts';
import { clearFocus, setFocus } from '../../view/intents.ts';
import { relations } from '../query.ts';
import type { Dir, Edit, Meta, QueryResponse } from '../types.ts';

/** `out` follows a record's own references; `in` finds the records naming it. */
const DIR_MEANS: Record<string, string> = {
  out: 'follows — what this record points at',
  in: 'referenced by — what points at this record',
  both: 'both directions, as two separate walks',
};

// ---------------------------------------------------------------- focus

/**
 * Focus is a traversal, not a facet — pick a record and walk edges from it. The
 * pseudo-facets (`type`, `blocked`, `triage`, `linked`, `staleness`) are the
 * facet-like things that aren't facets, and they live in the filter panel,
 * indistinguishable from the real ones.
 */
export function FocusSection({
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
  /**
   * The focused record, if the current query happens to contain it.
   *
   * A focus can point at a record the query then filters out, so this is a
   * lookup that may miss — which is why the pill falls back to the raw id, and
   * why the mark falls back to a leaf: drawing `○` for a record we cannot see
   * would be asserting something unmeasured.
   */
  const card = focus ? data?.cards[focus.id] : undefined;
  const title = focus ? (card?.title ?? focus.id) : null;

  return (
    <>
      <div className="rail-row">
        <label className="rail-label">Focus</label>
        {focus ? (
          <>
            {/* The other place a record appeared with no mark. It is a record you
                click through to, so it wears one — same as a card face, a table
                row, a reference chip and a picker row. */}
            <button className="rail-focus" title={focus.id} onClick={() => onOpenCard(focus.id)}>
              <RecordMark card={card ?? { isProject: false, refCount: 0 }} />
              <span className="truncate">{title ?? focus.id}</span>
            </button>
            <IconButton
              glyph="close"
              title="clear the focus"
              onClick={() => edit(clearFocus)}
            />
          </>
        ) : (
          <PopoverButton
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

