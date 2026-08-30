import { useEnrichment } from '../enrichment.tsx';
import { useTouched } from '../touched.tsx';
import { plural } from '../plural.ts';
import { useIsPinned, useTogglePin } from '../pinned.tsx';
import { useHue } from '../vocabulary.tsx';
import { LINK_KINDS, linkHue } from '../links.ts';
import type { NoteDTO } from '../types.ts';

/**
 * The one card component, rendered at two sizes inside a board column, a canvas
 * node and a table row. Every shape gets an identical card face because there is
 * only one implementation of a card face.
 *
 * It renders and nothing else: content is edited in the `?note=` panel, structure
 * by gesture (C10). There is no third `expanded` size — the panel is that, with
 * a deep link and the real editors.
 */

/**
 * Which hue family an axis draws in — one entry per axis, seven hued and two
 * deliberately not (`source` and `energy` are hints, and The Hints Are Hueless
 * Rule says a hint gets no family rather than a diluted one).
 *
 * Exported because the panel's toggle chips read it too. A second copy is the
 * exact drift that would let the same axis be orange on a card face and green in
 * the editor, and the axis is the only thing either of them knows.
 */

/**
 * One facet value on a face.
 *
 * An ordered facet draws its **bucket** rather than its value: a chip saying
 * `2026-09-01` tells you nothing a chip saying `overdue` does not, and the
 * bucket is also what picks the colour, so a deadline can be loud on an axis
 * that is otherwise quiet.
 *
 * The hue comes from the vocabulary, so nothing here knows any facet by name.
 * It used to come from a map of nine facet names, with everything else falling
 * to grey — which meant a vault's own axes could not have a colour and a renamed
 * one lost it silently.
 */
/**
 * A note's values on one axis, wherever they live.
 *
 * A face does not care whether an axis is stored or computed — `show` names an
 * axis and the face draws what it says — but the payload has to keep the two
 * apart (see `NoteDTO.computed`), so exactly one place joins them and this is it.
 * Every surface that draws `show` goes through here: a card face, a table cell.
 *
 * Stored wins a tie. Nothing can currently produce one — `RESERVED` stops a vault
 * naming a facet after a computed axis — but if that check is ever relaxed, the
 * file on disk is the answer that a person can see and edit.
 */
export function axisValues(card: NoteDTO, facet: string): string[] {
  return card.facets[facet] ?? card.computed[facet] ?? [];
}

export function FacetChip({
  facet,
  value,
  bucket,
}: {
  facet: string;
  value: string;
  bucket?: string;
}) {
  return <span className={`chip ${useHue(facet, bucket)}`}>{value}</span>;
}

/**
 * A link chip, enriched when the server has something for it.
 *
 * Falls back to the parsed label the instant it has nothing — which is what
 * every chip looked like before P3, so an unconfigured or failing fetcher costs
 * nothing but the richness.
 */
function LinkChip({ kind, linkRef, label }: { kind: string; linkRef: string; label: string }) {
  const { get } = useEnrichment();
  const res = get(linkRef);
  const d = res?.data;

  const shown = d?.label ?? label;
  const tip = [
    `${kind}: ${linkRef}`,
    d?.title,
    ...(d?.fields ?? []).map((f) => `${f.k}: ${f.v}`),
    res?.error,
    res?.reason,
  ]
    .filter(Boolean)
    .join('\n');

  const state =
    res?.state === 'error' ? 'is-failed' : res?.state === 'stale' ? 'is-stale' : d ? 'is-live' : '';

  return (
    <span className={`linkchip ${state}`} title={tip}>
      <b style={linkHue(kind)}>{LINK_KINDS[kind]?.glyph ?? '?'}</b>
      <span className="truncate linkchip-label">{shown}</span>
      {d?.badges?.slice(0, 1).map((b) => (
        <em key={b.label} className={`tone-${b.tone}`}>
          {b.label}
        </em>
      ))}
    </span>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className="progress" title={`${done} of ${total} done`}>
      <span className="progress-track">
        <span className="progress-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="progress-num">
        {done}/{total}
      </span>
    </span>
  );
}

