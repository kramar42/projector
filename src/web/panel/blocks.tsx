import { useState, type ReactNode } from 'react';
import { IconButton } from '../components/Button.tsx';
import { PopoverButton } from '../components/Popover.tsx';
import { RecordMark } from '../components/CardBody.tsx';
import { KeyHint } from '../components/KeyHint.tsx';
import { FacetEditor } from '../components/FacetEditor.tsx';
import { LinkEditor } from '../components/LinkEditor.tsx';
import { BodyEditor } from '../components/BodyEditor.tsx';
import { FrontmatterEditor } from '../components/FrontmatterEditor.tsx';
import { useEnrichment, useRequestEnrichment } from '../enrichment.tsx';
import { focusSoon } from '../cursor.ts';
import { renderBody } from '../../view/markdown.ts';
import type { NoteWriter } from './usePanelWriter.ts';
import type { NoteDTO, NoteDetail, Meta } from '../types.ts';

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
 * a note, and `Body` cannot touch an axis.
 */

/**
 * Which of this block's parts just moved without the reader.
 *
 * A predicate rather than a set, so a block asks about the key it is drawing and
 * nothing has to know how the answer is computed. Absent means "nothing is lit",
 * which is what every caller outside the panel wants — the wash is a panel thing.
 */
export type Lit = (key: string) => boolean;

const nothingLit: Lit = () => false;

/**
 * Past this, an inbound list stops being a list and becomes the page.
 *
 * Three, matching the link list, and for the same reason: these are full-width
 * rows rather than wrapping chips, so three of them already outweigh the section
 * they sit in. It was six — chosen when the two lists had a tier to themselves and
 * the only failure being fixed was a project with sixteen children drawing all
 * sixteen. Now that they share a tier with three editable axes, six rows is the
 * tier.
 */
const INBOUND_CUTOFF = 3;

/**
 * Closing an editor destroys its document, so ask first.
 *
 * Both editors live behind one toggle each, and both read as harmless view
 * switches sitting a pixel from the one you meant. The panel already confirms on
 * Escape and on Delete; this is the same question about the same text, so it is
 * the same prompt rather than a third answer.
 */
function mayClose(dirty: boolean, what: string): boolean {
  return !dirty || confirm(`The ${what} has unsaved changes. Discard them?`);
}

/**
 * Which axes a section draws, and the control that reveals the rest.
 *
 * The rule is the filter rail's, applied to the panel at last: **an axis with
 * nothing on it is absent.** The rail has always said so — "the server drops any
 * facet with nothing behind it, which is what keeps a niche taxonomy like `layer`
 * out of the way" — while the panel drew all thirteen and let nine of them say
 * only their own name.
 *
 * The one thing the rail does not have to solve is that this surface *writes*.
 * Hiding an empty axis hides the only way to give it a first value, so the
 * absence needs a door: `revealed` is the axis you asked for by name, held here
 * rather than on the row, because the row does not exist yet when you ask.
 */
function useRevealed(pick: string[], carried: (name: string) => boolean) {
  const [revealed, setRevealed] = useState<string[]>([]);
  /** Carried, or asked for. Declaration order, because `pick` is in it. */
  const show = (name: string) => carried(name) || revealed.includes(name);
  return {
    show,
    /** What the door still has behind it — neither carried nor asked for. */
    hidden: pick.filter((n) => !show(n)),
    reveal: (name: string) => setRevealed((r) => (r.includes(name) ? r : [...r, name])),
  };
}

