import { useRef, useState } from 'react';
import { axisValues, FacetChip, RecordMark } from '../components/CardBody.tsx';
import { BulkBar } from '../components/BulkBar.tsx';
import { useRequestEnrichment } from '../enrichment.tsx';
import { visibleSelection, type Selection } from '../selection.ts';
import { useCursorFocus } from '../cursor.ts';
import { earnsRollups } from './columns.ts';
import { groupsFor, labelFor } from './groups.ts';
import type { NoteDTO, QueryResponse, Rollup } from '../types.ts';
import { useTouched } from '../touched.tsx';

/**
 * The third shape.
 *
 * A table exists for the one thing neither a board nor a canvas gives: columns of
 * numbers. Its columns are `chips` — the same list a board draws as chips —
 * so switching shape never asks "which facets matter" twice, and there is no
 * column picker to build or keep in sync.
 *
 * Read-only, like every shape: a row click opens `?card=` and the panel does the
 * editing (C10). Selecting rows is a gesture, not editing, so the bulk bar is on
 * the same side of C10 here as it is on a board.
 */
export function TableView({
  data,
  onOpen,
  selection,
  cursor,
  onCursor,
  reload,
}: {
  data: QueryResponse;
  onOpen: (id: string) => void;
  /** Owned by `App` and carried in `?sel=`, so it survives a change of shape. */
  selection: Selection;
  /** Where the keyboard is; the table only draws it. See `motion.ts`. */
  cursor: string | null;
  /** A pointer landing on a row is the keyboard landing there too. */
  onCursor: (id: string) => void;
  reload: () => void;
}) {
  const chips = data.spec.show;
  const [problem, setProblem] = useState<string | null>(null);
  // Why `every` and not `some` is `columns.ts`'s to explain.
  const projects = earnsRollups(data.ids, data.notes);

  useRequestEnrichment([
    ...new Set(data.ids.flatMap((id) => data.notes[id]?.links.map((l) => l.raw) ?? [])),
  ]);

  // A table drops an empty declared section, following the canvas rather than the
  // board: the board's case for keeping one is that it is somewhere to drag to,
  // and a table offers nothing to drag. It used to render a header with a `0`
  // under it, which was a behaviour rather than a decision.
  const sections = groupsFor(data, { lanes: 'all', empties: 'drop' });

  /**
   * The ids in the order the table draws them, which is what a shift-click
   * measures along.
   *
   * Sections flattened, duplicates kept: a card whose grouped facet holds several
   * values gets a row under each, and a range has to be able to end on the second
   * one. That is why a row carries its index rather than its id alone.
   */
  const rows = sections.flatMap((section) => section.ids);

  // What the bar writes — see `visibleSelection`. Rows can repeat a card, so this
  // is taken against the result set rather than the drawn rows.
  const acting = visibleSelection(selection.ids, data.ids);

  /** Where each section starts in `rows`, so a row can name its own place in it. */
  const offsets: Record<string, number> = {};
  let at = 0;
  for (const section of sections) {
    offsets[`${section.lane ?? ''}/${section.value}`] = at;
    at += section.ids.length;
  }

  return (
    <div className="table-shell">
      {problem && <div className="banner is-bad">{problem}</div>}
      <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="col-title">Title</th>
            {chips.map((c) => (
              <th key={c}>{data.counts.find((f) => f.facet === c)?.label ?? c}</th>
            ))}
            {projects && (
              <>
                <th className="num" title="cards naming this project directly / including nested projects">
                  Cards
                </th>
                <th className="num">Blocked</th>
                <th className="num">Untriaged</th>
              </>
            )}
            <th className="col-updated">Updated</th>
          </tr>
        </thead>
        {sections.map((section) => (
          <tbody key={`${section.lane ?? ''}/${section.value}`}>
            {section.value !== '' && (
              <tr className="section">
                {/* title + the chip columns + the three roll-ups, when earned + updated */}
                <th colSpan={1 + chips.length + (projects ? 3 : 0) + 1}>
                  {section.lane ? `${labelFor(section.lane)} · ` : ''}
                  {labelFor(section.value)}
                  <span className="section-count">{section.ids.length}</span>
                </th>
              </tr>
            )}
            {section.ids.map((id, i) => {
              const card = data.notes[id];
              if (!card) return null;
              // The index into `rows`, not into this section: the two agree only
              // on a table with one section, which is the mistake a board's
              // reorder already made once.
              const index = offsets[`${section.lane ?? ''}/${section.value}`]! + i;
              return (
                <Row
                  key={id}
                  card={card}
                  chips={chips}
                  rollup={data.rollups?.[id]}
                  projects={projects}
                  index={index}
                  isSelected={selection.ids.has(id)}
                  isCursor={cursor === id}
                  onCursor={onCursor}
                  onOpen={onOpen}
                  onSelect={(additive) => selection.toggle(id, additive, index)}
                  onExtend={() => selection.extend(rows, index)}
                />
              );
            })}
          </tbody>
        ))}
      </table>
      {!data.ids.length && <div className="emptystate table-empty">no notes match</div>}
      </div>

      {acting.length > 0 && (
        <BulkBar
          ids={acting}
          notes={data.notes}
          counts={data.counts}
          onDone={() => {
            selection.clear();
            reload();
          }}
          onClear={selection.clear}
          onProblem={setProblem}
        />
      )}
    </div>
  );
}

