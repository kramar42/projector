import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useLive } from '../useLive.ts';
import { ProjectMark } from '../components/CardBody.tsx';
import { Button, IconButton } from '../components/Button.tsx';
import { usePanelWriter } from './usePanelWriter.ts';
import { useWorkStarter } from './useWorkStarter.ts';
import { FoldDialog } from '../FoldDialog.tsx';
import { Body, Facets, Frontmatter, Links, Refs } from './blocks.tsx';
import { plural } from '../plural.ts';
import type { NoteDetailDTO, NoteDetail, Meta } from '../types.ts';
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
 * notes remounts the frame and every block — which means there is no list of
 * state to keep in step, and therefore no list that can fall two entries behind
 * the way the old one had (it enumerated six of nine, so opening a note from a
 * reflink while the body editor was dirty left the scrim dead and Escape
 * prompting about text that no longer existed).
 */

/**
 * What `ƒ` means on a workshop row. One string, because it is now on five or more
 * of them and a per-row wording would be five chances to say it differently.
 */
const INHERITED = 'resolved along the project facet and its chain, not stored on this note';

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

/**
 * The load, held above the reset.
 *
 * `NoteCard` is keyed on the id it is *showing*, not the id that was asked for.
 * That one word is the whole of "no blink": `useLive` keeps the outgoing payload
 * until the next lands, and the frame stays mounted on it — so walking `j` down a
 * list with the panel open turns the page rather than flashing `loading…` between
 * every pair of notes. Which is the same rule the board follows for a change of
 * query, stated in `useLive` itself.
 *
 * The key still does everything it did: the moment the new payload arrives the id
 * changes, the frame remounts, and every block's state goes with it. That was the
 * argument for keying the panel in the first place — nine pieces of state with no
 * list to keep in step — and moving the key one level in keeps it while letting
 * the fetch outlive it.
 */
export function NotePanel(props: {
  id: string;
  meta: Meta;
  onClose: () => void;
  onOpen: (id: string) => void;
  /** Walk `via` inward from this note and show what it reaches. */
  onFocus: (id: string, via: string) => void;
  onUnsaved: (u: { body: boolean; frontmatter: boolean }) => void;
}) {
  const { data, error, reload } = useLive<NoteDetail>(() => api.note(props.id), [props.id]);
  return (
    <NoteCard
      key={data?.note.id ?? props.id}
      {...props}
      // What is on screen, which during a switch is still the note you were
      // reading. Writes follow it rather than the id being fetched, so a keystroke
      // in the gap lands on the note under the cursor and not on one nobody has
      // seen yet.
      id={data?.note.id ?? props.id}
      data={data}
      error={error}
      reload={reload}
    />
  );
}

