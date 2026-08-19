import { useEffect, useState } from 'react';
import { marked } from 'marked';
import { ApiError, api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { CardBody } from '../components/CardBody.tsx';
import { BodyEditor } from '../components/BodyEditor.tsx';
import { FacetEditor } from '../components/FacetEditor.tsx';
import { RecordPicker } from '../components/RecordPicker.tsx';
import type { CardDetail, Meta } from '../types.ts';

/**
 * Render a card body to HTML.
 *
 * The source is escaped before markdown runs, so raw HTML in a card — whether
 * written by hand or by an agent — is displayed rather than executed. Cards are
 * local files, but they are also the one thing here that an automated process
 * writes, which is exactly where not to trust markup.
 */
function render(md: string): string {
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = marked.parse(escaped, { gfm: true, async: false });
  // Relative asset paths resolve through the server's asset route.
  return html.replace(/src="(assets\/[^"]+)"/g, 'src="/api/asset/$1"');
}

export function CardPanel({
  id,
  meta,
  onClose,
  onOpen,
}: {
  id: string;
  meta: Meta;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const { data, error, reload } = useLive<CardDetail>(() => api.card(id), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [pickParent, setPickParent] = useState(false);
  const [showBody, setShowBody] = useState<'read' | 'edit'>('read');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setProblem(null);
    setConflict(false);
    setEditTitle(null);
    setShowBody('read');
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dirty && !confirm('The body has unsaved changes. Close anyway?')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, dirty]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setProblem(null);
    try {
      await fn();
      setConflict(false);
      reload();
    } catch (err) {
      const e = err as ApiError;
      if (e.conflict) setConflict(true);
      setProblem(e.message);
    } finally {
      setBusy(null);
    }
  };

  const card = data?.card;

  return (
    <>
      <div className="scrim" onClick={() => (dirty ? undefined : onClose())} />
      <aside className="panel" role="dialog" aria-label="Card detail">
        <div className="panel-top">
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
          {busy && <span className="panel-busy">{busy}…</span>}
        </div>

        {error && <div className="pane-error">{error}</div>}
        {!data && !error && <div className="pane-loading">loading…</div>}

        {conflict && (
          <div className="banner is-conflict">
            <b>Changed on disk.</b> Something else — probably a Claude session — wrote this file after
            it was loaded here. Nothing was overwritten.
            <button className="btn small" onClick={() => { setConflict(false); reload(); }}>
              Reload
            </button>
          </div>
        )}
        {problem && !conflict && <div className="banner is-bad">{problem}</div>}

        {data && card && (
          <div className="panel-body">
            {editTitle === null ? (
              <h2 className="panel-title" onClick={() => setEditTitle(card.title)} title="click to rename">
                {card.title}
              </h2>
            ) : (
              <div className="titleedit">
                <textarea
                  autoFocus
                  value={editTitle}
                  rows={2}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditTitle(null);
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      const next = editTitle;
                      setEditTitle(null);
                      void run('renaming', () =>
                        api.patchCard(card.id, { title: next, baseMtime: data.mtime }),
                      );
                    }
                  }}
                />
                <div className="titleedit-bar">
                  <button
                    className="btn primary small"
                    onClick={() => {
                      const next = editTitle;
                      setEditTitle(null);
                      void run('renaming', () =>
                        api.patchCard(card.id, { title: next, baseMtime: data.mtime }),
                      );
                    }}
                  >
                    Rename
                  </button>
                  <button className="btn small" onClick={() => setEditTitle(null)}>
                    Cancel
                  </button>
                  <span className="editor-hint">⏎ to save · ⇧⏎ for a newline</span>
                </div>
              </div>
            )}

            <div className="panel-actions">
              <button
                className="btn small"
                onClick={() =>
                  void run('changing kind', () =>
                    api.patchCard(card.id, {
                      kind: card.kind === 'card' ? 'node' : 'card',
                      baseMtime: data.mtime,
                    }),
                  )
                }
                title={
                  card.kind === 'card'
                    ? 'Demote to a node: a thought, canvas-only, off every board'
                    : 'Promote to a card: real work, appears on boards'
                }
              >
                {card.kind === 'card' ? 'Demote to node' : 'Promote to card'}
              </button>
              <button
                className="btn small danger"
                onClick={() => {
                  if (!confirm(`Delete "${card.title}"?\n\nThe file is in git, so this is recoverable.`))
                    return;
                  void run('deleting', async () => {
                    await api.deleteCard(card.id);
                    onClose();
                  });
                }}
              >
                Delete
              </button>
            </div>

            <dl className="kv">
              <dt>id</dt>
              <dd><code>{card.id}</code></dd>
              <dt>file</dt>
              <dd><code>{data.file}</code></dd>
              {card.updated && (<><dt>updated</dt><dd>{card.updated}</dd></>)}
            </dl>

            <section className="panel-section">
              <h3>Parent {card.projectKey ? `· project ${card.projectKey}` : '· no project'}</h3>
              {data.parents.map((p) => (
                <button className="reflink" key={p.id} onClick={() => onOpen(p.id)}>
                  {p.title}
                </button>
              ))}
              {!pickParent ? (
                <button className="btn small" onClick={() => setPickParent(true)}>
                  {data.parents.length ? 'Change parent' : 'Set parent'}
                </button>
              ) : (
                <RecordPicker
                  exclude={[card.id]}
                  placeholder="parent record…"
                  onCancel={() => setPickParent(false)}
                  onPick={(pid) => {
                    setPickParent(false);
                    void run('re-parenting', () =>
                      api.bulk({ ids: [card.id], op: 'parent', parent: pid }),
                    );
                  }}
                />
              )}
              {!card.projectKey && (
                <p className="hint">
                  A card gets its project from the parent chain, so setting a parent here is what puts
                  it in a project.
                </p>
              )}
            </section>

            <section className="panel-section">
              <h3>Facets</h3>
              {Object.entries(meta.facets).map(([name, def]) => (
                <FacetEditor
                  key={name}
                  name={name}
                  def={def}
                  values={card.facets[name] ?? []}
                  onChange={(next) =>
                    void run('saving facets', () =>
                      api.patchCard(card.id, {
                        facets: { ...stripDerived(card.facets, meta), [name]: next },
                        baseMtime: data.mtime,
                      }),
                    )
                  }
                />
              ))}
            </section>

            {card.blockedBy.length > 0 && (
              <section className="panel-section">
                <h3>Blocked by</h3>
                {card.blockedBy.map((b) => (
                  <button
                    className={`reflink ${b.done ? 'is-done' : 'is-open'}`}
                    key={b.id}
                    onClick={() => onOpen(b.id)}
                  >
                    {b.title}
                    {b.done ? ' ✓' : ''}
                  </button>
                ))}
              </section>
            )}

            {data.children.length > 0 && (
              <section className="panel-section">
                <h3>Children ({data.children.length})</h3>
                {data.children.map((ch) => (
                  <button className="reflink" key={ch.id} onClick={() => onOpen(ch.id)}>
                    {ch.title}
                  </button>
                ))}
              </section>
            )}

            {data.project && (
              <section className="panel-section">
                <h3>Project (inherited)</h3>
                <div className="proj">
                  <div><span className="k">key</span> <code>{data.project.key}</code></div>
                  <div><span className="k">chain</span> {data.project.chain.join(' → ')}</div>
                  {data.project.jira && (<div><span className="k">jira</span> <code>{data.project.jira}</code></div>)}
                  {data.project.branch && (<div><span className="k">branch</span> <code>{data.project.branch}</code></div>)}
                  {data.project.repos.map((r) => (
                    <div key={r.path}>
                      <span className="k">repo</span> <code>{r.path}</code>{r.base ? ` @ ${r.base}` : ''}
                    </div>
                  ))}
                  {data.project.instructions.length > 0 && (
                    <details>
                      <summary>{data.project.instructions.length} instruction block(s)</summary>
                      <pre className="instructions">{data.project.instructions.join('\n\n')}</pre>
                    </details>
                  )}
                </div>
              </section>
            )}

            <section className="panel-section">
              <h3>Links</h3>
              <LinkEditor
                links={card.links.map((l) => l.raw)}
                onChange={(next) =>
                  void run('saving links', () =>
                    api.patchCard(card.id, { links: next, baseMtime: data.mtime }),
                  )
                }
              />
            </section>

            <section className="panel-section">
              <h3>
                Body
                <span className="tabs">
                  <button
                    className={`tab ${showBody === 'read' ? 'is-on' : ''}`}
                    onClick={() => setShowBody('read')}
                  >
                    read
                  </button>
                  <button
                    className={`tab ${showBody === 'edit' ? 'is-on' : ''}`}
                    onClick={() => setShowBody('edit')}
                  >
                    edit
                  </button>
                </span>
              </h3>
              {showBody === 'read' ? (
                card.body.trim() ? (
                  <div className="md" dangerouslySetInnerHTML={{ __html: render(card.body) }} />
                ) : (
                  <p className="hint">Empty. Switch to edit to write something.</p>
                )
              ) : (
                <BodyEditor
                  cardId={card.id}
                  value={card.body}
                  onDirtyChange={setDirty}
                  onSave={(body) => api.patchCard(card.id, { body }).then(() => reload())}
                />
              )}
            </section>
          </div>
        )}
      </aside>
    </>
  );
}

/** The derived `project` facet is served for display but must never be written back. */
function stripDerived(facets: Record<string, string[]>, meta: Meta): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(facets)) {
    if (meta.facets[k]?.derived) continue;
    out[k] = v;
  }
  return out;
}

function LinkEditor({ links, onChange }: { links: string[]; onChange: (next: string[]) => void }) {
  const [adding, setAdding] = useState('');
  return (
    <div className="linkedit">
      {links.map((raw) => (
        <div className="linkedit-row" key={raw}>
          {/^https?:\/\//.test(raw) ? (
            <a href={raw} target="_blank" rel="noreferrer noopener">{raw}</a>
          ) : (
            <code>{raw}</code>
          )}
          <button
            className="btn ghost tiny"
            title="remove"
            onClick={() => onChange(links.filter((l) => l !== raw))}
          >
            ✕
          </button>
        </div>
      ))}
      <input
        value={adding}
        placeholder="jira:PROJ-303 · gh:pr:Org/repo#4 · claude:local_… · doc:path.md · https://…"
        onChange={(e) => setAdding(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const v = adding.trim();
          if (!v || links.includes(v)) return;
          setAdding('');
          onChange([...links, v]);
        }}
      />
    </div>
  );
}