export function CardBody({
  card,
  showFacets,
  onOpen,
}: {
  card: NoteDTO;
  /** Which facets render as chips on the face — the view's `chips`. */
  showFacets: string[];
  onOpen?: (id: string) => void;
}) {
  const { touched } = useTouched();
  const isPinned = useIsPinned();
  const pin = useTogglePin();
  const pinned = isPinned(card.id);
  const blocked = card.blockedBy.filter((b) => !b.done);
  const facetKeys = showFacets.filter((f) => axisValues(card, f).length);

  return (
    <div
      // `is-touched` is the app's one animation, and it is here rather than on a
      // wrapper because a board tile, a canvas node and a table cell all render
      // this face — one mark, three shapes, no shape knowing about it.
      className={`${cls(card, 'cardface')} ${touched(card.id) ? 'is-touched' : ''}`}
      onDoubleClick={() => onOpen?.(card.id)}
    >
      <div className="cardface-head">
        <PinMark card={card} title={card.title} pinned={pinned} onToggle={() => pin(card.id)} />
        <span className="cardface-title">{card.title}</span>
      </div>

      {facetKeys.length > 0 && (
        <div className="chiprow">
          {facetKeys.map((f) =>
            axisValues(card, f).map((v, i) => (
              <FacetChip key={`${f}:${v}`} facet={f} value={v} bucket={card.buckets[f]?.[i]} />
            )),
          )}
        </div>
      )}

      {(card.progress || blocked.length > 0 || card.links.length > 0) && (
        <div className="cardface-meta">
          {card.progress && <Progress {...card.progress} />}
          {blocked.length > 0 && (
            <span className="blocked" title={blocked.map((b) => b.title).join('\n')}>
              blocked by {blocked.length}
            </span>
          )}
          {card.unblocks.length > 0 && (
            <span className="unblocks" title={card.unblocks.join('\n')}>
              unblocks {card.unblocks.length}
            </span>
          )}
        </div>
      )}

      {card.links.length > 0 && (
        <div className="chiprow">
          {card.links.slice(0, 3).map((l, i) => (
            <LinkChip key={i} kind={l.kind} linkRef={l.raw} label={l.label} />
          ))}
          {card.links.length > 3 && <span className="chip facet-muted">+{card.links.length - 3}</span>}
        </div>
      )}

      {card.excerpt && !card.progress && <p className="cardface-excerpt one-line">{card.excerpt}</p>}
    </div>
  );
}

/**
 * What a note is, in one glyph — read off the note rather than declared on
 * it. `▣` owns config its members inherit; `○` something else names it; `•`
 * nothing does.
 *
 * There used to be a stored `kind` saying "card" or "node". It asserted what
 * these two counts already show, and it was never structural: what kept a
 * grouping note off a board was the status filter, not the kind. C11 — nothing
 * derivable is also stored.
 */
export function markOf(card: Marked): { role: Role; isProject: boolean; referenced: boolean; means: string } {
  // One sentence for the count, so the project and container branches cannot
  // drift: a table draws the number for any note with references, projects
  // included, and the face carries the same fact only in this tooltip.
  const references =
    card.refCount === 1
      ? '1 note references this one.'
      : `${plural(card.refCount, 'note')} reference this one.`;
  const bits = { isProject: card.isProject, referenced: card.refCount > 0 };
  if (card.isProject) {
    return {
      ...bits,
      role: 'project',
      means:
        'A project: other notes inherit its repos and instructions.' +
        (card.refCount > 0 ? ` ${references}` : ''),
    };
  }
  if (card.refCount > 0) {
    return { ...bits, role: 'container', means: references };
  }
  return { ...bits, role: 'leaf', means: 'Nothing references this one.' };
}

