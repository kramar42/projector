import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { ProjectMark } from '../components/CardBody.tsx';
import { Button, IconButton } from '../components/Button.tsx';
import { usePanelWriter } from './usePanelWriter.ts';
import { Body, Facets, Frontmatter, Inbound, Links } from './blocks.tsx';
import { plural } from '../plural.ts';
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
/** What the close prompt names, so it says what is actually at risk. */
function whatIsUnsaved(u: { body: boolean; frontmatter: boolean }): string {
  if (u.body && u.frontmatter) return 'The body and the frontmatter have';
  return u.body ? 'The body has' : 'The frontmatter has';
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
  const [editTitle, setEditTitle] = useState<string | null>(null);

  /**
   * Which editors hold unsaved text.
   *
   * Two flags rather than one, because both consumers need them apart. The close
   * guard wants *any* of them. The writer wants each on its own: `heldBase`
   * freezes the mtime a document's write is gated on, and a dirty frontmatter
   * pane says nothing about the body's document, so neither may pin the other.
   *
   * It was one flag, fed only by the body. Two things followed: unsaved YAML was
   * discarded by Escape or a scrim click with no prompt, and — worse, because it
   * was silent — the frontmatter editor wrote the whole block gated on the
   * freshest mtime while displaying an older read, so saving it reverted every
   * chip clicked since the pane was opened.
   */
  const [unsaved, setUnsaved] = useState({ body: false, frontmatter: false });
  const setBodyDirty = useCallback((d: boolean) => setUnsaved((u) => (u.body === d ? u : { ...u, body: d })), []);
  const setFmDirty = useCallback(
    (d: boolean) => setUnsaved((u) => (u.frontmatter === d ? u : { ...u, frontmatter: d })),
    [],
  );
  const held = unsaved.body || unsaved.frontmatter;

  const write = usePanelWriter({
    id,
    mtime: data?.mtime ?? null,
    reload,
    held: unsaved,
    onGone: onClose,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (held && !confirm(`${whatIsUnsaved(unsaved)} unsaved changes. Close anyway?`)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, held, unsaved]);

  /**
   * Commit the title edit. One body, called from Enter and from the button — it
   * was written out at both, which is two chances for one decision to drift.
   */
  const rename = () => {
    const next = editTitle?.trim();
    setEditTitle(null);
    // A rename to the same words is still a write: it rewrites the file and bumps
    // `updated`, which is a column you sort by and a signal `pj intake` reads. The
    // button and Enter have to agree on that, so the test lives here as well as on
    // the control.
    if (!next || next === card?.title.trim()) return;
    write.title(next);
  };

  const card = data?.card;

  return (
    <>
      <div className="scrim" onClick={() => (held ? undefined : onClose())} />
      <aside className="panel" role="dialog" aria-label={card ? card.title : 'Card'}>
        {/*
          The one part of the panel that does not scroll, so it carries what a
          card face and a table row carry: the mark, then the title. Same glyph,
          same order, no word labels — this line should read the way the record
          reads everywhere else.
        */}
        <div className="panel-top">
          {card &&
            (editTitle === null ? (
              <h2 className="panel-title" onClick={() => setEditTitle(card.title)} title="Rename">
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
                    // Stops at the control it cancels. The panel's own guard is
                    // a `window` listener, so without this, backing out of a
                    // rename also closes the card — and now that the guard covers
                    // both editors, it would ask about text you were not editing.
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setEditTitle(null);
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      rename();
                    }
                  }}
                />
                <div className="titleedit-bar">
                  <Button
                    tone="primary"
                    size="small"
                    disabled={!editTitle.trim() || editTitle.trim() === card.title.trim()}
                    onClick={rename}
                  >
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
              title={`Delete "${card.title}" — the file is in git, so it can be recovered`}
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
              <Body card={card} write={write} onDirtyChange={setBodyDirty} />
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

                {/*
                    Not "Project". That word already names two other things within
                    one scroll — the axis above, which is the project this card is
                    a *member* of, and the mark by the title, which says the card
                    *is* one. This block is neither: it is what the card gets
                    *from* its membership, and the `key` and `chain` rows under it
                    already name which project that was. One word per idea, and
                    `ƒ` marks all three derived blocks rather than this one saying
                    the same thing in prose.
                */}
                {data.project && (
                  <section className="panel-section">
                    <h3>
                      Inherited
                      <span
                        className="derived"
                        title="resolved along the project facet and its chain, not stored on this card"
                      >
                        ƒ
                      </span>
                    </h3>
                    {/* The same `kv` list the workshop tier uses. These were two
                        key/value readouts drawn as two components, with two
                        gutters and two label sizes, a hairline apart in one
                        scroll — one pattern is one pattern. */}
                    <div className="proj">
                      <dl className="kv">
                        <dt>key</dt>
                        <dd><code>{data.project.key}</code></dd>
                        <dt>chain</dt>
                        <dd>{data.project.chain.join(' → ')}</dd>
                        {data.project.jira && (<><dt>jira</dt><dd><code>{data.project.jira}</code></dd></>)}
                        {data.project.branch && (<><dt>branch</dt><dd><code>{data.project.branch}</code></dd></>)}
                        {data.project.repos.map((r) => (
                          <Fragment key={r.path}>
                            <dt>repo</dt>
                            <dd><code>{r.path}</code>{r.base ? ` @ ${r.base}` : ''}</dd>
                          </Fragment>
                        ))}
                      </dl>
                      {data.project.instructions.length > 0 && (
                        <details>
                          <summary>{plural(data.project.instructions.length, 'instruction block')}</summary>
                          <pre className="instructions">{data.project.instructions.join('\n\n')}</pre>
                        </details>
                      )}
                    </div>
                  </section>
                )}
              </div>
            )}

            <div className="panel-tier is-workshop">
              <Frontmatter
                cardId={card.id}
                yaml={data.yaml}
                write={write}
                onDirtyChange={setFmDirty}
              />

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
