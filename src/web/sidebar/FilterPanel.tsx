import { useState } from 'react';
import { NONE } from '../views/dragSemantics.ts';
import { toggleValue, type Patch } from '../query.ts';
import type { FacetCount } from '../types.ts';

/**
 * The facet panel.
 *
 * Four properties do the work, and none of them is decoration:
 *
 * - **Counts are disjunctive.** The server computed each facet's values with that
 *   facet's own selection lifted, so an unselected value still says what adding
 *   it would bring. Counted against the filtered set instead, every unselected
 *   value would read 0 and the panel would be a trapdoor.
 * - **`(none)` is a value.** 82 of 159 cards carry no project; reaching them is
 *   the single most useful thing in here.
 * - **Empty facets are absent.** The server drops any facet with nothing behind
 *   it, which is what keeps `layer` (157 of 159 cards lack it) out of the way
 *   without a scope rule in the UI.
 * - **Selected facets come first**, so an active refinement is never scrolled
 *   out of sight.
 */
export function FilterPanel({
  counts,
  search,
  saved,
  patch,
}: {
  counts: FacetCount[];
  search: string;
  saved: boolean;
  patch: (p: Patch) => void;
}) {
  const active = counts.filter((c) => c.values.some((v) => v.selected));
  const rest = counts.filter((c) => !c.values.some((v) => v.selected));

  return (
    <div className="filters">
      {[...active, ...rest].map((facet) => (
        <Facet key={facet.facet} facet={facet} search={search} saved={saved} patch={patch} />
      ))}
      {!counts.length && <div className="filters-empty">nothing to filter on</div>}
    </div>
  );
}

const CUTOFF = 8;

function Facet({
  facet,
  search,
  saved,
  patch,
}: {
  facet: FacetCount;
  search: string;
  saved: boolean;
  patch: (p: Patch) => void;
}) {
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
        <span className="facet-caret">{open ? '▾' : '▸'}</span>
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
                onChange={() => patch(toggleValue(search, facet.facet, v.value, saved))}
              />
              <span className={`facet-name ${v.value === NONE ? 'is-none' : ''}`}>
                {v.value === NONE ? 'none' : v.value}
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
