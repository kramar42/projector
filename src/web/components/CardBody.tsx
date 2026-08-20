import { useEnrichment } from '../enrichment.tsx';
import type { CardDTO, Tone } from '../types.ts';

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
  trello: 'T',
  cal: 'cal',
  grafana: 'gr',
  url: '↗',
};

export function FacetChip({ facet, value }: { facet: string; value: string }) {
  return <span className={`chip ${FACET_TONE[facet] ?? 'facet-muted'}`}>{value}</span>;
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

/**
 * A deadline, once it is close enough to matter.
 *
 * `later` draws nothing: a face that badges every date says nothing about the
 * one that is overdue. The bucket is computed on the server (C8), so this and
 * the `due` filter axis can never disagree about where the boundary falls.
 */
export function DueBadge({ card }: { card: CardDTO }) {
  if (!card.due || !card.dueIn || card.dueIn === 'later') return null;
  const label = card.dueIn === 'overdue' ? 'overdue' : card.dueIn === 'today' ? 'today' : card.due;
  return (
    <span className={`due is-${card.dueIn}`} title={`due ${card.due}`}>
      {label}
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
        <KindMark card={card} />
        <span className="cardface-title">{card.title}</span>
        <DueBadge card={card} />
      </div>

      {facetKeys.length > 0 && (
        <div className="chiprow">
          {facetKeys.map((f) =>
            card.facets[f]!.map((v) => <FacetChip key={`${f}:${v}`} facet={f} value={v} />),
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
 * What a record is, in one glyph. `▣` a project, `○` a node, `·` a card.
 *
 * One definition, because it appears on a card face, in a table row and in the
 * card panel — and in the panel it is what makes *Demote to node* and *Not a
 * project* legible as actions on something.
 */
export function kindGlyph(card: CardDTO): string {
  if (card.isProject) return '▣';
  return card.kind === 'node' ? '○' : '·';
}

/** The same thing in words, for a tooltip or a badge. */
export function kindWords(card: CardDTO): string[] {
  const out = card.isProject ? ['project'] : [];
  out.push(card.kind === 'node' ? 'node' : 'card');
  return out;
}

const MEANS: Record<string, string> = {
  project: 'a project — it owns repos and instructions that its members inherit',
  node: 'a node — a thought, canvas only, kept off boards by the default filter',
  card: 'a card — work, with facets and links',
};

export function kindTitle(card: CardDTO): string {
  return kindWords(card)
    .map((w) => MEANS[w])
    .join('\n');
}

export function KindMark({ card }: { card: CardDTO }) {
  // The kind is also a class, because each glyph needs its own optical nudge —
  // see `.kindmark` in style.css.
  const kind = card.isProject ? 'project' : card.kind === 'node' ? 'node' : 'card';
  return (
    <span className={`kindmark is-${kind}`} title={kindTitle(card)}>
      {kindGlyph(card)}
    </span>
  );
}

function cls(card: CardDTO, base: string): string {
  return [
    base,
    card.isProject ? 'is-project' : '',
    card.kind === 'node' ? 'is-node' : '',
    card.blockedBy.some((b) => !b.done) ? 'is-blocked' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