/** The door itself. One shape, two sections, so they cannot drift apart. */
function AddAxis({
  label,
  title,
  hidden,
  defs,
  onPick,
}: {
  label: string;
  /** Distinct per section: two doors sharing one sentence are two doors a screen
      reader cannot tell apart, and the label is the only other thing it has. */
  title: string;
  hidden: string[];
  defs: Meta['facets'];
  onPick: (name: string) => void;
}) {
  if (!hidden.length) return null;
  return (
    /*
     * A navlist of one, so the walk can reach the door.
     *
     * `gf` enters the facet grid and `j` steps down the axes; the last step lands
     * here, which is where it should land — the door is the bottom of that list in
     * every sense but the DOM's. Without this the only keyboard path to an axis
     * the note carries nothing on was Tab, which is the gap the hints were
     * supposed to make visible rather than leave.
     */
    <div data-navlist="add" data-nav-flow="column">
    <PopoverButton
      className="addbtn"
      nav="add"
      minWidth={180}
      fitContent
      label={label}
      title={title}
      render={(close) => (
        <>
          {hidden.map((n) => (
            <button
              key={n}
              className="pop-pick"
              data-nav="pick"
              onClick={() => {
                onPick(n);
                close();
                /**
                 * And land on the row that just appeared.
                 *
                 * Revealing an axis is never the thing you wanted — giving it a
                 * value is, and it is the very next move every time. Leaving focus
                 * on a popover that has just unmounted drops it to the body, so
                 * the keyboard had to find its way back to a row it had only just
                 * asked for.
                 *
                 * Not only for the keyboard: a pointer has nothing else holding
                 * focus at this moment either, so the same landing is right.
                 */
                focusSoon(() =>
                  document.querySelector<HTMLElement>(
                    `.panel [data-axis="${CSS.escape(n)}"]:not([data-inverse]) [data-nav]`,
                  ),
                );
              }}
            >
              <span className="truncate pop-pick-name">{defs[n]!.label}</span>
            </button>
          ))}
        </>
      )}
    />
    </div>
  );
}

/**
 * A list of notes this note did not choose: what blocks it, what is part of it.
 *
 * Capped, because it is unbounded and it is not why the panel was opened. A
 * project with sixteen children drew all sixteen — 569px, forty per cent of the
 * panel — and pushed the body a full screen down. The `n more` is the sidebar's
 * own, rather than a scroll inside a scroll.
 *
 * It draws as a row of the same grid the editable axes use, because it is the
 * same kind of fact: a label, and the notes under it. What it does not get is
 * an add control, because the edit lives on the other note — which the `ƒ` says.
 */
