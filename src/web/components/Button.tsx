import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The two kinds of button, so a caller stops assembling class strings.
 *
 * There were 29 call sites spelling 14 distinct combinations, and the same close
 * button written two ways — `btn ghost tiny icon-button icon-close` in three
 * places and `btn ghost panel-x icon-button icon-close` in a fourth. Changing how
 * a button looks meant editing the stylesheet and every caller, which is what six
 * consecutive commits adjusting the sidebar controls were doing.
 *
 * The classes are still the implementation; they are just no longer the interface.
 */

type Base = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>;

export type Tone = 'default' | 'primary' | 'ghost' | 'danger';
export type Size = 'normal' | 'small' | 'tiny';

const TONE: Record<Tone, string> = {
  default: '',
  primary: 'primary',
  ghost: 'ghost',
  danger: 'danger',
};

const SIZE: Record<Size, string> = { normal: '', small: 'small', tiny: 'tiny' };

const cls = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

export function Button({
  tone = 'default',
  size = 'normal',
  extra,
  children,
  ...rest
}: Base & { tone?: Tone; size?: Size; extra?: string; children: ReactNode }) {
  return (
    <button className={cls('btn', TONE[tone], SIZE[size], extra)} {...rest}>
      {children}
    </button>
  );
}

/**
 * A button whose label is a glyph.
 *
 * The glyph set is closed, which is what lets the optical sizing live here. These
 * marks have markedly different ink areas at one nominal size, so the hit targets
 * stay equal and only the mark is tuned — it was four `!important` declarations in
 * the stylesheet, one per glyph, reachable only by knowing the class name.
 */
