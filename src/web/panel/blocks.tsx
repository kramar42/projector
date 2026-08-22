import { useState } from 'react';
import { Button, IconButton } from '../components/Button.tsx';
import { RecordMark } from '../components/CardBody.tsx';
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
 * A block is a module here when it owns state, a write, or a load — the blocks
 * below. The ones that own none of the three stay as literal markup in the
 * frame, because reading their markup *is* reading their behaviour and a wrapper
 * would only rename a `<section>`.
 *
 * Each takes the slice of the writer it uses rather than the whole object, so
 * what a block can change is legible from its signature: `Facets` cannot delete
 * a card, and `Body` cannot touch an axis.
 */

/** Past this, an inbound list stops being a list and becomes the page. */
const INBOUND_CUTOFF = 6;

/**
 * Closing an editor destroys its document, so ask first.
 *
 * Both editors live behind a control that unmounts them — `read` beside `edit`,
 * `hide` beside `edit raw` — and both read as harmless view toggles sitting a
 * pixel from the one you meant. The panel already confirms on Escape and on
 * Delete; this is the same question about the same text, so it is the same
 * prompt rather than a third answer.
 */
function mayClose(dirty: boolean, what: string): boolean {
  return !dirty || confirm(`The ${what} has unsaved changes. Discard them?`);
}

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
  records: { id: string; title: string; done?: boolean; isProject: boolean; refCount: number }[];
  onOpen: (id: string) => void;
  className?: (r: { done?: boolean }) => string;
}) {
  const [all, setAll] = useState(false);
  if (!records.length) return null;
  const shown = all ? records : records.slice(0, INBOUND_CUTOFF);

  return (
    <section className="panel-section">
      <h3>
        {head}
        {records.length > 1 && <span className="quietcount section-count">{records.length}</span>}
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
          {/* A record carries its mark wherever you meet it, and this was one of
              two places it did not — the reason being that `blockedBy` and
              `children` used to ship as `{ id, title }` with neither of the two
              numbers a mark is read from. The `' ✓'` that used to sit here is
              gone with it: `.reflink.is-done` already draws that state as an `ok`
              left edge, so the tick was the same fact twice. */}
          <RecordMark card={r} />
          {r.title}
        </button>
      ))}
      {records.length > INBOUND_CUTOFF && (
        <button className="facet-more" onClick={() => setAll((v) => !v)}>
          {all ? 'less' : `${records.length - INBOUND_CUTOFF} more`}
        </button>
      )}
    </section>
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
  // No head. The rail names no such group either, and this is now the first
  // thing under the title — a label reading FACETS above a list of facet labels
  // was the section restating its own contents.
  return (
    <section className="panel-section">
      {Object.entries(defs).map(([name, def]) => (
        <FacetEditor
          key={name}
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
            thing" here and "you are in this mode" there.

            And a glyph, not a word. It was the last control in the app spelled
            out, and "refresh" beside a trash can and a `✕` is the same mistake
            as spelling those two — so the set grew by one measured member
            rather than the rule keeping an exception. */}
        <span className="section-do">
          <IconButton
            glyph="refresh"
            title="Re-fetch every link on this card"
            aria-label="Re-fetch every link on this card"
            onClick={() => refresh(card.links.map((l) => l.raw))}
          />
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
  onDirtyChange,
}: {
  cardId: string;
  yaml: string;
  write: Pick<CardWriter, 'frontmatter'>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const report = (d: boolean) => {
    setDirty(d);
    onDirtyChange(d);
  };
  return (
    <section className="panel-section">
      <h3>
        Frontmatter
        <span className="section-do">
          <Button
            tone="ghost"
            size="tiny"
            onClick={() => {
              if (open && !mayClose(dirty, 'frontmatter')) return;
              setOpen((v) => !v);
            }}
          >
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
      {open && (
        <FrontmatterEditor
          cardId={cardId}
          yaml={yaml}
          onSave={write.frontmatter}
          onDirtyChange={report}
        />
      )}
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
  const [dirty, setDirty] = useState(false);
  const report = (d: boolean) => {
    setDirty(d);
    onDirtyChange(d);
  };
  return (
    <section className="panel-section">
      <h3>
        Body
        {/* The one real mode switch in the panel, and now the only `.tab`. */}
        <span className="section-do">
          <button
            className={`tab ${mode === 'read' ? 'is-on' : ''}`}
            onClick={() => {
              if (mode === 'edit' && !mayClose(dirty, 'body')) return;
              setMode('read');
            }}
          >
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
          <p className="emptystate hint">Empty. Switch to edit to write something.</p>
        )
      ) : (
        <BodyEditor
          cardId={card.id}
          value={card.body}
          onDirtyChange={report}
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
