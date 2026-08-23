import type { FacetDef } from './types.ts';

/**
 * What colour an axis draws in. One decision, and every surface asks it.
 *
 * It was two: `useHue` in `vocabulary.tsx` chose a chip class, `CanvasView` built
 * a `var(--hue-*)` for an edge, and each had its own idea of what an undeclared
 * axis or a reference meant. Two ideas of one thing is how a record came to read
 * as a purple `parent` chip on a board and as plain text in the editor, and how
 * the built-in axis ended up drawn in *purple* by the record picker while
 * declaring `blue` in its own definition.
 *
 * The four registers, in the order they are decided:
 *
 *  1. **app** — the axis the app itself defines (`builtin`). It draws in
 *     `--accent`, because the app's own axis is the app speaking. Nothing else in
 *     the vocabulary may claim the accent.
 *  2. **record** — every other reference axis. A reference value is not a value,
 *     it is another record, so it draws in the neutral register a record is drawn
 *     in everywhere: mark, title, no family. A `hue:` on a reference is a *line*
 *     colour — the canvas edge — and never a chip's.
 *  3. **family** — a label, date or number axis with a `hue:`, or a bucket with
 *     one of its own. A bucket wins and draws *filled*, which is the point of
 *     declaring one: `overdue` loud on an axis that is otherwise quiet.
 *  4. **muted** — no hue declared. The chip recedes, which is what a hint like
 *     `source` wants (The Hints Are Hueless Rule).
 */
export type Register =
  | { kind: 'app' }
  | { kind: 'record' }
  | { kind: 'family'; hue: string; filled: boolean }
  | { kind: 'muted' };

export function registerOf(def: FacetDef | undefined, bucket?: string): Register {
  // A reference is decided by what it *is*, before any hue it declares: the
  // declaration still does something — it colours the relation's edge — but a
  // record at the end of that edge is drawn as a record.
  if (def?.type === 'ref') return def.builtin ? { kind: 'app' } : { kind: 'record' };
  if (def?.builtin) return { kind: 'app' };

  const fromBucket = bucket ? def?.buckets?.find((b) => b.name === bucket)?.hue : undefined;
  if (fromBucket && fromBucket !== 'none') return { kind: 'family', hue: fromBucket, filled: true };
  const hue = def?.hue;
  if (!hue || hue === 'none') return { kind: 'muted' };
  return { kind: 'family', hue, filled: false };
}

/** Whether this is the axis the app defines — the one that may draw in the accent. */
export function isAppAxis(def: FacetDef | undefined): boolean {
  return registerOf(def).kind === 'app';
}

/**
 * The class a value draws in on a chip — a card face, a canvas node, a table
 * cell, the bulk bar's preview, the panel's toggle chips.
 *
 * The container is the surface's business and the colour is the axis's: a label
 * value is a tinted chip on a face and a bordered toggle in the editor, and both
 * are the same family. `.facet-app` and `.facet-ref` are the two registers this
 * adds to that arrangement, and both hold for every surface.
 */
export function chipClass(def: FacetDef | undefined, bucket?: string): string {
  const reg = registerOf(def, bucket);
  switch (reg.kind) {
    case 'app':
      return 'facet-app';
    case 'record':
      return 'facet-ref';
    case 'muted':
      return 'facet-muted';
    case 'family':
      return `facet-hue-${reg.hue}${reg.filled ? ' is-filled' : ''}`;
  }
}

/**
 * The colour a canvas edge draws in — the relation's own, so the graph says which
 * relation it draws without a legend.
 *
 * This is the one place a reference axis's declared `hue` is used, and the reason
 * the declaration is worth keeping on an axis whose chips are hueless. The app's
 * own axis draws its edges in the accent unless a vault says otherwise, so its
 * lines and its chips agree.
 */
export function edgeColour(def: FacetDef | undefined): string {
  if (def?.hue && def.hue !== 'none') return `var(--hue-${def.hue})`;
  if (def?.builtin) return 'var(--accent)';
  return 'var(--ink-3)';
}
