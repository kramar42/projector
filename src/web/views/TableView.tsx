import { FacetChip } from '../components/CardBody.tsx';
import { useRequestEnrichment } from '../enrichment.tsx';
import { NONE } from './dragSemantics.ts';
import type { CardDTO, QueryResponse, Rollup } from '../types.ts';

/**
 * The third shape.
 *
 * A table exists for the one thing neither a board nor a canvas gives: columns of
 * numbers. Its columns are `face.chips` — the same list a board draws as chips —
 * so switching shape never asks "which facets matter" twice, and there is no
 * column picker to build or keep in sync.
 *
 * Read-only, like every shape: a row click opens `?card=` and the panel does the
 * editing (C10).
 */
export function TableView({
  data,
  onOpen,
}: {
  data: QueryResponse;
  onOpen: (id: string) => void;
}) {
  const chips = data.spec.face.chips ?? [];
  // A project row earns the roll-up columns; a table of ordinary cards has
  // nothing to put in them.
  const projects = data.ids.some((id) => data.cards[id]?.isProject);

  useRequestEnrichment([
    ...new Set(data.ids.flatMap((id) => data.cards[id]?.links.map((l) => l.raw) ?? [])),
  ]);

  const sections = data.groups ?? [{ value: '', ids: data.ids }];

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="col-title">Title</th>
            {chips.map((c) => (
              <th key={c}>{data.counts.find((f) => f.facet === c)?.label ?? c}</th>
            ))}
            {projects && (
              <>
                <th className="num" title="cards naming this project directly / including nested projects">
                  Cards
                </th>
                <th className="num">Blocked</th>
                <th className="num">Untriaged</th>
                <th title="the project this project itself belongs to — inheritance runs up this chain">
                  Member of
                </th>
              </>
            )}
            <th className="col-updated">Updated</th>
          </tr>
        </thead>
        {sections.map((section) => (
          <tbody key={`${section.lane ?? ''}/${section.value}`}>
            {section.value !== '' && (
              <tr className="section">
                <th colSpan={chips.length + (projects ? 5 : 1) + 1}>
                  {section.lane ? `${section.lane} · ` : ''}
                  {section.value === NONE ? 'no value' : section.value}
                  <span className="section-count">{section.ids.length}</span>
                </th>
              </tr>
            )}
            {section.ids.map((id) => {
              const card = data.cards[id];
              if (!card) return null;
              return (
                <Row
                  key={id}
                  card={card}
                  chips={chips}
                  rollup={data.rollups?.[id]}
                  projects={projects}
                  onOpen={onOpen}
                />
              );
            })}
          </tbody>
        ))}
      </table>
      {!data.ids.length && <div className="pane-loading">no records match</div>}
    </div>
  );
}

function Row({
  card,
  chips,
  rollup,
  projects,
  onOpen,
}: {
  card: CardDTO;
  chips: string[];
  rollup: Rollup | undefined;
  projects: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <tr className={card.isProject ? 'is-project' : ''} onClick={() => onOpen(card.id)}>
      <td className="col-title">
        <span className="kindmark">{card.isProject ? '▣' : card.kind === 'node' ? '○' : '·'}</span>
        {card.title}
        {card.childCount > 0 && <span className="count">{card.childCount}</span>}
      </td>
      {chips.map((facet) => (
        <td key={facet}>
          {(card.facets[facet] ?? []).map((v) => (
            <FacetChip key={v} facet={facet} value={v} />
          ))}
        </td>
      ))}
      {projects && (
        <>
          <td className="num">
            {rollup ? (
              <span title={`${rollup.direct} directly, ${rollup.total} including nested projects`}>
                {rollup.direct}
                {rollup.total !== rollup.direct && <span className="num-total"> / {rollup.total}</span>}
              </span>
            ) : (
              ''
            )}
          </td>
          <td className="num">{rollup?.blocked || ''}</td>
          <td className="num">{rollup?.untriaged || ''}</td>
          <td className="col-repos">{(card.facets.project ?? []).join(', ')}</td>
        </>
      )}
      <td className="col-updated">{rollup?.touched ?? card.updated ?? ''}</td>
    </tr>
  );
}
