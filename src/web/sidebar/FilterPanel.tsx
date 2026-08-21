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
      {!counts.length && <div className="filters-empty">nothing to filter on</div>}
    </div>
  );
}

const CUTOFF = 8;

function Facet({ facet, edit }: { facet: FacetCount; edit: Edit }) {
  const selected = facet.values.filter((v) => v.selected);
  // A facet you are using stays open; one you are not starts collapsed, or ten
  // facets of vocabulary bury the two you care about.
  const [open, setOpen] = useState(selected.length > 0);
  const [all, setAll] = useState(false);

  const shown = all ? facet.values : facet.values.slice(0, CUTOFF);
  const more = facet.values.length - shown.length;

  return (
    <section className={`facet ${open ? 'is-open' : ''} ${selected.length ? 'is-active' : ''}`}>
      <button className="facet-head" onClick={() => setOpen((v) => !v)}>
        <span className={`facet-caret ${open ? 'is-open' : ''}`} aria-hidden="true" />
        <span className="facet-label">{facet.label}</span>
        {facet.pseudo && (
          <span className="facet-pseudo" title="computed from the cards, not stored on them">
            ƒ
          </span>
        )}
        {selected.length > 0 && <span className="facet-badge">{selected.length}</span>}
      </button>

      {open && (
        <div className="facet-values">
          {shown.map((v) => (
            <label key={v.value} className={`facet-value ${v.selected ? 'is-on' : ''} ${v.count ? '' : 'is-empty'}`}>
              <input
                type="checkbox"
                checked={v.selected}
                onChange={() => edit((s) => toggleFilterValue(s, facet.facet, v.value))}
              />
              <span className={`facet-name ${v.value === NONE ? 'is-none' : ''}`}>
                {labelFor(v.value)}
              </span>
              <span className="facet-count">{v.count}</span>
            </label>
          ))}
          {more > 0 && (
            <button className="facet-more" onClick={() => setAll(true)}>
              {more} more
            </button>
          )}
          {all && facet.values.length > CUTOFF && (
            <button className="facet-more" onClick={() => setAll(false)}>
              less
            </button>
          )}
        </div>
      )}
    </section>
  );
}
