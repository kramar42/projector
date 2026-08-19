import { useEffect, useState } from 'react';
import { marked } from 'marked';
import { api } from '../api.ts';
import { CardBody } from '../components/CardBody.tsx';
import type { CardDetail } from '../types.ts';

/**
 * Render a card body to HTML.
 *
 * The source is escaped before markdown runs, so raw HTML in a card — whether
 * written by hand or by an agent — is displayed rather than executed. Cards are
 * local files, but they are also the one thing in this app that an automated
 * process writes, which is exactly where not to trust markup.
 */
function render(md: string): string {
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return marked.parse(escaped, { gfm: true, async: false });
}

export function CardPanel({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [data, setData] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api.card(id).then(setData, (e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="panel" role="dialog" aria-label="Card detail">
        <button className="panel-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {error && <div className="pane-error">{error}</div>}
        {!data && !error && <div className="pane-loading">loading…</div>}
        {data && (
          <div className="panel-body">
            <CardBody card={data.card} size="expanded" />

            <dl className="kv">
              <dt>id</dt>
              <dd>
                <code>{data.card.id}</code>
              </dd>
              <dt>file</dt>
              <dd>
                <code>{data.file}</code>
              </dd>
              {data.card.updated && (
                <>
                  <dt>updated</dt>
                  <dd>{data.card.updated}</dd>
                </>
              )}
            </dl>

            {data.parents.length > 0 && (
              <Section title="Parent">
                {data.parents.map((p) => (
                  <button className="reflink" key={p.id} onClick={() => onOpen(p.id)}>
                    {p.title}
                  </button>
                ))}
              </Section>
            )}

            {data.card.blockedBy.length > 0 && (
              <Section title="Blocked by">
                {data.card.blockedBy.map((b) => (
                  <button className={`reflink ${b.done ? 'is-done' : 'is-open'}`} key={b.id} onClick={() => onOpen(b.id)}>
                    {b.title}
                    {b.done ? ' ✓' : ''}
                  </button>
                ))}
              </Section>
            )}

            {data.children.length > 0 && (
              <Section title={`Children (${data.children.length})`}>
                {data.children.map((ch) => (
                  <button className="reflink" key={ch.id} onClick={() => onOpen(ch.id)}>
                    {ch.title}
                  </button>
                ))}
              </Section>
            )}

            {data.project && (
              <Section title="Project (inherited)">
                <div className="proj">
                  <div>
                    <span className="k">key</span> <code>{data.project.key}</code>
                  </div>
                  <div>
                    <span className="k">chain</span> {data.project.chain.join(' → ')}
                  </div>
                  {data.project.jira && (
                    <div>
                      <span className="k">jira</span> <code>{data.project.jira}</code>
                    </div>
                  )}
                  {data.project.branch && (
                    <div>
                      <span className="k">branch</span> <code>{data.project.branch}</code>
                    </div>
                  )}
                  {data.project.repos.map((r) => (
                    <div key={r.path}>
                      <span className="k">repo</span> <code>{r.path}</code>
                      {r.base ? ` @ ${r.base}` : ''}
                    </div>
                  ))}
                  {data.project.instructions.length > 0 && (
                    <details>
                      <summary>{data.project.instructions.length} instruction block(s)</summary>
                      <pre className="instructions">{data.project.instructions.join('\n\n')}</pre>
                    </details>
                  )}
                </div>
              </Section>
            )}

            {data.card.links.length > 0 && (
              <Section title="Links">
                <ul className="linklist">
                  {data.card.links.map((l, i) => (
                    <li key={i}>
                      <span className="linkkind">{l.kind || '?'}</span>
                      {/^https?:\/\//.test(l.ref) ? (
                        <a href={l.ref} target="_blank" rel="noreferrer noopener">
                          {l.ref}
                        </a>
                      ) : (
                        <code>{l.ref}</code>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {data.card.body.trim() && (
              <Section title="Body">
                <div className="md" dangerouslySetInnerHTML={{ __html: render(data.card.body) }} />
              </Section>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