/** The three roles a mark can name, in the order they nest. */
export const ROLES = ['project', 'container', 'leaf'] as const;

export type Role = (typeof ROLES)[number];

/**
 * The mark, drawn — and the only place it is drawn.
 *
 * It was the characters `▣ ○ •`, chosen from the mono face, and the face is why
 * they had to stop being characters. Two problems, one cause:
 *
 * **They would not compose.** Measured at 15px, `•`'s ink was 4.35px across
 * against `○`'s 8.94 — half the diameter and a quarter of the area, so the note
 * every vault has most of drew as a speck beside its two siblings. `•` was
 * already a repair (`·` was 1.85px, worse), which is as far as picking a
 * character can get you: the ladder is whoever cut the font's, not ours.
 *
 * **Nothing could be added to them.** A character is an advance width with ink
 * somewhere inside it, and the ink's position is a measurement — which is what
 * the three `translateY` nudges in `.recordmark` were. There was no way to put a
 * second thing *on* a mark, so pinned-ness had to be drawn around it or beside
 * it, and both failed for reasons DESIGN.md's Pin Rule records.
 *
 * ## Two facts, two channels
 *
 *   **fill**  — solid is a **project**: it owns repos and instructions its
 *               members inherit. Hollow is not.
 *   **shape** — square means **something names it**, through any reference
 *               facet. A circle is self-contained; a square has corners for
 *               edges to arrive at.
 *
 * All four combinations are drawn and all four mean something, at one 4.4
 * half-width so the eye compares them on the two things that carry meaning
 * rather than on how big they are.
 *
 * ## Why fill carries the project and not the other way round
 *
 * The obvious assignment is the opposite — shape is the nominal channel, so put
 * the *kind* of thing on it — and it is wrong here, for three reasons that only
 * showed up once a realistic screen was drawn both ways.
 *
 * **A project would have had two glyphs.** With shape on `isProject` and fill on
 * references, a project nothing happens to name is a hollow square and one with
 * members is a solid square: the same kind of thing, drawn two ways, and which
 * you get decided by a fact about *other* notes. Fill on `isProject` means every
 * project is solid, always, and its identity cannot be diluted by churn.
 *
 * **Pop-out has to be precise.** At this size fill separates preattentively and
 * a circle against a rounded square does not. Measured on the author's vault:
 * 11% of notes are projects, 23% are referenced. Spending fill on references
 * makes a quarter of the screen solid to mark a fact that is true of a quarter
 * of the screen — the cue is ~43% precise for "this is a project", which is the
 * thing a reader actually scans for. Spending it on projects makes it exact.
 *
 * **Salience should track consequence.** A reference appears and disappears as
 * links are made and broken, and nobody decided it about *this* note. Being a
 * project is an act that moves the file into a folder of its own. The fact you
 * chose belongs on the channel that shows, and the fact that happens to you
 * belongs on the one that whispers. Or: **fill is what you decided, shape is
 * what happened around it.**
 *
 * **Why not a third shape.** A triangle, a diamond or a hexagon at 10px with a
 * 1.5px stroke is mush, and its meaning is not derivable — round and square are
 * the two silhouettes that survive this size and are maximally unlike each
 * other. Two channels already answer both questions; a third shape would spend a
 * scarce, size-fragile resource on a distinction that has an answer.
 */

/** Solid means project. The heavier form is inset — solid weighs more than outline. */
const CIRCLE = { on: <circle cx="8" cy="8" r="4" stroke="none" />,
                 off: <circle cx="8" cy="8" r="3.65" fill="none" strokeWidth="1.5" /> };

/**
 * The square is a squircle on purpose, and the hollow one especially.
 *
 * `rx` 1.7 hollow against 1.2 solid: an empty rounded rectangle at this size is
 * the universal unchecked checkbox, and on a work app full of task lists that is
 * a reading nobody wants. Rounder is further from a checkbox and still plainly
 * not a circle. It applies to 13% of notes, which is the second commonest state.
 */
