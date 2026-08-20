import { useEnrichment } from '../enrichment.tsx';
import type { CardDTO, Size, Tone } from '../types.ts';

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

export function CardBody({
  card,
  size,
  showFacets,
  onOpen,
}: {
  card: CardDTO;
  size: Size;
  /** Which facets render as chips on the face. Defaults to all but source. */
  showFacets?: string[];
  onOpen?: (id: string) => void;
}) {
  const blocked = card.blockedBy.filter((b) => !b.done);
  const facetKeys = (showFacets ?? Object.keys(card.facets).filter((f) => f !== 'source')).filter(
    (f) => card.facets[f]?.length,
  );

  if (size === 'chip') {
    return (
      <div className={cls(card, 'chipnode')} onDoubleClick={() => onOpen?.(card.id)}>
        <span className="kindmark">{mark(card)}</span>
        <span className="chipnode-title">{card.title}</span>
        {card.childCount > 0 && <span className="count">{card.childCount}</span>}
      </div>
    );
  }

  return (
    <div className={cls(card, 'cardface')} onDoubleClick={() => onOpen?.(card.id)}>
      <div className="cardface-head">
        <span className="kindmark">{mark(card)}</span>
        <span className="cardface-title">{card.title}</span>
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

function mark(card: CardDTO): string {
  if (card.isProject) return '▣';
  return card.kind === 'node' ? '○' : '·';
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
