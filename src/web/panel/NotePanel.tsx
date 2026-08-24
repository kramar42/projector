import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { ProjectMark } from '../components/CardBody.tsx';
import { Button, IconButton } from '../components/Button.tsx';
import { usePanelWriter } from './usePanelWriter.ts';
import { Body, Facets, Frontmatter, Links, Refs } from './blocks.tsx';
import { plural } from '../plural.ts';
import type { NoteDTO, NoteDetail, Meta } from '../types.ts';
import { useTouched } from '../touched.tsx';
import { FLUSH_MS, whatMoved } from '../changed.ts';

/**
 * The open note.
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

/**
 * What `ƒ` means on a workshop row. One string, because it is now on five or more
 * of them and a per-row wording would be five chances to say it differently.
 */
const INHERITED = 'resolved along the project facet and its chain, not stored on this card';

/**
 * The project's instruction blocks, behind a disclosure the app draws itself.
 *
 * It was a `<details>`/`<summary>` — the only native disclosure left in the app,
 * against The Drawn Control Rule, which had audited three checkboxes and two
 * selects and missed this one. `.facet-more` is the button the panel and the rail
 * already use for "there is more of this list", which is the same sentence.
 */
function Instructions({ blocks }: { blocks: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="facet-more" onClick={() => setOpen((v) => !v)}>
        {open ? 'hide' : plural(blocks.length, 'instruction block')}
      </button>
      {open && <pre className="instructions">{blocks.join('\n\n')}</pre>}
    </>
  );
}

/**
 * How long a changed region stays washed: exactly as long as the flush, which is
 * `FLUSH_MS`. See it for why the two cannot differ. DESIGN.md's The Something Moved
 * Rule is what this serves; `changed.ts` holds the decisions it rests on.
 */
const HOLD_MS = FLUSH_MS;