const GLYPH = {
  close: { mark: '✕', px: 15 },
  add: { mark: '+', px: 17 },
  check: { mark: '✓', px: 14 },
  revert: { mark: '↶', px: 16, nudge: '-0.02em' },
  /**
   * The one glyph that is a drawing rather than a character.
   *
   * There is no monochrome trash can in a text font: `🗑` is emoji-presentation
   * and would be the only colour ink in an app whose every value comes from one
   * palette file. So this row carries a path instead of a mark, drawn in
   * `currentColor` at the same nominal size the characters use — the table is
   * still the one place a glyph's metrics live.
   */
  trash: {
    px: 15,
    path: 'M2.6 4h10.8M6 4V2.6h4V4M4.1 4l.75 9.4h6.3L11.9 4M6.6 6.6v4.7M9.4 6.6v4.7',
  },
  /**
   * The second drawing, and the reason the set was closed for a while.
   *
   * `refresh` was a word because nobody had looked for a mark, not because none
   * was possible. Four candidate characters — `⟳` `⟲` `⥁` `⭮` — sit on advances
   * of 0.68 / 0.68 / 0.56 / 0.60em against this family's 0.6021em, so each is
   * being served by a substituted face and would draw differently on another
   * machine. `↺` and `↷` are exact mirrors of `↶` above, which is the one glyph
   * refresh must not be confused with. That leaves `↻`, which is on the family's
   * own advance and at 14px matches `✕` for ink (28.8 against 29.7 lit px, both
   * in an 8×8 box) — but on the pixel grid its arrowhead survives as about two
   * pixels, so it reads as a broken ring and collides with `○`, the container
   * note mark.
   *
   * So: 270° of arc at r5 with the gap in the north-east quadrant, and the
   * arrowhead *filled*. A stroked chevron was tried first — 1.2 units renders
   * ~1.1px here, too thin to read as an arrow at all.
   *
   * 15px because two measurements agree on it. The ink box is 11×12, identical
   * to `trash` above, so the two drawn glyphs are the same size as each other;
   * and coverage is 30.1 lit px, which sits with `✕` (29.7) and `+` (31.6), so
   * it reads at the characters' weight. `trash` is 52.8 on the same box because
   * it destroys, and that difference is the point.
   *
   * No nudge: a path is centred by `.icon-button`'s grid, so the Measured Glyph
   * Rule's baseline formula — which is about a glyph in a text run — does not
   * apply to it, any more than it does to `trash`.
   */
  refresh: {
    px: 15,
    path: 'M13 8A5 5 0 1 1 8 3',
    fill: 'M7.6 1.1L11.5 3 7.6 4.9Z',
  },
  /**
   * The third drawing, and the one that let two controls become one.
   *
   * `read`/`edit` was a two-button mode switch and `edit raw`/`hide` was a
   * one-button label swap, for the same act: reveal an editor over a readout.
   * Both are now this glyph with a pressed state, which is why it is a toggle
   * rather than an action — see `on` on `IconButton`.
   *
   * No character was available on the same terms the other two were rejected on.
   * `✎` `✏` `🖉` `🖊` sit on advances of 0.72 / 0.80 / 0.60 / 0.60em against this
   * family's 0.6021em, and the two that match are Miscellaneous-Symbols
   * codepoints with no coverage in any face this stack resolves to — they render
   * as tofu on a machine without a fallback emoji font, and as *colour* emoji on
   * one with it, which is the same objection that ruled out `🗑`.
   *
   * So: a parallelogram body on the 45° axis the two existing drawings avoid —
   * `trash` is orthogonal and `refresh` is circular, so a diagonal collides with
   * neither at a glance — plus the collar stroke, without which the shape reads
   * as a plain rhombus rather than as a pencil.
   *
   * 15px, matching both existing drawings, because the same two measurements
   * agree again. Rasterised at 15px against its two neighbours on one instrument,
   * so the comparison is the claim and not the absolute numbers: this is an ink
   * box of 10.5×10.5 at 34.7 lit px, against `refresh` at 10.5×11.8 and 33.4 and
   * `trash` at 11.5×11.5 and 57.6. So it reads at `refresh`'s weight — within 4%
   * of its coverage, and identical in width — and nowhere near `trash`'s, which
   * is twice as heavy because it destroys.
   *
   * Three shaft lengths were drawn and measured. A longer one squares the box up
   * (11.0×11.0, then 11.3×11.3) at 36.4 and 37.0 lit px, which buys a tidier
   * bounding box by moving the coverage away from the glyph it must match. The
   * box is not the thing a reader sees; the weight is.
   */
  edit: {
    px: 15,
    path: 'M3 13L4.1 9.7L10.9 2.9L13.1 5.1L6.3 11.9ZM4.1 9.7L6.3 11.9',
  },
  /**
   * The fourth drawing: start work on this note.
   *
   * A play triangle, because the act is *begin* — lay out the worktrees and hand
   * the note to a session — and no other mark for beginning is as unambiguous at
   * 15px. It is also the only one of the four whose meaning a reader already knows
   * before seeing this app.
   *
   * A drawing rather than a character on the grounds the other three established.
   * Four candidates measured on the stack `.icon-button` actually resolves to
   * (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`), by
   * `measureText` at 1000px: `▶` 0.801em, `►` 0.880em, `▸` and `‣` both 0.429em.
   * The family's own advance is 0.604em — `+`, the one character in this table
   * that sits on it — so not one of the four is served by this face, and each
   * would draw differently on another machine. That is the same objection that
   * ruled out `⟳ ⟲ ⥁ ⭮` for `refresh` and `✎ ✏ 🖉 🖊` for `edit`.
   *
   * Stroked, not filled, and that is the weight decision. Rasterised at 15px
   * against its two nearest neighbours on the same instrument: this is an ink box
   * of 9×11 at 30.5 lit px, against `refresh` at 11×12 / 29.3 and `edit` at 11×11
   * / 31.4. So it sits *between* them in coverage and matches `edit`'s height
   * exactly — it reads at their weight, and nowhere near `trash`'s 55.3, which is
   * nearly twice as heavy because it destroys. A filled triangle measured 61 and
   * would have been the heaviest mark in the set for the one act that is purely
   * constructive.
   *
   * 9 wide against their 11 is the one number that does not match, and cannot: a
   * triangle pointing right is narrower than a square-ish mark at equal height.
   * Per `edit`'s own note, the box is not the thing a reader sees; the weight is.
   *
   * The bounding box centres at 8.8 rather than 8 — pushed 0.8 units right of the
   * grid centre on purpose. A right-pointing triangle carries its mass on the
   * base, so a geometrically centred one reads as sitting left.
   */
  start: {
    px: 15,
    path: 'M4.9 2.7L12.7 8L4.9 13.3Z',
  },
  /**
   * An eye with a line through it: what the filter is *not* showing.
   *
   * Drawn without a pupil. At the size this is used — the collapsed rail counts
   * with it at 12px — a lens, a pupil and a slash is three marks inside twelve
   * pixels and the slash already crosses where the pupil would be, so the pupil
   * costs legibility and buys nothing the outline does not already say.
   */
  hidden: {
    px: 15,
    /*
     * A lens at a 2:1 ratio, struck through. Nearer a circle it stops being an
     * eye and becomes `ø` — the first cut was 1.4:1 and read as a slashed circle
     * at every size. And no pupil: at the 12px the collapsed rail counts with,
     * a lens, a pupil and a slash is three marks inside twelve pixels, and the
     * slash already crosses where the pupil would be.
     */
    path: 'M1.9 8Q8 2 14.1 8Q8 14 1.9 8ZM3.4 12.6L12.6 3.4',
    /* Heavier than the shared 1.2, because it is a large thin outline rather
       than a compact one and goes weightless beside the marks without it. */
    sw: 1.5,
  },
  /** Send a pinned page into the trailing open slot. */
  open: {
    px: 15,
    path: 'M2.8 8H12.5M8.7 4.2L12.5 8L8.7 11.8',
  },
  /**
   * The fifth drawing: reshape the view around what this row lists.
   *
   * A bullseye, because the act is *focus* — the query's own word for it — and a
   * target is the one mark a reader already reads as that. No character was
   * considered: `◎` `⊙` `◉` are CJK-and-Miscellaneous-Symbols codepoints, so they
   * fail the test the other four drawings were made to pass before their advances
   * are even worth measuring.
   *
   * **A ring and a dot, not two rings**, and that is the whole of the design
   * decision. Ink here is analytic rather than rasterised — perimeter × the shared
   * 1.2 stroke, plus the area of anything filled, scaled by (15/16)² — a method
   * checked against the two figures this table already publishes: it puts `start`
   * at 31.1 against a measured 30.5 and `refresh` at 31.4 against 29.3–30.1, so it
   * is good to a few per cent, which is all this decision needs.
   *
   * On that model two concentric *rings* cost 41.7 px² at r4.5/r1.8 and 45.7 at
   * r4.8/r2.1 — half again the light band and most of the way to `trash`, for a
   * navigational act. And the inner ring does not survive the shrinking that would
   * fix it: at r1.0 the 1.2 stroke leaves a hole of radius 0.4, which is 0.75px
   * across at this size and rasterises as a soft dot rather than a ring. So it is
   * drawn as the dot it would become.
   *
   * r4.5 with a filled r1.05 centre: 32.9 px², against `+` at 31.6 and `edit` at
   * 31.4 — the light band, where a control that only changes what you are looking
   * at belongs. The ink box is 9.6×9.6, between `start`'s 9×11 and `edit`'s
   * 10.5×10.5.
   *
   * Two arcs per circle rather than one: a 360° elliptical arc has identical start
   * and end points, which is the one case the SVG spec says to render as nothing.
   */
  focus: {
    px: 15,
    path: 'M3.5 8A4.5 4.5 0 1 1 12.5 8A4.5 4.5 0 1 1 3.5 8',
    fill: 'M6.95 8A1.05 1.05 0 1 1 9.05 8A1.05 1.05 0 1 1 6.95 8Z',
  },
} as const;