const SQUARE = { on: <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" stroke="none" />,
                 off: <rect x="4.35" y="4.35" width="7.3" height="7.3" rx="1.7" fill="none" strokeWidth="1.5" /> };

/**
 * The box: the marks' own 16 units, plus seven above and seven to the right.
 *
 * The tack needs that room and there is nothing else up there — the mark sits at
 * the head of a title, so the space above it and before the text is empty by
 * construction. A unit stays `1em/16`, so the silhouettes are drawn at exactly
 * the size they were and only the canvas grew; `.markglyph` in the stylesheet
 * pulls the two extra edges back out of the layout, so no title moves.
 */
const MARK_VIEW = '0 -7 23 23';

/**
 * And the box when there is no tack: the marks' own 16 units and nothing spare.
 *
 * Both boxes draw a unit at `1em/16` — see `.markglyph` — so the silhouette is
 * the same size either way and only the canvas around it changes. That is what
 * lets a mark be dropped somewhere with no room to overhang, like the collapsed
 * rail's 38px ribbon, and still be the same drawing at the same scale.
 */
const TIGHT_VIEW = '0 0 16 16';

const TACK = 'translate(14.93 1.07) rotate(45) scale(1.2) translate(-8 -8)';

/** Head and needle, exactly as the retired `pin` button glyph drew them. */
const TACK_HEAD = 'M5.1 2.5H10.9L10.2 6.3L12.2 8.5H3.8L5.8 6.3Z';
const TACK_PIN = 'M8 8.5V13.5';

/**
 * The whole thumbtack, upright — for a count of the pinned *set*.
 *
 * The ribbon's pin row is about a set and has no one note to draw a silhouette
 * for, so it draws the tack alone. Upright and at full size rather than the
 * angled fragment a mark carries, because nothing is holding it: on a mark the
 * angle and the depth say *pushed into this*, and there is nothing here to push
 * it into.
 *
 * The same two paths, so there is no second pin drawing to keep in step with the
 * first — which is the whole reason the mark's tack was built from the retired
 * button glyph rather than redrawn.
 */
