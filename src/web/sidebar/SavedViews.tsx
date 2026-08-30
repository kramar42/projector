import { useState } from 'react';
import { ApiError, api } from '../api.ts';
import { PopoverButton } from '../components/Popover.tsx';
import { CommitInput } from '../components/CommitInput.tsx';
import { IconButton } from '../components/Button.tsx';
import { KeyHint } from '../components/KeyHint.tsx';
import { type Patch } from '../query.ts';
import type { ViewSpec } from '../../view/spec.ts';
import { blankQuery, changeView, patchIsEmpty, specToPatch } from '../../view/intents.ts';
import type { QueryResponse, SavedViewSummary } from '../types.ts';

// ---------------------------------------------------------------- saved views

/**
 * Which starting point, and whether it still is one.
 *
 * Once shape, face and filter are all live controls, opening a saved view and
 * changing one of them leaves you somewhere ambiguous. Naming the divergence is
 * what keeps a saved view worth saving.
 */
export function SavedViews({
  views,
  current,
  spec,
  savedSpec,
  search,
  patch,
  apiSearch,
}: {
  views: SavedViewSummary[];
  current: QueryResponse['spec'] | undefined;
  /** The resolved view, and the saved one it resolved from. */
  spec: ViewSpec | null;
  savedSpec: ViewSpec | null;
  /** Only for clearing overrides: which `f.<facet>` keys are currently set. */
  search: string;
  patch: (p: Patch) => void;
  apiSearch: string;
}) {
  // Modified is "the URL says something the file does not", which is exactly what
  // the patch between the two specs says. It used to be a denylist over the URL's
  // keys, so any parameter this app does not recognise lit the badge.
  const modified =
    Boolean(current?.name) &&
    spec !== null &&
    savedSpec !== null &&
    !patchIsEmpty(specToPatch(spec, savedSpec));
  const [naming, setNaming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = (name: string, title?: string) =>
    api
      .saveView(name, apiSearch, title)
      .then((r) => {
        setNaming(false);
        setProblem(null);
        // Land on the saved view with no overrides: the query is the file now.
        patch({ ...blankQuery(spec, search), view: r.name });
      })
      .catch((e: ApiError) => setProblem(e.message));

  return (
    <>
      <div className="rail-row">
        <label className="rail-label">
          View
          <KeyHint keys="v" means="comma then v — or alt-1 to alt-9 for the nth" />
        </label>
        <PopoverButton
          minWidth={240}
          rail="view"
          label={current?.title ?? current?.name ?? 'Ad-hoc query'}
          render={(close) => (
            <>
              <div className="pop-head">Saved views</div>
              {views.map((v) => (
                <button
                  key={v.name}
                  className={`pop-pick ${v.name === current?.name ? 'is-current' : ''}`}
                  data-nav="pick"
                  onClick={() => {
                    close();
                    // Picking a view replaces the query wholesale: the old
                    // overrides belonged to the old view. All but the search —
                    // see `CARRIED`. What you are looking for is not something a
                    // view answers, and it used to be cleared at every hop.
                    patch(changeView(spec, search, v.name));
                  }}
                >
                  <span className="truncate pop-pick-name">{v.title}</span>
                  <span className="pop-annotation">{v.shape}</span>
                </button>
              ))}
              <button
                className="pop-action"
                data-nav="pick"
                data-act="view.save-as"
                onClick={() => {
                  close();
                  setNaming(true);
                }}
              >
                Save current as…
              </button>
              <button
                className="pop-action"
                data-nav="pick"
                data-act="view.blank"
                onClick={() => {
                  close();
                  patch(blankQuery(spec, search));
                }}
              >
                Start from nothing
              </button>
            </>
          )}
        />
        {modified && (
          <span className="rail-dirty" title="This saved view has unsaved changes">
            <IconButton
              glyph="check"
              data-rail="save"
              title="write these changes into the saved view — its layout and card order are kept (,V)"
              aria-label="Save changes to this view"
              onClick={() => void save(current!.name!, current!.title)}
            />
            <IconButton
              glyph="revert"
              data-act="view.revert"
              title="discard the overrides and go back to the saved view"
              aria-label="Revert changes to this view"
              onClick={() => patch(blankQuery(spec, search, current?.name ?? null))}
            />
          </span>
        )}
      </div>

      {naming && <CommitInput
          placeholder="name this view"
          wrapper={{ tag: 'div', className: 'rail-row' }}
          onCancel={() => setNaming(false)}
          onCommit={(t) => void save(t, t)} />}
      {problem && <div className="rail-problem">{problem}</div>}
    </>
  );
}



