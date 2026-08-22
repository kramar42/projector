import { useState } from 'react';
import { NONE } from '../../schema/vocabulary.ts';
import { labelFor } from '../views/groups.ts';
import { toggleFilterValue } from '../../view/intents.ts';
import type { FacetCount } from '../types.ts';
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
export function FilterPanel({ counts, edit }: { counts: FacetCount[]; edit: Edit }) {
  const active = counts.filter((c) => c.values.some((v) => v.selected));
  const rest = counts.filter((c) => !c.values.some((v) => v.selected));

  return (
    <div className="filters">
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

function Facet({ facet, edit }: { facet: FacetCount; edit: Edit }) {
  const selected = facet.values.filter((v) => v.selected);
  // A facet you are using stays open; one you are not starts collapsed, or ten
  // facets of vocabulary bury the two you care about.
  const [open, setOpen] = useState(selected.length > 0);
  const [all, setAll] = useState(false);

  const shown = all ? facet.values : facet.values.slice(0, CUTOFF);

  return (
    <section className={`facet ${open ? 'is-open' : ''} ${selected.length ? 'is-active' : ''}`}>
      <button className="facet-head" onClick={() => setOpen((v) => !v)}>
        <span className={`facet-caret ${open ? 'is-open' : ''}`} aria-hidden="true" />
        <span className="truncate facet-label">{facet.label}</span>
        {facet.pseudo && (
          <span className="derived" title="computed from the cards, not stored on them">
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
            />
          ))}
          {/* One button, not two that swap places. Rendering `more` and `less` in
              different slots means the element you activated is gone by the time
              the list has changed, so focus falls to the document and a keyboard
              reader loses their place mid-list. */}
          {facet.values.length > CUTOFF && (
            <button className="facet-more" onClick={() => setAll((v) => !v)}>
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
}: {
  value: FacetCount['values'][number];
  onToggle: () => void;
}) {
  const label = labelFor(value.value);
  const none = value.value === NONE;
  // A selected value whose count fell to zero is still shown, or it could never
  // be unselected — so it dims rather than disappearing.
  const cls = `${value.selected ? 'is-on' : ''} ${value.count ? '' : 'is-empty'}`;

  return (
    <label className={`facet-value ${cls}`}>
      <input type="checkbox" checked={value.selected} onChange={onToggle} />
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
