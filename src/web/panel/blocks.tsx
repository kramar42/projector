import { useState } from 'react';
import { Button } from '../components/Button.tsx';
import { FacetEditor } from '../components/FacetEditor.tsx';
import { RecordPicker } from '../components/RecordPicker.tsx';
import { LinkEditor } from '../components/LinkEditor.tsx';
import { BodyEditor } from '../components/BodyEditor.tsx';
import { FrontmatterEditor } from '../components/FrontmatterEditor.tsx';
import { useEnrichment, useRequestEnrichment } from '../enrichment.tsx';
import { renderBody } from '../../view/markdown.ts';
import type { CardWriter } from './usePanelWriter.ts';
import type { CardDTO, Meta } from '../types.ts';

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
 * The parent, as titles you can walk to.
 *
 * It writes `parent` through the ordinary facet door now. It used to reach for
 * the bulk endpoint, which takes no base mtime and never calls the write gate —
 * so this control silently overwrote a concurrent agent edit while the `Part of`
 * chip row further down correctly refused (C4: relations are written like every
 * other axis, and this one was the exception).
 *
 * What it still adds over that chip row is the reason it survives: titles rather
 * than ids, navigation on click, and a picker that excludes the card itself so
 * "be your own parent" stays impossible rather than becoming a 400.
 */
export function Parent({
  card,
  parents,
  write,
  onOpen,
}: {
  card: CardDTO;
  parents: { id: string; title: string }[];
  write: Pick<CardWriter, 'facet'>;
  onOpen: (id: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <section className="panel-section">
      <h3>Parent</h3>
      {parents.map((p) => (
        <button className="reflink" key={p.id} onClick={() => onOpen(p.id)}>
          {p.title}
        </button>
      ))}
      {!picking ? (
        <Button size="small" onClick={() => setPicking(true)}>
          {parents.length ? 'Change parent' : 'Set parent'}
        </Button>
      ) : (
        <RecordPicker
          exclude={[card.id]}
          placeholder="parent record…"
          clearLabel="— no parent —"
          onCancel={() => setPicking(false)}
          onPick={(pid) => {
            setPicking(false);
            // `parent` is single: picking one genuinely replaces it.
            write.facet('parent', pid ? [pid] : [], 'set');
          }}
        />
      )}
      <p className="hint">
        A parent means decomposition — this card is <em>part of</em> that one — and is what
        the canvas draws. Membership is the <code>project</code> facet, and only that: repos
        and instructions are inherited through it, never through a parent edge. The two are
        independent, so a card can have either, both or neither.
      </p>
    </section>
  );
}

export function Facets({
  defs,
  values,
  write,
}: {
  defs: Meta['facets'];
  values: CardDTO['facets'];
  write: Pick<CardWriter, 'facet'>;
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
      {!open ? (
        <p className="hint">
          Everything above edits the frontmatter through chips. Open this to set what the panel
          does not draw — a project's repos, a branch template, keys added later.
        </p>
      ) : (
        // No fetch. The yaml arrives with the card, from the same read as its
        // mtime, so there is no second copy of this file to go stale — which is
        // what used to make saving here revert whatever the chips had just done.
        <FrontmatterEditor cardId={cardId} yaml={yaml} onSave={write.frontmatter} />
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