function Row({
  card,
  chips,
  rollup,
  projects,
  index,
  isSelected,
  isCursor,
  onCursor,
  onOpen,
  onSelect,
  onExtend,
}: {
  card: NoteDTO;
  chips: string[];
  rollup: Rollup | undefined;
  projects: boolean;
  /** Position among the drawn rows — a shift-click's endpoint. */
  index: number;
  isSelected: boolean;
  isCursor: boolean;
  onCursor: (id: string) => void;
  onOpen: (id: string) => void;
  onSelect: (additive: boolean) => void;
  onExtend: () => void;
}) {
  const { touched } = useTouched();
  const ref = useRef<HTMLTableRowElement>(null);
  useCursorFocus(ref, isCursor);
  return (
    <tr
      ref={ref}
      // A roving tabindex, as on a board tile: only the cursor's row is a tab
      // stop, because arrowing is how you cross a list and 130 tab stops is not
      // navigation. `<tr>` takes one — the *ring* is what it cannot take, which
      // is why the treatment below is drawn on the cells.
      tabIndex={isCursor ? 0 : -1}
      data-card={card.id}
      // The table draws its own row rather than a `.cardface`, so the mark has to
      // be applied twice in the app — here and on the face. Same class, so the
      // keyframe and the reason live in one place.
      className={`${card.isProject ? 'is-project' : ''} ${isSelected ? 'is-selected' : ''} ${
        isCursor ? 'is-cursor' : ''
      } ${touched(card.id) ? 'is-touched' : ''}`}
      aria-selected={isSelected}
      data-row={index}
      onClick={(e) => {
        // Wherever a pointer lands, the keyboard picks up.
        onCursor(card.id);
        // cmd/ctrl toggles, the one gesture every shape agrees on. Shift extends a
        // run, which only a shape with an order can offer — a board has columns
        // rather than rows, and shift is already its drag modifier there.
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onSelect(true);
        } else if (e.shiftKey) {
          // Otherwise the browser selects the text between the two clicks.
          e.preventDefault();
          window.getSelection()?.removeAllRanges();
          onExtend();
        } else if (isSelected) onSelect(true);
        else onOpen(card.id);
      }}
    >
      <td className="col-title">
        {/* Same reason the chip row below has a holder: a flex `<td>` stops being
            a table cell, and the anonymous cell the table wraps around it is not
            the box the border is drawn on — see the rule in `style.css`. */}
        <span className="titlerow">
          <RecordMark card={card} />
          {card.title}
          {card.refCount > 0 && <span className="count">{card.refCount}</span>}
        </span>
      </td>
      {chips.map((facet) => (
        <td key={facet}>
          {/* The same holder a card face uses. Without it the chips were inline
              siblings with no whitespace node between them — `.chip` declares no
              display and no margin — so a two-value cell drew its chips with
              their 1px borders touching. Measured: 0px between three of them.
              The wrapper is inside the cell rather than on it, because
              `display: flex` on a `<td>` takes it out of the table's formatting
              context and the column stops aligning. */}
          <span className="chiprow">
            {/* `bucket` is what the face has always passed and the table never
                did, so the same overdue `due` value drew loud on a board and
                muted here. A bucket's hue is the axis's loudest statement about a
                value; a shape does not get an opinion about it. */}
            {axisValues(card, facet).map((v, i) => (
              <FacetChip key={v} facet={facet} value={v} bucket={card.buckets[facet]?.[i]} />
            ))}
          </span>
        </td>
      ))}
      {projects && (
        <>
          <td className="num">
            {rollup ? (
              <span title={`${rollup.direct} directly, ${rollup.total} including nested projects`}>
                {rollup.direct}
                {rollup.total !== rollup.direct && <span className="num-total"> / {rollup.total}</span>}
              </span>
            ) : (
              ''
            )}
          </td>
          <td className="num">{rollup?.blocked || ''}</td>
          <td className="num">{rollup?.untriaged || ''}</td>
        </>
      )}
      <td className="col-updated">{rollup?.touched ?? card.updated ?? ''}</td>
    </tr>
  );
}
