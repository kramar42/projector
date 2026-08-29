import { Fragment, useState } from 'react';
import { Body, Facets, Frontmatter, Links, Refs, type Lit } from './blocks.tsx';
import { plural } from '../plural.ts';
import type { NoteWriter } from './usePanelWriter.ts';
import type { Meta, NoteDetail } from '../types.ts';

/**
 * The note itself: the five tiers, in their order.
 *
 * Extracted from `NotePanel` when the spread arrived, because a pinned page and
 * the open panel have to draw a note *identically* — same facet chips in the
 * same hues, same link kinds, same derived rows, same workshop — and a second
 * rendering built to look like this one is a second rendering that drifts from
 * it. What the two surfaces disagree about is the frame around this and whether
 * the reader may write; neither is a fact about the note.
 *
 * It owns no state and no load. Its host does both, which is what lets the panel
 * keep its unsaved-changes guard and a page borrow it unchanged.
 */

/**
 * What `ƒ` means on a workshop row. One string, because it is now on five or more
 * of them and a per-row wording would be five chances to say it differently.
 */
const INHERITED = 'resolved along the project facet and its chain, not stored on this note';

/**
 * The project's instruction blocks, behind a disclosure the app draws itself.
 *
 * It was a `<details>`/`<summary>` — the only native disclosure left in the app,
 * against The Drawn Control Rule, which had audited three checkboxes and two
 * selects and missed this one. `.facet-more` is the button the panel and the rail
 * already use for "there is more of this list", which is the same sentence.
 */
function Instructions({ blocks }: { blocks: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    /*
     * A navlist of one, so the walk can reach the disclosure — the same shape
     * `AddAxis` uses, and for the same reason it gave.
     *
     * It had no keyboard address at all while it lived in `NotePanel`, where the
     * file's other controls hid it from the parity check; splitting the tiers out
     * is what made a control reachable only by Tab visible as one. `data-nav-more`
     * rather than `data-nav` because that is what it is: the panel's own "there is
     * more of this" button, which `listMove` already knows to press and read on
     * through.
     */
    <div data-navlist="instructions" data-nav-flow="column">
      <button className="facet-more" data-nav-more="" onClick={() => setOpen((v) => !v)}>
        {open ? 'hide' : plural(blocks.length, 'instruction block')}
      </button>
      {open && <pre className="instructions">{blocks.join('\n\n')}</pre>}
    </div>
  );
}

export function NoteTiers({
  id,
  meta,
  data,
  write,
  lit,
  onOpen,
  onFocus,
  onBodyDirty,
  onFrontmatterDirty,
}: {
  id: string;
  meta: Meta;
  data: NoteDetail;
  write: NoteWriter;
  lit: Lit;
  onOpen: (id: string, mods?: { altKey?: boolean; shiftKey?: boolean }) => void;
  /** Walk `via` inward from this note and show what it reaches. */
  onFocus: (id: string, via: string) => void;
  onBodyDirty: (dirty: boolean) => void;
  onFrontmatterDirty: (dirty: boolean) => void;
}) {
  const card = data.note;
  return (
    /*
     * Five tiers, not ten peers.
     *
     * The order is what the panel is opened for, and one rule decides it:
     * a region whose height the note controls goes above one whose height
     * the *content* controls. Otherwise the thing you came to click moves
     * every time a body gets longer or a project gains a child.
     *
     *   facets      the properties — bounded, and the commonest edit
     *   body        what the note says — unbounded, and why you came
     *   links       what it points at — unbounded
     *   refs        the notes it names, and the notes that name it
     *   workshop    the raw file, what it inherits, and the rare action
     *
     * Two of those moved. **Body is above Links** because the rule cannot
     * rank them — both are unbounded, five enriched links run to 400px —
     * so the tie breaks on what a note is for: PRODUCT.md asks that a note
     * carry enough context for a Claude session to start unbriefed, and
     * that context is the prose, not the link list.
     *
     * **Refs is one tier** holding every axis that points at a note and
     * both derived lists that point back. `Blocks` and `Blocked by` were
     * two names two letters apart with the whole body between them.
     *
     * `Delete` used to be the first control in the panel, above the note's
     * own id, at the same size as everything else. Weight follows blast
     * radius, so it sits in the header's far corner now — which is also
     * where the project toggle is, and that pairing is not ideal: see the
     * mark's own comment.
     */
    <div className="panel-body">
      <div className="panel-tier">
        <Facets defs={meta.facets} values={card.facets} write={write} lit={lit} />
      </div>

      <div className="panel-tier">
        <Body card={card} write={write} onDirtyChange={onBodyDirty} lit={lit('body')} />
      </div>

      <div className="panel-tier">
        <Links card={card} write={write} lit={lit('links')} />
      </div>

      <div className="panel-tier">
        <Refs
          defs={meta.facets}
          card={card}
          data={data}
          write={write}
          onOpen={onOpen}
          // The panel does not own the query — the shell does — so a
          // derived row's focus control names the note and the relation
          // and lets `App` reshape the view. Same call the keyboard's
          // `gotoInverse` makes, so the two cannot drift apart.
          onFocus={(via) => onFocus(id, via)}
          lit={lit}
        />
      </div>

      {/*
        The workshop: the raw file, everything the note inherits, and the
        one rare action.

        This was two `kv` readouts one hairline apart — `Inherited` with the
        project chain, and an unheaded pair of `file` and `updated` sitting
        under the `Frontmatter` heading as though they were what `edit raw`
        edits. Only one of them was. Both lists answer the same question,
        *what is true of this note that you do not set as a facet*, so they
        are one list, and `ƒ` marks the rows that are resolved rather than
        stored — which is the distinction the two headings were reaching for
        and getting wrong in opposite directions.

        Not headed "Project": that word already names the axis in Refs above
        and the mark by the title. One word per idea.
      */}
      <div className="panel-tier">
        <Frontmatter
          cardId={card.id}
          yaml={data.yaml}
          write={write}
          onDirtyChange={onFrontmatterDirty}
        >
          <dl className="kv">
            {/* The id row is gone: it was the `?card=` parameter in the
                address bar and the stem of the filename beside it, so the
                same string appeared three times on the first fold. */}
            <dt>file</dt>
            <dd><code>{data.file}</code></dd>
            {card.updated && (<><dt>updated</dt><dd>{card.updated}</dd></>)}
            {data.project && (
              <>
                <dt>
                  key
                  <span className="computed" title={INHERITED}>ƒ</span>
                </dt>
                <dd><code>{data.project.key}</code></dd>
                <dt>
                  chain
                  <span className="computed" title={INHERITED}>ƒ</span>
                </dt>
                <dd>{data.project.chain.join(' → ')}</dd>
                {data.project.jira && (<><dt>jira<span className="computed" title={INHERITED}>ƒ</span></dt><dd><code>{data.project.jira}</code></dd></>)}
                {data.project.branch && (<><dt>branch<span className="computed" title={INHERITED}>ƒ</span></dt><dd><code>{data.project.branch}</code></dd></>)}
                {data.project.repos.map((r) => (
                  <Fragment key={r.path}>
                    <dt>repo<span className="computed" title={INHERITED}>ƒ</span></dt>
                    <dd><code>{r.path}</code>{r.base ? ` @ ${r.base}` : ''}</dd>
                  </Fragment>
                ))}
              </>
            )}
          </dl>
          {data.project && data.project.instructions.length > 0 && (
            <Instructions blocks={data.project.instructions} />
          )}
        </Frontmatter>
      </div>
    </div>
  );
}
