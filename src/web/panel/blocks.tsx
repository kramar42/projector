import { useState } from 'react';
import { Button } from '../components/Button.tsx';
import { FacetEditor } from '../components/FacetEditor.tsx';
import { LinkEditor } from '../components/LinkEditor.tsx';
import { BodyEditor } from '../components/BodyEditor.tsx';
import { FrontmatterEditor } from '../components/FrontmatterEditor.tsx';
import { useEnrichment, useRequestEnrichment } from '../enrichment.tsx';
import { renderBody } from '../../view/markdown.ts';
import type { CardWriter } from './usePanelWriter.ts';
import type { CardDTO, CardDetail, Meta } from '../types.ts';

/**
 * The panel's blocks.
 *
 * A block is a module here when it owns state, a write, or a load — the six
 * below. The ones that own none of the three stay as literal markup in the
 * frame, because reading their markup *is* reading their behaviour and a wrapper
 * would only rename a `<section>`.
 *
 * Each takes the slice of the writer it uses rather than the whole object, so
 * what a block can change is legible from its signature: `Facets` cannot delete
 * a card, and `Actions` cannot touch an axis.
 */

/** Past this, an inbound list stops being a list and becomes the page. */
const INBOUND_CUTOFF = 6;

/**
 * A list of records this card did not choose: what blocks it, what is part of it.
 *
 * Capped, because it is unbounded and it is not why the panel was opened. A
 * project with sixteen children drew all sixteen — 569px, forty per cent of the
 * panel — and pushed the body a full screen down, which is the thing the last
 * pass had just fixed arriving through a different door. The `n more` is the
 * sidebar's own, rather than a scroll inside a scroll.
 */
export function Inbound({
  head,
  means,
  records,
  onOpen,
  className,
}: {
  head: string;
  means: string;
  records: { id: string; title: string; done?: boolean }[];
  onOpen: (id: string) => void;
  className?: (r: { done?: boolean }) => string;
}) {
  const [all, setAll] = useState(false);
  if (!records.length) return null;
  const shown = all ? records : records.slice(0, INBOUND_CUTOFF);
  const more = records.length - shown.length;

  return (
    <section className="panel-section">
      <h3>
        {head}
        {records.length > 1 && <span className="section-count">{records.length}</span>}
        {/* The same `ƒ` the filter rail puts on an axis it computed rather than
            read — there is no edit here because the edit lives on the other card. */}
        <span className="derived" title={means}>
          ƒ
        </span>
      </h3>
      {shown.map((r) => (
        <button
          className={`reflink ${className?.(r) ?? ''}`}
          key={r.id}
          onClick={() => onOpen(r.id)}
        >
          {r.title}
          {r.done ? ' ✓' : ''}
        </button>
      ))}
      {more > 0 && (
        <button className="facet-more" onClick={() => setAll(true)}>
          {more} more
        </button>
      )}
      {all && records.length > INBOUND_CUTOFF && (
        <button className="facet-more" onClick={() => setAll(false)}>
          less
        </button>
      )}
    </section>
  );
}

export function Actions({
  card,
  write,
}: {
  card: CardDTO;
  write: Pick<CardWriter, 'projectBlock' | 'remove'>;
}) {
  return (
    <div className="panel-actions">
      {/* There is no promote/demote, because there is no class of record to move
          between. A record is work when it carries a lifecycle, which is the
          Status facet below. */}
      <Button
        size="small"
        title={
          card.isProject
            ? 'Remove the project block. Records naming this one in their project facet stop inheriting repos and instructions from it.'
            : 'Add a project block, so this record can own repos and instructions that its members inherit.'
        }
        // A project's key is its record id, so the block starts empty.
        onClick={() => write.projectBlock(card.isProject ? null : {})}
      >
        {card.isProject ? 'Not a project' : 'Make a project'}
      </Button>
      <Button
        tone="danger"
        size="small"
        onClick={() => {
          if (!confirm(`Delete "${card.title}"?\n\nThe file is in git, so this is recoverable.`))
            return;
          write.remove();
        }}
      >
        Delete
      </Button>
    </div>
  );
}

