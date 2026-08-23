import { useState } from 'react';
import { useEnrichment } from '../enrichment.tsx';
import { IconButton } from './Button.tsx';
import type { CardDTO } from '../types.ts';

/**
 * One link, shown with whatever the server managed to resolve about it.
 *
 * Three rules, and everything else follows from them.
 *
 * **One skeleton, eight kinds.** Every row is the same five slots in the same
 * order — identity, what it is, what is true about it, the fallback, what went
 * wrong — and a kind differs only in which of the optional four it fills. They
 * were not: the way in sat in the head for `slack` and `url`, in the head for
 * `jira` and `gh:*`, in a button *below the fields* for `claude`, and in a code
 * block below them for `doc`. On a resolved session that put it at y=153 of a
 * 184px row where the same question is answered at y=9 on a Slack row — one
 * component asking you to look in three places depending on what you linked.
 *
 * **The label is the way in.** Whatever the href's origin — a browser url, a ref
 * that is already a url, or an app deep link — it lands on the label and nowhere
 * else. So there is no control reading "open in Claude": the label already names
 * the session, and a click already means go there.
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
  // One slot, three possible sources. `action` is an app deep link rather than a
  // browser url, which changes where it goes and not what it is.
  const href = d?.url ?? link.href ?? d?.action?.href ?? null;
  const tip = [link.raw, d?.action?.label].filter(Boolean).join(' — ');

  return (
    <div className={`linkrow ${res?.state ? `state-${res.state}` : ''}`}>
      <div className="linkrow-head">
        <span className="linkkind">{kind}</span>
        {href ? (
          <a className="linkrow-label" href={href} target="_blank" rel="noreferrer noopener" title={tip}>
            {label}
          </a>
        ) : (
          <span className="linkrow-label" title={tip}>
            {label}
          </span>
        )}
        {d?.badges?.map((b) => (
          <span key={b.label} className={`badge tone-${b.tone}`}>
            {b.label}
          </span>
        ))}
        {res?.state === 'stale' && (
          <span className="badge tone-warn" title="cached; a refresh is running now">
            stale
          </span>
        )}
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

      {/* The fallback, and only that: a fetcher offers a command when it could
          offer no click at all, so this never appears beside a working label. */}
      {d?.command && !href && <code className="linkrow-cmd">{d.command}</code>}

      {/* A real failure, which is worth a line. `res.note` is not rendered: it
          only ever said a kind has no fetcher, which stopped being a fact the
          reader has to act on once the link became clickable without one. */}
      {res?.error && (
        <div className={`linkrow-note ${res.needsSetup ? 'is-setup' : 'is-bad'}`}>{res.error}</div>
      )}
    </div>
  );
}

/**
 * Past this, the link list stops being an annotation and becomes the section.
 *
 * Three rather than the inbound lists' six, because a link row is not a line: an
 * enriched one carries a head, a label, a field row and possibly an error, so
 * three of them already outweigh the body they sit under. Same `n more` control
 * the inbound lists and the filter rail use, for the same reason — a fold, not a
 * scroll inside a scroll.
 */
const LINK_CUTOFF = 3;

export function LinkEditor({
  links,
  onChange,
}: {
  links: CardDTO['links'];
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState('');
  const [all, setAll] = useState(false);
  const shown = all ? links : links.slice(0, LINK_CUTOFF);
  return (
    <div className="linkedit">
      {shown.map((l) => (
        <LinkRow
          key={l.raw}
          link={l}
          onRemove={() => onChange(links.filter((x) => x.raw !== l.raw).map((x) => x.raw))}
        />
      ))}
      {links.length > LINK_CUTOFF && (
        <button className="facet-more" onClick={() => setAll((v) => !v)}>
          {all ? 'less' : `${links.length - LINK_CUTOFF} more`}
        </button>
      )}
      <input
        value={adding}
        placeholder="jira:PROJ-303 · gh:pr:Org/repo#4 · claude:local_… · doc:path.md · https://…"
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          // Escape stops here, as it does at the title editor, the facet's
          // `+ new` field and the record picker. It did not, and this was the one
          // silent data-loss path in the panel: the panel's guard is a `window`
          // listener, a typed-but-uncommitted link sets no dirty flag, so Escape
          // closed the whole card and took the text with it without asking.
          if (e.key === 'Escape') {
            e.stopPropagation();
            setAdding('');
            return;
          }
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
