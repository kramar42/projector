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
   * record mark.
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
} as const;

export type GlyphName = keyof typeof GLYPH;

export function IconButton({
  glyph,
  tone = 'ghost',
  size = 'tiny',
  extra,
  ...rest
}: Base & { glyph: GlyphName; tone?: Tone; size?: Size; extra?: string }) {
  const g = GLYPH[glyph] as {
    mark?: string;
    path?: string;
    /** Drawn in `currentColor` rather than stroked — see `refresh`. */
    fill?: string;
    px: number;
    nudge?: string;
  };
  return (
    <button
      className={cls('btn', TONE[tone], SIZE[size], 'icon-button', extra)}
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
          strokeWidth="1.2"
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