function NoteCard({
  id,
  meta,
  onClose,
  onOpen,
  onFocus,
  onUnsaved,
  data,
  error,
  reload,
}: {
  id: string;
  meta: Meta;
  onClose: () => void;
  onOpen: (id: string) => void;
  onFocus: (id: string, via: string) => void;
  /**
   * Tell the shell what is at risk here.
   *
   * The panel used to own an Escape listener of its own, which is why the title
   * editor still had to `stopPropagation` on a key it was handling itself —
   * backing out of a rename closed the note. There is one key chain now, and it
   * needs this one fact from in here to ask the right question.
   */
  onUnsaved: (u: { body: boolean; frontmatter: boolean }) => void;
  data: NoteDetail | null;
  error: string | null;
  reload: () => void;
}) {
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

  // Report upward rather than listening: see `onUnsaved`. Cleared on unmount, so
  // a closed panel cannot leave the chain thinking there is text to lose.
  useEffect(() => {
    onUnsaved(unsaved);
    return () => onUnsaved({ body: false, frontmatter: false });
  }, [unsaved, onUnsaved]);

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

  const card = data?.note;

  /**
   * Starting work: the one thing the panel does that writes nothing in the vault,
   * and so the one thing that is not `write`. See `useWorkStarter` for why the two
   * are siblings rather than one door.
   */
  const work = useWorkStarter({ id, title: card?.title ?? id });

  /**
   * Folding a candidate into the note it extends.
   *
   * `extends` is a built-in single-valued reference, so there is at most one
   * target and no picking to do. The merge itself is the existing bulk op — the
   * survivor keeps its own facets, the candidate contributes body, links and
   * fingerprint, and `schema/merge.ts` drops the reference that pointed here on
   * the way, so nothing has to be cleared first.
   *
   * Not part of `write`: every other panel write patches this note, and this one
   * ends it.
   */
  /**
   * Folding a candidate into the note it extends.
   *
   * `extends` is a built-in single-valued reference, so there is at most one
   * target and nothing to pick. What there *is* to decide is which of the
   * candidate's facets the target should take — `merged()` will not touch a label
   * on the survivor, correctly, so a sweep discovering that a ticket moved has no
   * other way to say so. `FoldDialog` asks; this only opens it.
   */
  const foldTarget = card?.facets?.extends?.[0] ?? null;
  const [folding, setFolding] = useState(false);

  /**
   * Whether this note is still waiting to be judged.
   *
   * Read off `intake` rather than off `extends`, which is the distinction the
   * fold control gets wrong on its own: a candidate judged *without* folding kept
   * its `extends`, and so kept a fold button for ever on a note that was no
   * longer a candidate. `accept` clears both, so the two controls now appear and
   * disappear together.
   */
  const unjudged = Boolean(card?.facets?.intake?.length);

  /** The head's one banner slot — see the comment where it renders. */
  const banner: { tone: string; message: string; canReload?: boolean } | null =
    write.banner ?? work.banner;

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
  const seen = useRef<NoteDetailDTO | null>(null);
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
          'This deletes its project block — the repos, the branch template and the jira key — ' +
          'and the notes that name it stop inheriting them, its AGENTS.md included.\n\n' +
          'The folder and every file in it stay where they are; only the block goes. ' +
          'The file is in git, so this is recoverable.',
      );
      if (!ok) return;
    }
    write.projectBlock(card.isProject ? null : {});
  };

  return (
    <>
      <div className="scrim" onClick={() => (held ? undefined : onClose())} />
      {/*
        No `role="dialog"`, and that is the decision rather than an omission.
        A dialog is a thing you answer and dismiss; this is a reading surface you
        keep open while `j` and `k` walk the cursor down the list behind it, and
        announcing it as a dialog would promise a focus trap that would break
        exactly that. It is an `<aside>`, which is what it is.
      */}
      <aside className="panel" aria-label={card ? card.title : 'Note'}>
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
              <h2 className={`panel-title ${lit('title') ? 'is-touched' : ''}`}>
                <ProjectMark card={card} onToggle={() => toggleProject()} />
                {/*
                  The text carries the rename, not the heading.
                  The heading already contains the project toggle — a real button —
                  and a button inside a button is invalid, so the affordance goes on
                  the one part of the row that is only text. It was an `onClick` on
                  the `h2` with a tooltip: no tab stop, no key handler, and a screen
                  reader announcing the heading as "Rename".
                */}
                <span
                  className="panel-title-text"
                  role="button"
                  tabIndex={0}
                  data-act="rename"
                  title="Rename"
                  onClick={() => setEditTitle(card.title)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    setEditTitle(card.title);
                  }}
                >
                  {card.title}
                </span>
              </h2>
            ) : (
              <div className="titleedit">
                <textarea
                  autoFocus
                  value={editTitle}
                  rows={2}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    // No `stopPropagation` any more, and that is the point: the
                    // shell's key chain treats a field's keys as the field's, so
                    // Escape never leaves this textarea. It used to be a window
                    // listener racing this handler, and backing out of a rename
                    // closed the note.
                    if (e.key === 'Escape') setEditTitle(null);
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
          {(write.busy ?? work.busy) && <span className="panel-busy">{write.busy ?? work.busy}…</span>}
          {/* The panel is closed by Escape or by clicking outside it, which is
              how it was actually being closed — so the corner goes to the two
              actions that had nowhere good to live: the one that ends this note's
              life and the one that starts its work. Both confirm, and only the
              first is drawn in `bad`.

              Start is to the left of the trash on the ordinary grounds — the
              destructive control sits at the very end, so a reach for the corner
              that overshoots lands on nothing rather than on Delete. */}
          {card && (
            <div className="panel-acts">
              {/*
                * Only on a candidate that wants folding in, which is the only
                * note the act means anything on. Drawn first — leftmost, furthest
                * from the trash — because it is the most ordinary thing you do to
                * a card in the queue, and because the destructive control keeps
                * the end of the row.
                *
                * Accepting a candidate and merging it are the same act here: the
                * survivor keeps its own facets, the candidate brings its body,
                * links and fingerprint, and its file goes. So the glyph is the
                * tick rather than something merge-shaped.
                */}
              {/*
                * Accept it as its own note. Drawn before the fold because it is
                * the answer to the plainer question — *is this a real thing?* —
                * and because a candidate the sweep proposed a target for may
                * still be genuinely new, so both controls have to be reachable
                * rather than one standing for the other.
                *
                * `add` rather than the tick: `+` is *make one*, and the tick
                * belongs to the fold, where you are literally ticking which
                * values survive the merge.
                */}
              {unjudged && (
                <IconButton
                  glyph="add"
                  size="normal"
                  extra="panel-x"
                  data-act="accept"
                  disabled={Boolean(write.busy)}
                  aria-label={`Accept ${card.title} as its own note`}
                  title="Accept this as its own note — the intake flag comes off, and the fold target with it (+)"
                  onClick={write.accept}
                />
              )}
              {foldTarget && (
                <IconButton
                  glyph="check"
                  size="normal"
                  extra="panel-x"
                  data-act="fold"
                  disabled={folding}
                  aria-label={`Fold ${card.title} into ${foldTarget}`}
                  title={`Fold this into "${foldTarget}" — decide what it changes, then its body, links and fingerprint move across (+)`}
                  onClick={() => setFolding(true)}
                />
              )}
              <IconButton
                glyph="start"
                size="normal"
                extra="panel-x"
                // The one control the `!` key presses. It aims at the button
                // rather than calling the hook itself, so there is one path from
                // the gesture to the act and the confirm cannot be skipped by
                // arriving from the keyboard.
                data-act="work"
                disabled={!!work.busy}
                aria-label={`Start work on ${card.title}`}
                title={`Start work on "${card.title}" — a worktree workspace and a Claude session (!)`}
                onClick={work.start}
              />
              <IconButton
                glyph="trash"
                tone="danger"
                size="normal"
                extra="panel-x"
                data-act="delete"
                aria-label={`Delete ${card.title}`}
                title={`Delete "${card.title}" — the file is in git, so it can be recovered (⌫)`}
                onClick={() => {
                  if (!confirm(`Delete "${card.title}"?\n\nThe file is in git, so this is recoverable.`))
                    return;
                  write.remove();
                }}
              />
            </div>
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

            **Still one banner**, now that two things can raise one. `write` wins
            when both have something to say, and the reason is which of the two is
            about *this file*: a refused write means the note on screen is not the
            note on disk, and that has to be readable until it is dealt with. A
            launch that failed cost nothing but the launch.
          */}
          {banner && (
          <div className={`banner is-${banner.tone}`}>
            {banner.canReload ? (
              <>
                <b>Changed on disk.</b> Something else — probably a Claude session — wrote this
                file after it was loaded here. Nothing was overwritten.
                <Button size="small" onClick={write.dismiss}>
                  Reload
                </Button>
              </>
            ) : (
              banner.message
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
           * a region whose height the note controls goes above one whose height
           * the *content* controls. Otherwise the thing you came to click moves
           * every time a body gets longer or a project gains a child.
           *
           *   facets      the properties — bounded, and the commonest edit
           *   body        what the note says — unbounded, and why you came
           *   links       what it points at — unbounded
           *   refs        the notes it names, and the notes that name it
           *   workshop    the raw file, what it inherits, and the rare action
           *
           * Two of those moved. **Body is above Links** because the rule cannot
           * rank them — both are unbounded, five enriched links run to 400px —
           * so the tie breaks on what a note is for: PRODUCT.md asks that a note
           * carry enough context for a Claude session to start unbriefed, and
           * that context is the prose, not the link list.
           *
           * **Refs is one tier** holding every axis that points at a note and
           * both derived lists that point back. `Blocks` and `Blocked by` were
           * two names two letters apart with the whole body between them.
           *
           * `Delete` used to be the first control in the panel, above the note's
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
              <Refs
                defs={meta.facets}
                card={card}
                data={data}
                write={write}
                onOpen={onOpen}
                // The panel does not own the query — the shell does — so a
                // derived row's focus control names the note and the relation
                // and lets `App` reshape the view. Same call the keyboard's
                // `gotoInverse` makes, so the two cannot drift apart.
                onFocus={(via) => onFocus(id, via)}
                lit={lit}
              />
            </div>

            {/*
              The workshop: the raw file, everything the note inherits, and the
              one rare action.

              This was two `kv` readouts one hairline apart — `Inherited` with the
              project chain, and an unheaded pair of `file` and `updated` sitting
              under the `Frontmatter` heading as though they were what `edit raw`
              edits. Only one of them was. Both lists answer the same question,
              *what is true of this note that you do not set as a facet*, so they
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
      {/* Outside the aside, so the scrim covers the panel it was opened from —
          the same depth the cheatsheet and the declined pile sit at. */}
      {folding && card && foldTarget && (
        <FoldDialog
          id={id}
          title={card.title}
          onClose={() => setFolding(false)}
          onFolded={(into) => {
            setFolding(false);
            // The candidate is gone; the survivor is what there is to look at.
            onOpen(into);
          }}
        />
      )}
    </>
  );
}
