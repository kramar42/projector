import { useState } from 'react';
import { NONE } from '../../schema/vocabulary.ts';
import { labelFor } from '../views/groups.ts';
import { excludeFilterValue, toggleFilterValue } from '../../view/intents.ts';
import type { AxisCount } from '../types.ts';
import type { Edit } from '../types.ts';

/**
 * The facet panel.
 *
 * Four properties do the work, and none of them is decoration:
 *
 * - **Counts are disjunctive.** The server computed each facet's values with that
 *   facet's own selection lifted, so an unselected value still says what adding
 *   it would bring. Counted against the filtered set instead, every unselected
 *   value would read 0 and the panel would be a trapdoor.
 * - **`(none)` is a value.** Most cards carry no project; reaching them is the
 *   single most useful thing in here.
 * - **Empty facets are absent.** The server drops any facet with nothing behind
 *   it, which is what keeps a niche taxonomy like `layer` out of the way — and
 *   is why a facet needs no scoping rule of its own to stay out of the panel.
 * - **Selected facets come first**, so an active refinement is never scrolled
 *   out of sight.
 */
/** In use, either way round: a value ruled out is a refinement like any other. */
const inUse = (c: AxisCount) => c.values.some((v) => v.selected || v.excluded);

export function FilterPanel({ counts, edit }: { counts: AxisCount[]; edit: Edit }) {
  const active = counts.filter(inUse);
  const rest = counts.filter((c) => !inUse(c));

  return (
    /*
      One list, walked top to bottom.

      The heads and the values are items of the *same* list rather than two nested
      ones, which is what makes `j` from a closed axis land on the next axis and
      `j` from an open one land on its first value — the reader's eye already
      reads the rail that way, because a closed axis draws no values to step over.
    */
    <div className="filters" data-navlist="filter">
      {[...active, ...rest].map((facet) => (
        <Facet key={facet.facet} facet={facet} edit={edit} />
      ))}
      {!counts.length && <div className="emptystate filters-empty">nothing to filter on</div>}
    </div>
  );
}

const CUTOFF = 8;

/**
 * How a filter value draws whether it is on: a drawn checkbox.
 *
 * The Drawn Control Rule says nothing on screen is drawn by the browser, and the
 * checkbox here was the last one that was — once per value, eight values a facet,
 * thirteen facets down a 248px rail. Which is why it was three candidates rather
 * than one substitution: at that repetition a checkbox and a chip read completely
 * differently, and neither can be judged from a single row.
 *
 * They were built and looked at. `chip` fitted nine facets where this fits five
 * and unified the rail with the panel's editor, at the cost of a wall of pills and
 * a count that ran into its value. `edge` was the quietest and lost the affordance
 * with it — with nothing in the left column the rows read as a readout. The box
 * keeps the column the eye scans down, which is what a filter rail is for.
 */