export type GlyphName = keyof typeof GLYPH;

/**
 * One glyph from the table, with no button around it.
 *
 * The table is the closed glyph set and says so — "a new glyph should mean a row
 * in the table above and nothing in the stylesheet" — but until now the only way
 * to reach a row was to render a `<button>`, so anything that needed a drawing
 * and *was not* a control had to redraw it somewhere else. That is the drift the
 * table exists to prevent, and the collapsed rail's counts are exactly the case:
 * a mark and a number, no button.
 *
 * It carries the row's own `px` as its font size the way `IconButton` does, so a
 * glyph is the same weight wherever it is drawn; a caller that wants it at the
 * size of the text around it says `size="inherit"`.
 */
export function Glyph({ glyph, size }: { glyph: GlyphName; size?: 'inherit' }) {
  const g = GLYPH[glyph] as { mark?: string; path?: string; fill?: string; px: number; sw?: number };
  if (!g.path) return <span aria-hidden="true">{g.mark}</span>;
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      style={size === 'inherit' ? undefined : { fontSize: `${g.px}px` }}
      fill="none"
      stroke="currentColor"
      strokeWidth={g.sw ?? 1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={g.path} />
      {g.fill && <path d={g.fill} fill="currentColor" stroke="none" />}
    </svg>
  );
}

/**
 * A glyph button that is a toggle rather than an action.
 *
 * `on` is the only way to get a pressed icon button, and it writes both halves at
 * once: the class the accent treatment hangs off, and `aria-pressed`. They are
 * one prop because they were two facts that could disagree — the panel's mode
 * switch painted its state and announced none of it, so a screen reader heard two
 * identical buttons where the eye saw one lit.
 *
 * Omitting `on` renders no `aria-pressed` at all, which is correct: a button that
 * does a thing is not a button that is in a state.
 */
export function IconButton({
  glyph,
  tone = 'ghost',
  size = 'tiny',
  extra,
  on,
  ...rest
}: Base & { glyph: GlyphName; tone?: Tone; size?: Size; extra?: string; on?: boolean }) {
  const g = GLYPH[glyph] as {
    mark?: string;
    path?: string;
    /** Drawn in `currentColor` rather than stroked — see `refresh`. */
    fill?: string;
    px: number;
    /** Per-glyph stroke weight, where the shared 1.2 does not suit the drawing. */
    sw?: number;
    nudge?: string;
  };
  return (
    <button
      className={cls('btn', TONE[tone], SIZE[size], 'icon-button', on && 'is-on', extra)}
      aria-pressed={on}
      // Inline because it is per-glyph metric data, not a theme decision: a new
      // glyph should mean a row in the table above and nothing in the stylesheet.
      style={{ fontSize: `${g.px}px`, ...(g.nudge ? { transform: `translateY(${g.nudge})` } : {}) }}
      {...rest}
    >
      {g.path ? (
        <svg
          viewBox="0 0 16 16"
          width="1em"
          height="1em"
          fill="none"
          stroke="currentColor"
          strokeWidth={g.sw ?? 1.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={g.path} />
          {g.fill && <path d={g.fill} fill="currentColor" stroke="none" />}
        </svg>
      ) : (
        <span aria-hidden="true">{g.mark}</span>
      )}
    </button>
  );
}