function InboundRow({
  axis,
  axisKey,
  label,
  means,
  notes,
  onOpen,
}: {
  /** The axis this inverts, so `g⇧⟨key⟩` can find the row. */
  axis: string;
  /** That axis's declared letter, if it has one, for the hint. */
  axisKey: string | undefined;
  label: string;
  means: string;
  notes: { id: string; title: string; done?: boolean; isProject: boolean; refCount: number }[];
  onOpen: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (!notes.length) return null;
  const shown = all ? notes : notes.slice(0, INBOUND_CUTOFF);

  return (
    <div
      className="facetrow is-computed"
      data-navlist="axis"
      /* `.reflink` is `width: 100%`, so these stack rather than wrap: `j`/`k`. */
      data-nav-flow="column"
      data-axis={axis}
      data-inverse=""
      title={means}
    >
      <span className="facetrow-label">
        {label}
        {/*
          No `ƒ` here any more.

          It marks an axis computed rather than stored, and on a row headed
          `Children` beside one headed `Part of` that is a fact the reader already
          has — a note does not choose what names it. The mark is still earning its
          place in the filter rail and on the workshop's inherited rows, where the
          same value could plausibly have been stored. The sentence it carried is
          now the row's `title`.
        */}
        {axisKey && (
          <KeyHint
            keys={axisKey.toUpperCase()}
            means={`g then shift-${axisKey.toUpperCase()} — the notes naming this one`}
          />
        )}
        {/* How many there are, at the label column's inner edge — the position the
            rail already uses for a count, and the one place on this row that is
            not part of the row's contents. It was inside `.facetrow-values`, which
            wraps, and a `.reflink` is `width: 100%` — so it took a line of its own
            under the whole list. */}
        {notes.length > 1 && <span className="quietcount facetrow-count">{notes.length}</span>}
      </span>
      <div className="facetrow-values">
        {/* Finished says `ok`; unfinished says nothing. Only a note in *your*
            way earns `bad`, which is what the outbound `blocked by` row draws —
            a note at this end is one you are holding up, and striping six of
            them red says a project with work left in it is broken. */}
        {shown.map((r) => (
          <button
            className={`reflink ${r.done ? 'is-done' : ''}`}
            data-nav="ref"
            key={r.id}
            onClick={() => onOpen(r.id)}
          >
            {/* A note carries its mark wherever you meet it. The `' ✓'` that
                used to sit here is gone: `.reflink.is-done` already draws that
                state as an `ok` left edge, so the tick was the same fact twice. */}
            <RecordMark card={r} />
            {r.title}
          </button>
        ))}
        {notes.length > INBOUND_CUTOFF && (
          <button className="facet-more" data-nav-more="" onClick={() => setAll((v) => !v)}>
            {all ? 'less' : `${notes.length - INBOUND_CUTOFF} more`}
          </button>
        )}

      </div>
    </div>
  );
}

/**
 * Every axis that is a property, drawn the same way.
 *
 * The reference facets are not here — they moved to `Refs` below, with the two
 * derived lists that are their other ends. That split is by `type`, not by name,
 * so it is the vocabulary's own answer to which axes point at notes; and what
 * it leaves behind is homogeneous, which is what lets this be a grid at all.
 * A row of wrapping chips and a row holding a note picker do not share a
 * baseline.
 */
export function Facets({
  defs,
  values,
  write,
  lit = nothingLit,
}: {
  defs: Meta['facets'];
  values: NoteDTO['facets'];
  write: Pick<NoteWriter, 'facet'>;
  lit?: Lit;
}) {
  const props = Object.keys(defs).filter((n) => defs[n]!.type !== 'ref');
  const { show, hidden, reveal } = useRevealed(props, (n) => (values[n] ?? []).length > 0);

  // No head. The rail names no such group either, and this is the first thing
  // under the title — a label reading FACETS above a list of facet labels was
  // the section restating its own contents.
  return (
    <section className="panel-section">
      <div className="facetgrid">
        {props
          .filter((n) => show(n))
          .map((name) => (
            <FacetEditor
              key={name}
              name={name}
              lit={lit(name)}
              def={defs[name]!}
              values={values[name] ?? []}
              // One axis, named, and the editor says whether it replaced the axis
              // or named a delta on it. Neither the map nor — for a toggle — the
              // axis's other values are asserted, so nothing an agent changed
              // between this render and the click is reverted by it.
              onChange={(next, mode) => write.facet(name, next, mode)}
            />
          ))}
      </div>
      <AddAxis
        label="+ facet"
        title="a property this note carries nothing on"
        hidden={hidden}
        defs={defs}
        onPick={reveal}
      />
    </section>
  );
}

/**
 * Every axis that points at a note, and every note that points back.
 *
 * One section, because `parent`, `project` and `blocks` are one kind of thing —
 * reference facets — and because the two ends of a relation belong next to each
 * other. `Blocks` and `Blocked by` were two names two letters apart with five
 * hundred pixels of body and links between them, one editable and one derived,
 * and nothing on either saying it was looking at the same edge from the other
 * side. They are now adjacent rows, and the `ƒ` is the whole of the difference.
 */
export function Refs({
  defs,
  card,
  data,
  write,
  onOpen,
  lit = nothingLit,
}: {
  defs: Meta['facets'];
  card: NoteDTO;
  data: NoteDetail;
  write: Pick<NoteWriter, 'facet'>;
  onOpen: (id: string) => void;
  lit?: Lit;
}) {
  const rels = Object.keys(defs).filter((n) => defs[n]!.type === 'ref');
  const { show, hidden, reveal } = useRevealed(rels, (n) => (card.facets[n] ?? []).length > 0);

  return (
    <section className="panel-section">
      <div className="facetgrid">
        {rels.flatMap((name) => {
          const def = defs[name]!;
          const naming = data.inbound[name] ?? [];
          return [
            show(name) ? (
              <FacetEditor
                key={name}
                name={name}
                lit={lit(name)}
                def={def}
                values={card.facets[name] ?? []}
                refs={data.refs}
                selfId={card.id}
                onOpen={onOpen}
                onChange={(next, mode) => write.facet(name, next, mode)}
              />
            ) : null,
            // The other end, when this vault gave it a word. Directly under the
            // relation it inverts, because the two ends of one edge belong
            // beside each other — that adjacency is the whole of the difference
            // between `Blocks` and `blocked by`, and the `ƒ` says which is which.
            def.inverse && naming.length ? (
              <InboundRow
                key={`${name}:inverse`}
                axis={name}
                axisKey={def.key}
                label={def.inverse}
                means={`notes naming this one through "${def.label}", not stored on this one`}
                notes={naming}
                onOpen={onOpen}
              />
            ) : null,
          ];
        })}
      </div>
      <AddAxis
        label="+ ref"
        title="a reference this note names nothing on"
        hidden={hidden}
        defs={defs}
        onPick={reveal}
      />
    </section>
  );
}

export function Links({
  card,
  write,
  lit = false,
}: {
  card: NoteDTO;
  write: Pick<NoteWriter, 'links'>;
  lit?: boolean;
}) {
  const { refresh } = useEnrichment();
  useRequestEnrichment(card.links.map((l) => l.raw));

  return (
    <section className={`panel-section ${lit ? 'is-touched' : ''}`} data-navlist="links">
      <h3>
        Links
        <KeyHint keys="l" means="g then l — step the links with j and k" />
        {/* An action, so it is a button — and a glyph, not a word. "refresh"
            beside a trash can and a `✕` is the same mistake as spelling those
            two, so the set grew by one measured member rather than the rule
            keeping an exception. */}
        <span className="section-do">
          <IconButton
            glyph="refresh"
            title="Re-fetch every link on this note"
            aria-label="Re-fetch every link on this note"
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
  children,
}: {
  cardId: string;
  yaml: string;
  write: Pick<NoteWriter, 'frontmatter'>;
  onDirtyChange: (dirty: boolean) => void;
  /**
   * The readout this control sits above — the file, when it changed, and what the
   * note inherits. It is the caller's markup because it owns no state, no write
   * and no load; this block is a module only because it owns the open flag and
   * the dirty guard.
   */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const report = (d: boolean) => {
    setDirty(d);
    onDirtyChange(d);
  };
  return (
    <section className="panel-section" data-section="frontmatter">
      <h3>
        Frontmatter
        <KeyHint keys="y" means="g then y — edit the raw frontmatter; esc leaves it" />
        {/* The same control as the Body's, doing the same thing: reveal an editor
            over a readout. It was `edit raw` / `hide` — a word that changed to a
            different word — while the Body used two pills, so one act had two
            grammars a screen apart. One toggle, one glyph, one pressed state. */}
        <span className="section-do">
          <IconButton
            glyph="edit"
            on={open}
            title={open ? 'Stop editing the raw frontmatter' : 'Edit the raw frontmatter'}
            aria-label={open ? 'Stop editing the raw frontmatter' : 'Edit the raw frontmatter'}
            onClick={() => {
              if (open && !mayClose(dirty, 'frontmatter')) return;
              setOpen((v) => !v);
            }}
          />
        </span>
      </h3>
      {children}
      {/* No fetch. The yaml arrives with the note, from the same read as its
          mtime, so there is no second copy of this file to go stale — which is
          what used to make saving here revert whatever the chips had just done. */}
      {open && (
        <FrontmatterEditor
          cardId={cardId}
          yaml={yaml}
          onSave={write.frontmatter}
          onDirtyChange={report}
          onEscape={() => mayClose(dirty, 'frontmatter') && setOpen(false)}
        />
      )}
    </section>
  );
}

export function Body({
  card,
  write,
  onDirtyChange,
  lit = false,
}: {
  card: NoteDTO;
  write: Pick<NoteWriter, 'body'>;
  onDirtyChange: (dirty: boolean) => void;
  lit?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const report = (d: boolean) => {
    setDirty(d);
    onDirtyChange(d);
  };
  return (
    <section className={`panel-section ${lit ? 'is-touched' : ''}`} data-section="body">
      <h3>
        Body
        <KeyHint keys="c" means="g then c — edit the body; esc leaves it" />
        {/*
          One button, not two pills.

          `read` and `edit` were a two-member mode switch, and the only `.tab`
          left in the app — a shape that said "you are in this mode" where the
          Frontmatter's word said "do a thing", for the same act. The guard stays
          asymmetric on purpose: only the closing direction destroys a document.
        */}
        <span className="section-do">
          <IconButton
            glyph="edit"
            on={editing}
            title={editing ? 'Stop editing the body' : 'Edit the body'}
            aria-label={editing ? 'Stop editing the body' : 'Edit the body'}
            onClick={() => {
              if (editing && !mayClose(dirty, 'body')) return;
              setEditing((v) => !v);
            }}
          />
        </span>
      </h3>
      {editing ? (
        <BodyEditor
          // Escape closes the editor, through the same guard the toggle uses: the
          // key and the button are one act, so they ask the same question.
          onEscape={() => mayClose(dirty, 'body') && setEditing(false)}
          cardId={card.id}
          value={card.body}
          onDirtyChange={report}
          // `write.body` rejects on failure, which is the contract this editor
          // has always assumed. It used to be handed a function that caught
          // everything and resolved, so a refused save reported "saved", cleared
          // the dirty flag, and let the next refetch replace the typed text.
          onSave={write.body}
        />
      ) : card.body.trim() ? (
        <div className="md" dangerouslySetInnerHTML={{ __html: renderBody(card.body, card.title) }} />
      ) : (
        <p className="emptystate hint">Empty. Switch to edit to write something.</p>
      )}
    </section>
  );
}
