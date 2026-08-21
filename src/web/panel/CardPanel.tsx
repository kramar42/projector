import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { ProjectMark } from '../components/CardBody.tsx';
import { Button, IconButton } from '../components/Button.tsx';
import { usePanelWriter } from './usePanelWriter.ts';
import { Body, Facets, Frontmatter, Inbound, Links } from './blocks.tsx';
import type { CardDetail, Meta } from '../types.ts';

/**
 * The open record.
 *
 * The frame composes: it holds the scrim, the sticky title row, the one banner
 * and the order of the blocks. Everything that owns state, a write or a load is
 * a block in `blocks.tsx`; everything that owns none of the three is markup
 * here, because there is nothing to read about it beyond what it renders.
 *
 * There is no reset effect. `App` mounts this with `key={id}`, so switching
 * cards remounts the frame and every block — which means there is no list of
 * state to keep in step, and therefore no list that can fall two entries behind
 * the way the old one had (it enumerated six of nine, so opening a card from a
 * reflink while the body editor was dirty left the scrim dead and Escape
 * prompting about text that no longer existed).
 */
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
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const write = usePanelWriter({
    id,
    mtime: data?.mtime ?? null,
    reload,
    bodyHeld: dirty,
    onGone: onClose,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dirty && !confirm('The body has unsaved changes. Close anyway?')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, dirty]);

  /**
   * Commit the title edit. One body, called from Enter and from the button — it
   * was written out at both, which is two chances for one decision to drift.
   */
  const rename = () => {
    const next = editTitle;
    setEditTitle(null);
    if (next !== null) write.title(next);
  };

  const card = data?.card;

  return (
    <>
      <div className="scrim" onClick={() => (dirty ? undefined : onClose())} />
      <aside className="panel" role="dialog" aria-label="Card detail">
        {/*
          The one part of the panel that does not scroll, so it carries what a
          card face and a table row carry: the mark, then the title. Same glyph,
          same order, no word labels — this line should read the way the record
          reads everywhere else.
        */}
        <div className="panel-top">
          {card &&
            (editTitle === null ? (
              <h2 className="panel-title" onClick={() => setEditTitle(card.title)} title="click to rename">
                <ProjectMark card={card} onToggle={() => write.projectBlock(card.isProject ? null : {})} />
                <span className="panel-title-text">{card.title}</span>
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
                      rename();
                    }
                  }}
                />
                <div className="titleedit-bar">
                  <Button tone="primary" size="small" onClick={rename}>
                    Rename
                  </Button>
                  <Button tone="ghost" size="small" onClick={() => setEditTitle(null)}>
                    Cancel
                  </Button>
                  <span className="editor-hint">⏎ to save · ⇧⏎ for a newline</span>
                </div>
              </div>
            ))}
          {write.busy && <span className="panel-busy">{write.busy}…</span>}
          {/* The panel is closed by Escape or by clicking outside it, which is
              how it was actually being closed — so the corner goes to the one
              action that had nowhere good to live. It keeps its confirm, and it
              is the only control in the panel drawn in `bad`. */}
          {card && (
            <IconButton
              glyph="trash"
              tone="danger"
              size="normal"
              extra="panel-x"
              aria-label={`Delete ${card.title}`}
              title="Delete this record. The file is in git, so this is recoverable."
              onClick={() => {
                if (!confirm(`Delete "${card.title}"?\n\nThe file is in git, so this is recoverable.`))
                  return;
                write.remove();
              }}
            />
          )}
        </div>

        {error && <div className="pane-error">{error}</div>}
        {!data && !error && <div className="pane-loading">loading…</div>}

        {/*
          One banner, from one fact. There used to be two states for one failure
          — a `problem` string and a `conflict` flag — and the flag was never
          cleared on a new attempt, so a rejected value rendered under "Changed
          on disk, probably a Claude session" with a Reload that fixed nothing.
        */}
        {write.banner && (
          <div className={`banner is-${write.banner.tone}`}>
            {write.banner.canReload ? (
              <>
                <b>Changed on disk.</b> Something else — probably a Claude session — wrote this
                file after it was loaded here. Nothing was overwritten.
                <Button size="small" onClick={write.dismiss}>
                  Reload
                </Button>
              </>
            ) : (
              write.banner.message
            )}
          </div>
        )}

        {data && card && (
          /*
           * Four tiers, not ten peers.
           *
           * The order is what the panel is opened for, and one rule decides it:
           * a region whose height the card controls goes above one whose height
           * the *content* controls. Otherwise the thing you came to click moves
           * every time a body gets longer or a project gains a child.
           *
           *   state       the axes — bounded, and the commonest edit
           *   content     what it says and what it points at — unbounded
           *   inbound     what points at it, and what it inherits — derived
           *   workshop    the raw file, its path, and the two rare actions
           *
           * `Delete` used to be the first control in the panel, above the card's
           * own id, at the same size as everything else. Weight follows blast
           * radius, so it and the project toggle are at the foot now.
           */
          <div className="panel-body">
            <div className="panel-tier">
              <Facets
                defs={meta.facets}
                values={card.facets}
                refs={data.refs}
                selfId={card.id}
                write={write}
                onOpen={onOpen}
              />
            </div>

            <div className="panel-tier">
              <Links card={card} write={write} />
              <Body card={card} write={write} onDirtyChange={setDirty} />
            </div>

            {(card.blockedBy.length > 0 || data.children.length > 0 || data.project) && (
              <div className="panel-tier">
                <Inbound
                  head="Blocked by"
                  means="computed from other cards' blocks, not stored on this one"
                  records={card.blockedBy}
                  className={(b) => (b.done ? 'is-done' : 'is-open')}
                  onOpen={onOpen}
                />
                <Inbound
                  head="Children"
                  means="records naming this one as their parent, not stored on this one"
                  records={data.children}
                  onOpen={onOpen}
                />

                {data.project && (
                  <section className="panel-section">
                    <h3>
                      Project
                      <span
                        className="derived-word"
                        title="resolved along the project facet and its chain, not stored on this card"
                      >
                        inherited
                      </span>
                    </h3>
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
              </div>
            )}

            <div className="panel-tier is-workshop">
              <Frontmatter cardId={card.id} yaml={data.yaml} write={write} />

              {/* The id row is gone: it was the `?card=` parameter in the address
                  bar and the stem of the filename beside it, so the same string
                  appeared three times on what was then the first fold. */}
              <dl className="kv">
                <dt>file</dt>
                <dd><code>{data.file}</code></dd>
                {card.updated && (<><dt>updated</dt><dd>{card.updated}</dd></>)}
              </dl>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