export function PinIcon() {
  return (
    <svg className="pinicon" viewBox="0 0 16 16" stroke="currentColor" fill="currentColor" aria-hidden="true">
      <path d={TACK_HEAD} stroke="none" />
      <path d={TACK_PIN} strokeWidth="1.55" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/**
 * The four states a mark can be in, in the order a note passes through them.
 *
 * The ribbon counts these rather than the three `Role`s, and the order is the
 * lifecycle: a note arrives naming nothing and named by nothing, something comes
 * to depend on it, and it may grow into a project — so reading the column top to
 * bottom is reading how far along a vault's notes are.
 *
 * `Role` survives because `markOf` still answers "what is this, in a word" for a
 * tooltip, and because three roles is what a *sentence* about a note wants. Four
 * states is what a *count* wants, and they are the same two bits either way.
 */
export const MARK_STATES = [
  { isProject: false, referenced: false, noun: 'note', names: 'nothing names' },
  { isProject: false, referenced: true, noun: 'note', names: 'something names' },
  { isProject: true, referenced: false, noun: 'project', names: 'nothing names' },
  { isProject: true, referenced: true, noun: 'project', names: 'something names' },
] as const;

export type MarkState = (typeof MARK_STATES)[number];

/**
 * What one row of the tally says, in words — for a readout that counts states
 * rather than describing a single note, which is what `markOf`'s `means` is for.
 *
 * Through `plural` because the app has one way of making a count and its noun
 * agree, and "1 notes something names" is what not using it reads like.
 */
export function stateMeans(state: MarkState, n: number): string {
  return `${plural(n, state.noun)} ${state.names}`;
}

/**
 * Tally a set of notes by the mark each one draws.
 *
 * This exists because the collapsed rail was answering the same question from a
 * different source. It read the `type` computed axis, whose `node` value means
 * "named by **any** reference facet", while the mark was drawn from a count of the
 * `parent` facet alone — so the two disagreed on every note named only through
 * `blocks` or `project`. Measured on the 27-note fixture, the rail reported
 * 3 / 4 / 20 beside its glyphs while the app drew 3 / 1 / 23: a ribbon saying
 * "4 linked nodes" next to the single ring on screen.
 *
 * Both halves moved. The square now means what `type` always meant — named by any
 * reference facet — and the ribbon counts through `markOf` rather than reading a
 * facet. So the marks, their tally and the `type` axis are one mechanism rather
 * than three that have to agree (PRODUCT.md), and the rail names no facet, which
 * the old version did three times over (C4).
 */
export function tallyMarks(cards: Marked[]): number[] {
  const out = MARK_STATES.map(() => 0);
  for (const card of cards) {
    const { isProject, referenced } = markOf(card);
    out[MARK_STATES.findIndex((s) => s.isProject === isProject && s.referenced === referenced)]!++;
  }
  return out;
}

/**
 * The two facts a mark is read from.
 *
 * Narrower than `NoteDTO` on purpose: a reference facet resolves to a title and
 * these two, not to a whole note, and the panel drawing its own two-way
 * `isProject ? ▣ : ·` was how `○` went missing from every reference — a note
 * you are looking at *because* something names it is referenced by definition, so
 * the one mark that should have been commonest never appeared at all.
 */
export interface Marked {
  isProject: boolean;
  refCount: number;
}

/**
 * One mark, drawn — with the tack, or with room for it.
 *
 * The tack is always in the markup and its paint is the only thing that changes,
 * which is what lets an unpinned mark answer a hover by *showing* what a click
 * would do without the box under it moving by a pixel. Two colours, two facts:
 * the silhouette stays `accent` because it says what the note is, and the tack
 * is `--pinned` because it says you are holding it. Neither borrows the other's.
 */
export function MarkGlyph({
  isProject,
  referenced,
  pinned,
}: {
  /** Solid. */
  isProject: boolean;
  /** Square. */
  referenced: boolean;
  pinned: boolean;
}) {
  const shape = referenced ? SQUARE : CIRCLE;
  return (
    <svg
      className={`markglyph ${pinned ? 'is-pinned' : ''}`}
      viewBox={pinned ? MARK_VIEW : TIGHT_VIEW}
      stroke="currentColor"
      fill="currentColor"
      aria-hidden="true"
    >
      {isProject ? shape.on : shape.off}
      {/*
        Drawn last, so it sits on the mark rather than under it — the point has
        to disappear *into* the silhouette for the thing to read as pushed in.
      */}
      <g className="markglyph-tack" transform={TACK}>
        <path d={TACK_HEAD} stroke="none" />
        <path d={TACK_PIN} strokeWidth="1.3" strokeLinecap="round" fill="none" />
      </g>
    </svg>
  );
}

/**
 * The mark on a surface that only reads: a panel head's sibling, a reference
 * row, a picker. It says what the note is and whether it is held, and does not
 * offer to change either.
 */
export function RecordMark({ card, pinned = false }: { card: Marked; pinned?: boolean }) {
  // The role is still a class: the glyph is drawn, but its optical nudge and the
  // family it belongs to are things the stylesheet says — see `.recordmark`.
  const { role, isProject, referenced, means } = markOf(card);
  return (
    <span className={`recordmark is-${role}`} title={pinned ? `${means}\nPinned.` : means}>
      <MarkGlyph isProject={isProject} referenced={referenced} pinned={pinned} />
    </span>
  );
}

/**
 * The mark, as the control that releases the pin it is drawing.
 *
 * The pin used to be a second button at the trailing edge of the title, and the
 * trailing edge is where a card's *acts* live — so the one fact that is not an
 * act sat among them, drawn as a filled key that was the loudest thing on a
 * quiet face. Now the fact is on the mark and the mark is the control, which
 * removes the second element rather than moving it.
 *
 * Clicking an unpinned mark pins it, which is new and was overdue: the pin was
 * previously reachable by `'`, and by the palette, which itself opens only on a
 * key — so a reader working entirely by pointer could unpin and could never pin.
 *
 * The hit area is grown by a pseudo-element rather than by padding (see
 * `.recordmark.is-pin::after`): the mark is ~10px, which is not a target, and
 * padding on a baseline-aligned flex item moves the title beside it.
 */
export function PinMark({ card, title, pinned, onToggle }: {
  card: Marked;
  title: string;
  pinned: boolean;
  onToggle: () => void;
}) {
  const { role, isProject, referenced, means } = markOf(card);
  return (
    <button
      type="button"
      className={`recordmark is-${role} is-pin`}
      data-act="pin"
      aria-pressed={pinned}
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${title}`}
      title={`${means}\nClick: ${pinned ? 'let this pin go' : 'pin it, so it stays in sight'} (')`}
      // A card face is itself clickable, and on a canvas it is draggable. Both
      // gestures start here and neither may be started by this.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <MarkGlyph isProject={isProject} referenced={referenced} pinned={pinned} />
    </button>
  );
}

/**
 * The mark, as the control that changes what it says.
 *
 * A note *is* a project by carrying a `project:` block, and the mark is the one
 * place the app already states that. So the toggle is the mark: there is no
 * separate button whose label has to restate the glyph beside it, and no chance
 * of the two disagreeing. Clicking `·` or `○` adds the block; clicking `▣`
 * removes it, and the note falls back to whichever of the two it earns from its
 * child count.
 */
export function ProjectMark({ card, pinned = false, onToggle }: {
  card: Marked;
  pinned?: boolean;
  onToggle: () => void;
}) {
  const { role, isProject, referenced, means } = markOf(card);
  // What it is, then what a click makes it. Two facts, one line each, and the
  // second names the consequence rather than the mechanism — "members stop
  // inheriting" is what actually happens to other notes; "removes the project
  // block" is how.
  const next = card.isProject
    ? 'Click: stop being a project — its members stop inheriting these repos and instructions'
    : 'Click: make it a project — it moves into a folder of its own, where it can own repos ' +
      'and an AGENTS.md its members inherit';
  return (
    <button
      className={`recordmark is-${role} is-toggle`}
      // Drawn only by the panel, which is the one place this is a control rather
      // than a glyph — so the address can live on the component.
      data-act="project"
      title={`${means}${pinned ? '\nPinned.' : ''}\n${next}`}
      onClick={(e) => {
        // The title beside it opens the rename editor on click.
        e.stopPropagation();
        onToggle();
      }}
    >
      {/*
        It draws the tack like every other mark — the panel had no way at all to
        say the note you are reading is pinned, which is the one surface where
        you are most likely to want to know. It stays the *project* control here
        rather than the pin one: this is the only mark that was already spoken
        for, and a glyph that meant two different acts on two surfaces would be
        worse than the asymmetry.
      */}
      <MarkGlyph isProject={isProject} referenced={referenced} pinned={pinned} />
    </button>
  );
}

/**
 * A face says one thing about itself in its shape: whether it is stuck.
 *
 * It used to say two — a project took a `hue-purple` left edge beside the blocked
 * card's `bad` one. That edge was the note mark's job stated twice, and the mark
 * states it in every place a note appears rather than only on a face. So every
 * card is now the same rectangle until something blocks it.
 */
function cls(card: NoteDTO, base: string): string {
  return [base, card.blockedBy.some((b) => !b.done) ? 'is-blocked' : '']
    .filter(Boolean)
    .join(' ');
}
