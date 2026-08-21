import { useState } from 'react';
import { useEnrichment } from '../enrichment.tsx';
import { IconButton } from './Button.tsx';
import type { CardDTO } from '../types.ts';

/**
 * One link, shown with whatever the server managed to resolve about it.
 *
 * It takes the DTO entry, not the raw ref. The panel used to flatten
 * `card.links` to `l.raw` and hand that over, so this row re-derived a kind and
 * a label the server had already computed and sent — and got a worse answer:
 * the same link read `J · PROJ-303` on the card face and `jira:PROJ-303` here,
 * the detail view showing strictly less than the summary it was opened from.
 */
function LinkRow({ link, onRemove }: { link: CardDTO['links'][number]; onRemove: () => void }) {
  const { get } = useEnrichment();
  const res = get(link.raw);
  const d = res?.data;

  // Enrichment is the richer answer when it exists; the DTO's own label is the
  // floor, exactly as it is on a card face. The raw ref is nobody's label.
  const label = d?.label ?? link.label;
  const kind = res?.kind || link.kind;

  return (
    <div className={`linkrow ${res?.state ? `state-${res.state}` : ''}`}>
      <div className="linkrow-head">
        <span className="linkkind">{kind}</span>
        {d?.url ? (
          <a className="linkrow-label" href={d.url} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        ) : (
          <span className="linkrow-label">{label}</span>
        )}
        {d?.badges?.map((b) => (
          <span key={b.label} className={`badge tone-${b.tone}`}>
            {b.label}
          </span>
        ))}
        {res?.state === 'stale' && <span className="badge tone-warn" title="refreshing">stale</span>}
        <IconButton glyph="close" title="remove this link" onClick={onRemove} />
      </div>

      {d?.title && <div className="linkrow-title">{d.title}</div>}

      {d?.fields?.length ? (
        <div className="linkrow-fields">
          {d.fields.map((f) => (
            <span key={f.k}>
              <em>{f.k}</em> {f.v}
            </span>
          ))}
        </div>
      ) : null}

      {d?.action && (
        <a className="linkrow-action" href={d.action.href} title={d.action.href}>
          {d.action.label}
        </a>
      )}

      {d?.command && <code className="linkrow-cmd">{d.command}</code>}

      {res?.error && (
        <div className={`linkrow-note ${res.needsSetup ? 'is-setup' : 'is-bad'}`}>{res.error}</div>
      )}
      {res?.note && <div className="linkrow-note">{res.note}</div>}
      {!res && <div className="linkrow-note">resolving…</div>}
      {/* The raw ref is worth showing only when it is all there is to show. */}
      {!d && <code className="linkrow-raw">{link.raw}</code>}
    </div>
  );
}

export function LinkEditor({
  links,
  onChange,
}: {
  links: CardDTO['links'];
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState('');
  return (
    <div className="linkedit">
      {links.map((l) => (
        <LinkRow
          key={l.raw}
          link={l}
          onRemove={() => onChange(links.filter((x) => x.raw !== l.raw).map((x) => x.raw))}
        />
      ))}
      <input
        value={adding}
        placeholder="jira:PROJ-303 · gh:pr:Org/repo#4 · claude:local_… · doc:path.md · https://…"
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const v = adding.trim();
          if (!v || links.some((l) => l.raw === v)) return;
          setAdding('');
          onChange([...links.map((l) => l.raw), v]);
        }}
      />
    </div>
  );
}
