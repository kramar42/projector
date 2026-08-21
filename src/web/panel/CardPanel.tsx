import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { RecordMark } from '../components/CardBody.tsx';
import { Button, IconButton } from '../components/Button.tsx';
import { usePanelWriter } from './usePanelWriter.ts';
import { Actions, Body, Facets, Frontmatter, Links } from './blocks.tsx';
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
                <RecordMark card={card} />
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
          <IconButton glyph="close" size="normal" extra="panel-x" onClick={onClose} aria-label="Close" />
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
          <div className="panel-body">
            <Actions card={card} write={write} />

            {/* The id row is gone: it is the `?card=` parameter in the address
                bar and the stem of the filename on the row below, so it was the
                same string three times on the first fold of the panel. */}
            <dl className="kv">
              <dt>file</dt>
              <dd><code>{data.file}</code></dd>
              {card.updated && (<><dt>updated</dt><dd>{card.updated}</dd></>)}
            </dl>

            <Facets
              defs={meta.facets}
              values={card.facets}
              refs={data.refs}
              selfId={card.id}
              write={write}
              onOpen={onOpen}
            />

            {/* Derived, both of them: the inbound side of `blocks` and of
                `parent`. There is no edit here because the edit lives on the
                other card — the `ƒ` says so, the same mark the filter panel
                uses for an axis it computed rather than read. */}
            {card.blockedBy.length > 0 && (
              <section className="panel-section">
                <h3>
                  Blocked by
                  <span className="derived" title="computed from other cards' blocks, not stored on this one">ƒ</span>
                </h3>
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
                <h3>
                  Children ({data.children.length})
                  <span className="derived" title="records naming this one as their parent, not stored on this one">ƒ</span>
                </h3>
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

            <Links card={card} write={write} />

            <Frontmatter cardId={card.id} yaml={data.yaml} write={write} />

            <Body card={card} write={write} onDirtyChange={setDirty} />
          </div>
        )}
      </aside>
    </>
  );
}