export function NotePanel({
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
  const { data, error, reload } = useLive<NoteDetail>(() => api.card(id), [id]);
  const { touched } = useTouched();
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

  /**
   * Which parts of this note moved without you, held long enough to see.
   *
   * `useLive` keeps the outgoing payload until the next one lands, so both sides of
   * a change exist for exactly one commit — the ref catches the outgoing one. What
   * the diff *is* used for is the point: not a sentence, a set of keys, so the parts
   * that changed can light up and the reader's eye goes to the new value instead of
   * to a line of prose about it.
   *
   * **In state with a timer, not derived per render.** Derived was a bug with a
   * shape: the ref catches up in the very effect that reads it, so the diff was
   * non-empty for one render pass and empty on every render after — a single frame,
   * which reads as a blink rather than as a signal.
   *
   * The ordering it depends on: the provider's subscription runs synchronously in
   * the SSE handler while `reload()` is a fetch, so `touched(id)` is already true by
   * the time a new `card` arrives. Deps are `[card]` alone for that reason — this
   * asks its question at the moment the payload swaps, and nothing else.
   */
  const seen = useRef<NoteDTO | null>(null);
  const [moved, setMoved] = useState<string[]>([]);
  useEffect(() => {
    if (!card) return;
    const before = seen.current;
    seen.current = card;
    if (!before || !touched(card.id)) return;
    const keys = whatMoved(before, card);
    if (keys.length) setMoved(keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card]);

  // Long enough to notice, short enough that the surface goes still again on its
  // own. `HOLD_MS` outlives the wash so the class is never removed mid-animation.
  useEffect(() => {
    if (!moved.length) return;
    const t = setTimeout(() => setMoved([]), HOLD_MS);
    return () => clearTimeout(t);
  }, [moved]);

  /** Did this key just move? What the wash hangs off. */
  const lit = (key: string) => moved.includes(key);

  /**
   * Stop being a project, or start being one — and only one of those asks.
   *
   * The mark is a 15px glyph seven pixels from a title whose whole row opens the
   * rename editor, and clicking it used to write straight through. In the
   * destructive direction that write is `project: null`, which reaches
   * `doc.delete('project')` and takes the whole block: the repos `pj work` clones,
   * the branch template it names them from, the jira key and every instruction
   * block, plus whatever the notes downstream were inheriting. The panel's own
   * comment already claimed weight follows blast radius; this is the control it was
   * not true of.
   *
   * The other direction adds an empty block and is undone by clicking again, so it
   * asks nothing. Confirming both would train the answer.
   *
   * The prompt names the kinds rather than counting them. `data.project` is
   * resolved *along the chain*, so on a project that is itself inside another its
   * repos are a mix of its own and its ancestors' — a count taken from there would
   * be confidently wrong in exactly the case where the reader most needs it right.
   */
  const toggleProject = () => {
    if (!card) return;
    if (card.isProject) {
      const ok = confirm(
        `Stop "${card.title}" being a project?\n\n` +
          'This deletes its project block — the repos, the branch template, the jira key ' +
          'and any instruction blocks — and the notes that name it stop inheriting them.\n\n' +
          'The file is in git, so this is recoverable.',
      );
      if (!ok) return;
    }
    write.projectBlock(card.isProject ? null : {});
  };

  return (
    <>
      <div className="scrim" onClick={() => (held ? undefined : onClose())} />
      <aside className="panel" role="dialog" aria-label={card ? card.title : 'Card'}>
        {/*
          The one part of the panel that does not scroll, so it carries what a
          card face and a table row carry: the mark, then the title. Same glyph,
          same order, no word labels — this line should read the way the note
          reads everywhere else.
        */}
        <div className="panel-top">
          <div className="panel-head">
          {card &&
            (editTitle === null ? (
              <h2
                className={`panel-title ${lit('title') ? 'is-touched' : ''}`}
                onClick={() => setEditTitle(card.title)}
                title="Rename"
              >
                <ProjectMark card={card} onToggle={() => toggleProject()} />
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

          {/*
            One banner, from one fact. There used to be two states for one failure
            — a `problem` string and a `conflict` flag — and the flag was never
            cleared on a new attempt, so a rejected value rendered under "Changed
            on disk, probably a Claude session" with a Reload that fixed nothing.

            It lives inside the sticky head, which is the whole point. As a flow
            child of the scrolling panel it was the only report a refused write
            got, at a fixed distance from the top of a surface that runs to three
            screens — so a cycle refused by the `Project` picker, or a value the
            vocabulary rejected, produced no visible response at all from anywhere
            below the fold. `write.busy` was already up here: one write announced
            its start in a fixed place and its failure in a place that scrolled
            away.
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
        </div>

        {error && <div className="pane-error">{error}</div>}
        {!data && !error && <div className="pane-loading">loading…</div>}

        {data && card && (
          /*
           * Five tiers, not ten peers.
           *
           * The order is what the panel is opened for, and one rule decides it:
           * a region whose height the card controls goes above one whose height
           * the *content* controls. Otherwise the thing you came to click moves
           * every time a body gets longer or a project gains a child.
           *
           *   facets      the properties — bounded, and the commonest edit
           *   body        what the card says — unbounded, and why you came
           *   links       what it points at — unbounded
           *   refs        the notes it names, and the notes that name it
           *   workshop    the raw file, what it inherits, and the rare action
           *
           * Two of those moved. **Body is above Links** because the rule cannot
           * rank them — both are unbounded, five enriched links run to 400px —
           * so the tie breaks on what a card is for: PRODUCT.md asks that a card
           * carry enough context for a Claude session to start unbriefed, and
           * that context is the prose, not the link list.
           *
           * **Refs is one tier** holding every axis that points at a note and
           * both derived lists that point back. `Blocks` and `Blocked by` were
           * two names two letters apart with the whole body between them.
           *
           * `Delete` used to be the first control in the panel, above the card's
           * own id, at the same size as everything else. Weight follows blast
           * radius, so it sits in the header's far corner now — which is also
           * where the project toggle is, and that pairing is not ideal: see the
           * mark's own comment.
           */
          <div className="panel-body">
            <div className="panel-tier">
              <Facets defs={meta.facets} values={card.facets} write={write} lit={lit} />
            </div>

            <div className="panel-tier">
              <Body card={card} write={write} onDirtyChange={setBodyDirty} lit={lit('body')} />
            </div>

            <div className="panel-tier">
              <Links card={card} write={write} lit={lit('links')} />
            </div>

            <div className="panel-tier">
              <Refs defs={meta.facets} card={card} data={data} write={write} onOpen={onOpen} lit={lit} />
            </div>

            {/*
              The workshop: the raw file, everything the card inherits, and the
              one rare action.

              This was two `kv` readouts one hairline apart — `Inherited` with the
              project chain, and an unheaded pair of `file` and `updated` sitting
              under the `Frontmatter` heading as though they were what `edit raw`
              edits. Only one of them was. Both lists answer the same question,
              *what is true of this card that you do not set as a facet*, so they
              are one list, and `ƒ` marks the rows that are resolved rather than
              stored — which is the distinction the two headings were reaching for
              and getting wrong in opposite directions.

              Not headed "Project": that word already names the axis in Refs above
              and the mark by the title. One word per idea.
            */}
            <div className="panel-tier">
              <Frontmatter
                cardId={card.id}
                yaml={data.yaml}
                write={write}
                onDirtyChange={setFmDirty}
              >
                <dl className="kv">
                  {/* The id row is gone: it was the `?card=` parameter in the
                      address bar and the stem of the filename beside it, so the
                      same string appeared three times on the first fold. */}
                  <dt>file</dt>
                  <dd><code>{data.file}</code></dd>
                  {card.updated && (<><dt>updated</dt><dd>{card.updated}</dd></>)}
                  {data.project && (
                    <>
                      <dt>
                        key
                        <span className="computed" title={INHERITED}>ƒ</span>
                      </dt>
                      <dd><code>{data.project.key}</code></dd>
                      <dt>
                        chain
                        <span className="computed" title={INHERITED}>ƒ</span>
                      </dt>
                      <dd>{data.project.chain.join(' → ')}</dd>
                      {data.project.jira && (<><dt>jira<span className="computed" title={INHERITED}>ƒ</span></dt><dd><code>{data.project.jira}</code></dd></>)}
                      {data.project.branch && (<><dt>branch<span className="computed" title={INHERITED}>ƒ</span></dt><dd><code>{data.project.branch}</code></dd></>)}
                      {data.project.repos.map((r) => (
                        <Fragment key={r.path}>
                          <dt>repo<span className="computed" title={INHERITED}>ƒ</span></dt>
                          <dd><code>{r.path}</code>{r.base ? ` @ ${r.base}` : ''}</dd>
                        </Fragment>
                      ))}
                    </>
                  )}
                </dl>
                {data.project && data.project.instructions.length > 0 && (
                  <Instructions blocks={data.project.instructions} />
                )}
              </Frontmatter>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
