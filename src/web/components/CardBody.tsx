import { useEnrichment } from '../enrichment.tsx';
import { plural } from '../plural.ts';
import type { CardDTO } from '../types.ts';

/**
 * The one card component, rendered at two sizes inside a board column, a canvas
 * node and a table row. Every shape gets an identical card face because there is
 * only one implementation of a card face.
 *
 * It renders and nothing else: content is edited in the `?card=` panel, structure
 * by gesture (C10). There is no third `expanded` size — the panel is that, with
 * a deep link and the real editors.
 */

const FACET_TONE: Record<string, string> = {
  priority: 'facet-priority',
  status: 'facet-status',
  layer: 'facet-layer',
  project: 'facet-project',
  tech: 'facet-tech',
  waiting_on: 'facet-waiting',
  source: 'facet-muted',
  energy: 'facet-energy',
  domain: 'facet-domain',
};

const LINK_GLYPH: Record<string, string> = {
  jira: 'J',
  'gh:pr': 'PR',
  'gh:branch': 'br',
  'gh:commit': 'sha',
  claude: 'AI',
  doc: 'doc',
  slack: 'sl',
  url: '↗',
};

/**
 * One facet value on a face.
 *
 * An ordered facet draws its **bucket** rather than its value: a chip saying
 * `2026-09-01` tells you nothing a chip saying `overdue` does not, and the
 * bucket is also a class, so a deadline can colour itself. The bucket is
 * computed on the server (C8), so nothing here knows any facet by name.
 */
export function FacetChip({
  facet,
  value,
  bucket,
}: {
  facet: string;
  value: string;
  bucket?: string;
}) {
  return (
    <span className={`chip ${FACET_TONE[facet] ?? 'facet-muted'} ${bucket ? `is-${bucket}` : ''}`}>
      {value}
    </span>
  );
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
    res?.note,
  ]
    .filter(Boolean)
    .join('\n');

  const state =
    res?.state === 'error' ? 'is-failed' : res?.state === 'stale' ? 'is-stale' : d ? 'is-live' : '';

  return (
    <span className={`linkchip ${state}`} title={tip}>
      <b>{LINK_GLYPH[kind] ?? '?'}</b>
      <span className="linkchip-label">{shown}</span>
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
  card: CardDTO;
  /** Which facets render as chips on the face — the view's `chips`. */
  showFacets: string[];
  onOpen?: (id: string) => void;
}) {
  const blocked = card.blockedBy.filter((b) => !b.done);
  const facetKeys = showFacets.filter((f) => card.facets[f]?.length);

  return (
    <div className={cls(card, 'cardface')} onDoubleClick={() => onOpen?.(card.id)}>
      <div className="cardface-head">
        <RecordMark card={card} />
        <span className="cardface-title">{card.title}</span>
      </div>

      {facetKeys.length > 0 && (
        <div className="chiprow">
          {facetKeys.map((f) =>
            card.facets[f]!.map((v, i) => (
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
 * What a record is, in one glyph — read off the record rather than declared on
 * it. `▣` owns config its members inherit; `○` something is part of it; `•`
 * neither.
 *
 * There used to be a stored `kind` saying "card" or "node". It asserted what
 * these two counts already show, and it was never structural: what kept a
 * grouping record off a board was the status filter, not the kind. C11 — nothing
 * derivable is also stored.
 */
export function markOf(card: Marked): { glyph: string; role: string; means: string } {
  if (card.isProject) {
    return {
      glyph: '▣',
      role: 'project',
      means: 'A project: other records inherit its repos and instructions.',
    };
  }
  if (card.childCount > 0) {
    return {
      glyph: '○',
      role: 'container',
      means:
        card.childCount === 1
          ? '1 record names this one as its parent.'
          : `${plural(card.childCount, 'record')} name this one as their parent.`,
    };
  }
  // `•` rather than `·`. Measured at 15px in the mono stack, the middle dot's
  // ink is 1.85 × 2.23px against `○`'s 8.94 × 9.02 — nearly five times smaller
  // in each dimension, which is not a quieter mark, it is a speck. The bullet is
  // 4.35 × 4.34: legible, and still half the circle.
  return { glyph: '•', role: 'leaf', means: 'Nothing is part of this one.' };
}

/**
 * The two counts a mark is read from.
 *
 * Narrower than `CardDTO` on purpose: a reference facet resolves to a title and
 * these two numbers, not to a whole card, and the panel drawing its own
 * two-way `isProject ? ▣ : ·` was how `○` went missing from every reference —
 * a record named as a parent has children by definition, so the one mark that
 * should have been commonest never appeared at all.
 */
export interface Marked {
  isProject: boolean;
  childCount: number;
}

export function RecordMark({ card }: { card: Marked }) {
  // The role is also a class, because each glyph needs its own optical nudge —
  // see `.recordmark` in style.css.
  const { glyph, role, means } = markOf(card);
  return (
    <span className={`recordmark is-${role}`} title={means}>
      {glyph}
    </span>
  );
}

/**
 * The mark, as the control that changes what it says.
 *
 * A record *is* a project by carrying a `project:` block, and the mark is the one
 * place the app already states that. So the toggle is the mark: there is no
 * separate button whose label has to restate the glyph beside it, and no chance
 * of the two disagreeing. Clicking `·` or `○` adds the block; clicking `▣`
 * removes it, and the record falls back to whichever of the two it earns from its
 * child count.
 */
export function ProjectMark({ card, onToggle }: { card: Marked; onToggle: () => void }) {
  const { glyph, role, means } = markOf(card);
  // What it is, then what a click makes it. Two facts, one line each, and the
  // second names the consequence rather than the mechanism — "members stop
  // inheriting" is what actually happens to other records; "removes the project
  // block" is how.
  const next = card.isProject
    ? 'Click: stop being a project — its members stop inheriting these repos and instructions'
    : 'Click: make it a project — it can own repos and instructions its members inherit';
  return (
    <button
      className={`recordmark is-${role} is-toggle`}
      title={`${means}\n${next}`}
      onClick={(e) => {
        // The title beside it opens the rename editor on click.
        e.stopPropagation();
        onToggle();
      }}
    >
      {glyph}
    </button>
  );
}

function cls(card: CardDTO, base: string): string {
  return [
    base,
    card.isProject ? 'is-project' : '',
    card.blockedBy.some((b) => !b.done) ? 'is-blocked' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