/**
 * Every axis, drawn the same way.
 *
 * There is no section above this one for `parent` any more. It had grown its own
 * because the generic reference row drew raw ids and could not be walked, so the
 * one relation that mattered daily got a better control — and the card ended up
 * carrying two editors for one axis, fifty pixels apart, with no way to tell
 * which was authoritative. Fixing the generic row for every reference facet made
 * the bespoke one redundant rather than merely unwanted (C4).
 */
export function Facets({
  defs,
  values,
  refs,
  selfId,
  write,
  onOpen,
}: {
  defs: Meta['facets'];
  values: CardDTO['facets'];
  refs: CardDetail['refs'];
  selfId: string;
  write: Pick<CardWriter, 'facet'>;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="panel-section">
      <h3>Facets</h3>
      {Object.entries(defs).map(([name, def]) => (
        <FacetEditor
          key={name}
          name={name}
          def={def}
          values={values[name] ?? []}
          refs={refs}
          selfId={selfId}
          onOpen={onOpen}
          // One axis, named, and the editor says whether it replaced the axis
          // or named a delta on it. Neither the map nor — for a toggle — the
          // axis's other values are asserted, so nothing an agent changed
          // between this render and the click is reverted by it.
          onChange={(next, mode) => write.facet(name, next, mode)}
        />
      ))}
    </section>
  );
}

export function Links({ card, write }: { card: CardDTO; write: Pick<CardWriter, 'links'> }) {
  const { refresh } = useEnrichment();
  useRequestEnrichment(card.links.map((l) => l.raw));

  return (
    <section className="panel-section">
      <h3>
        Links
        {/* An action, so it is a button. It used to wear the tab pill that the
            Body block uses for a mode switch, which made one shape mean "do a
            thing" here and "you are in this mode" there. */}
        <span className="section-do">
          <Button
            tone="ghost"
            size="tiny"
            title="Re-fetch every link on this card"
            onClick={() => refresh(card.links.map((l) => l.raw))}
          >
            refresh
          </Button>
        </span>
      </h3>
      <LinkEditor links={card.links} onChange={(next) => write.links(next)} />
    </section>
  );
}

export function Frontmatter({
  cardId,
  yaml,
  write,
}: {
  cardId: string;
  yaml: string;
  write: Pick<CardWriter, 'frontmatter'>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel-section">
      <h3>
        Frontmatter
        <span className="section-do">
          <Button tone="ghost" size="tiny" onClick={() => setOpen((v) => !v)}>
            {open ? 'hide' : 'edit raw'}
          </Button>
        </span>
      </h3>
      {/* No fetch. The yaml arrives with the card, from the same read as its
          mtime, so there is no second copy of this file to go stale — which is
          what used to make saving here revert whatever the chips had just done.

          Nothing renders when it is closed. There was a paragraph here saying
          the chips above edit the frontmatter and this opens the rest; the
          control it sat under is labelled `edit raw`, on a surface with one
          reader who wrote both. */}
      {open && <FrontmatterEditor cardId={cardId} yaml={yaml} onSave={write.frontmatter} />}
    </section>
  );
}

export function Body({
  card,
  write,
  onDirtyChange,
}: {
  card: CardDTO;
  write: Pick<CardWriter, 'body'>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  return (
    <section className="panel-section">
      <h3>
        Body
        {/* The one real mode switch in the panel, and now the only `.tab`. */}
        <span className="tabs">
          <button className={`tab ${mode === 'read' ? 'is-on' : ''}`} onClick={() => setMode('read')}>
            read
          </button>
          <button className={`tab ${mode === 'edit' ? 'is-on' : ''}`} onClick={() => setMode('edit')}>
            edit
          </button>
        </span>
      </h3>
      {mode === 'read' ? (
        card.body.trim() ? (
          <div className="md" dangerouslySetInnerHTML={{ __html: renderBody(card.body) }} />
        ) : (
          <p className="hint">Empty. Switch to edit to write something.</p>
        )
      ) : (
        <BodyEditor
          cardId={card.id}
          value={card.body}
          onDirtyChange={onDirtyChange}
          // `write.body` rejects on failure, which is the contract this editor
          // has always assumed. It used to be handed a function that caught
          // everything and resolved, so a refused save reported "saved", cleared
          // the dirty flag, and let the next refetch replace the typed text.
          onSave={write.body}
        />
      )}
    </section>
  );
}
