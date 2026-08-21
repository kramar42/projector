import { useState } from 'react';
import { useEnrichment } from '../enrichment.tsx';
import { IconButton } from './Button.tsx';
import type { CardDTO } from '../types.ts';

/**
 * One link, shown with whatever the server managed to resolve about it.
 *
 * Two rules, and everything else follows from them.
 *
 * **A link is clickable if it has anywhere to go**, which is a property of the
 * ref and not of a fetcher. This row used to linkify only when enrichment
 * supplied a `url`, so a Slack permalink — a kind with no fetcher and no plan for
 * one — rendered as dead text. `href` now arrives on the DTO for every kind that
 * has one; enrichment can still override it with something better.
 *
 * **Nothing repeats what the line above already said.** The row printed the
 * shortened URL as its label and then the full raw ref underneath, so one link
 * cost 92px and two thirds of it was the same string twice.
 *
 * Both extra lines are gone. Once every kind that has a URL is clickable, the raw
 * ref adds nothing in any case that occurs: where the label is lossy the ref is
 * one hover away, and where it is not — an unknown prefix, whose label *is* the
 * ref — printing it again was the same duplication in a different costume. The
 * "no fetcher for this kind" note went with it: it explained an absence that
 * stopped having a consequence the moment the link worked without one.
 */
function LinkRow({ link, onRemove }: { link: CardDTO['links'][number]; onRemove: () => void }) {
  const { get } = useEnrichment();
  const res = get(link.raw);
  const d = res?.data;

  // Enrichment is the richer answer when it exists; the DTO's own is the floor,
  // exactly as it is on a card face.
  const label = d?.label ?? link.label;
  const kind = res?.kind || link.kind;
  const href = d?.url ?? link.href;

  return (
    <div className={`linkrow ${res?.state ? `state-${res.state}` : ''}`}>
      <div className="linkrow-head">
        <span className="linkkind">{kind}</span>
        {href ? (
          <a className="linkrow-label" href={href} target="_blank" rel="noreferrer noopener" title={link.raw}>
            {label}
          </a>
        ) : (
          <span className="linkrow-label" title={link.raw}>
            {label}
          </span>
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

      {/* The two things a browser cannot do for you: hand the ref to the app that
          owns it, and give you a command to paste. Only `claude` has either. */}
      {d?.action && (
        <a className="linkrow-action" href={d.action.href} title={d.action.href}>
          {d.action.label}
        </a>
      )}

      {d?.command && <code className="linkrow-cmd">{d.command}</code>}

      {/* A real failure, which is worth a line. `res.note` is not rendered: it
          only ever said a kind has no fetcher, which stopped being a fact the
          reader has to act on once the link became clickable without one. */}
      {res?.error && (
        <div className={`linkrow-note ${res.needsSetup ? 'is-setup' : 'is-bad'}`}>{res.error}</div>
      )}
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