function Facet({ facet, edit }: { facet: AxisCount; edit: Edit }) {
  // Both states count as using the axis: the badge, the open-by-default and the
  // `is-active` treatment all answer "am I filtering on this", and ruling a value
  // out is filtering on it. An exclusion you cannot see is one you spend the
  // afternoon looking for.
  const selected = facet.values.filter((v) => v.selected || v.excluded);
  /**
   * A facet you are using is open; one you are not is collapsed, or ten facets of
   * vocabulary bury the two you care about. A facet you have opened or closed
   * yourself stays where you put it.
   *
   * That second half used to come for free from `useState(selected.length > 0)`:
   * the panel was thrown away and rebuilt on every change of query, so the
   * initialiser ran again each time and the derived answer was never stale for
   * longer than a frame. The panel survives a change of query now, so the
   * derivation has to be stated rather than captured — otherwise picking a value
   * in the rail is the last time a section ever reconsiders whether to be open.
   */
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? selected.length > 0;
  const [all, setAll] = useState(false);

  const shown = all ? facet.values : facet.values.slice(0, CUTOFF);

  return (
    <section className={`facet ${open ? 'is-open' : ''} ${selected.length ? 'is-active' : ''}`}>
      <button className="facet-head" data-nav="axis" aria-expanded={open} onClick={() => setManual(!open)}>
        <span className={`facet-caret ${open ? 'is-open' : ''}`} aria-hidden="true" />
        <span className="truncate facet-label">{facet.label}</span>
        {facet.computed && (
          <span className="computed" title="computed from the cards, not stored on them">
            ƒ
          </span>
        )}
        {selected.length > 0 && <span className="facet-badge">{selected.length}</span>}
      </button>

      {open && (
        <div className="facet-values">
          {shown.map((v) => (
            <Value
              key={v.value}
              value={v}
              onToggle={() => edit((s) => toggleFilterValue(s, facet.facet, v.value))}
              onExclude={() => edit((s) => excludeFilterValue(s, facet.facet, v.value))}
            />
          ))}
          {/* One button, not two that swap places. Rendering `more` and `less` in
              different slots means the element you activated is gone by the time
              the list has changed, so focus falls to the document and a keyboard
              reader loses their place mid-list. */}
          {facet.values.length > CUTOFF && (
            <button className="facet-more" data-nav-more="" onClick={() => setAll((v) => !v)}>
              {all ? 'less' : `${facet.values.length - CUTOFF} more`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One filter value.
 *
 * A `<label>` wrapping a real checkbox, because that is what this is: a checkbox
 * states "on or off" to a screen reader where a toggle button would state
 * "pressed". The input stays real and stays focusable; only its drawing is ours.
 *
 * The count is not decoration. The counts are disjunctive, so an unselected
 * value's number says what *adding* it would bring — the one thing in the rail
 * that says what a click does before you click it.
 */
function Value({
  value,
  onToggle,
  onExclude,
}: {
  value: AxisCount['values'][number];
  onToggle: () => void;
  /** Alt-click: filter this value *out*. See `NOT` in `schema/vocabulary.ts`. */
  onExclude: () => void;
}) {
  const label = labelFor(value.value);
  const none = value.value === NONE;
  // A selected value whose count fell to zero is still shown, or it could never
  // be unselected — so it dims rather than disappearing.
  //
  // `is-out` wins over `is-on` when a hand-written URL says both, because that is
  // what the query does with it: a negation vetoes. One class rather than two, so
  // the two treatments cannot both paint the same box.
  const state = value.excluded ? 'is-out' : value.selected ? 'is-on' : '';
  const cls = `${state} ${value.count ? '' : 'is-empty'}`;

  return (
    <label
      className={`facet-value ${cls}`}
      /*
       * Alt rather than ⌘ or ⇧: both of those already mean something in this app's
       * gesture grammar — ⌘-click adds to a selection, ⇧-click extends a range —
       * and a modifier meaning two things on two surfaces is one you have to
       * remember rather than know.
       *
       * `preventDefault` because this is a `<label>`, whose default is to forward
       * the click to the checkbox — which would select the value on the way to
       * ruling it out.
       */
      onClick={(e) => {
        if (!e.altKey) return;
        e.preventDefault();
        onExclude();
      }}
      title={value.excluded ? 'filtered out — alt-click to stop' : 'alt-click to filter out'}
    >
      <input
        type="checkbox"
        /* A checkbox takes no text, so `inField` hands `j` and `k` back to the
           map and the rail can be walked with focus sitting on one. */
        data-nav="value"
        checked={value.selected}
        onChange={onToggle}
        /*
         * Not `aria-checked="mixed"`. Mixed means *partly* checked, and this is
         * the opposite of checked — so the fact goes into the accessible name,
         * where it is read out as what it is, and the control stays the honest
         * two-state checkbox it looks like.
         */
        aria-label={value.excluded ? `${label} — filtered out` : undefined}
      />
      {/* The box is a sibling span rather than the input restyled, for the same
          reason `.facet-caret` is: a span drawn with borders is the technique this
          app already has for a mark it draws itself, and generated content on a
          replaced element is not reliably rendered. The input stays real and
          stays focusable; only its drawing is ours, which is also what lets the
          facets popover share the same box. */}
      <span className="checkbox" aria-hidden="true" />
      <span className={`truncate facet-name ${none ? "is-none" : ""}`}>{label}</span>
      <span className="quietcount facet-count">{value.count}</span>
    </label>
  );
}
