import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView, placeholder } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { projectorHighlight } from './highlight.ts';
import { api } from '../api.ts';
import { plural } from '../plural.ts';
import { Button } from './Button.tsx';
import { useDocumentEditor } from './useDocumentEditor.ts';

/**
 * CodeMirror over the raw markdown, deliberately not a WYSIWYG.
 *
 * A ProseMirror-style editor round-trips through a document model and
 * re-serialises on save, which would silently reformat agent-authored files and
 * churn every diff. Here the text is the document: nothing changes except what
 * is typed.
 */
export function BodyEditor({
  cardId,
  value,
  onSave,
  onDirtyChange,
  onEscape,
}: {
  cardId: string;
  value: string;
  /** Rejects on failure. A save that cannot fail is a save that can lose text. */
  onSave: (body: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  /** Escape: hand the document back to whoever opened it. */
  onEscape?: () => void;
}) {
  /**
   * A success that fades, and a refusal that does not.
   *
   * One `note` with a `bad` flag put both in the same slot — mono `--text-meta`
   * wedged into the button bar beside "unsaved". The sibling editor on the same
   * panel, over the same `usePanelWriter` contract, draws its refusal as a
   * `.banner.is-bad` in the `.editor` column instead; one component reported one
   * event two ways. The banner is the register for "your text was not written",
   * so the refusal moves there and `note` keeps what it is good at.
   */
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const extensions = useMemo(
    () => [
      markdown(),
      syntaxHighlighting(projectorHighlight, { fallback: true }),
      placeholder('Free-form markdown — description, links, checklists, pasted images.'),
      // Paste an image and it lands in the card's own assets directory.
      EditorView.domEventHandlers({
        paste: (event, ev) => {
          const files = [...(event.clipboardData?.files ?? [])].filter((f) =>
            f.type.startsWith('image/'),
          );
          if (!files.length) return false;
          event.preventDefault();
          void Promise.all(files.map((f) => api.uploadAsset(cardId, f)))
            .then((results) => {
              const md = results.map((r) => `![](${r.path})`).join('\n');
              ev.dispatch(ev.state.replaceSelection(md));
              setNote(`attached ${plural(results.length, 'image')}`);
              setTimeout(() => setNote(null), 1800);
            })
            .catch((e: Error) => setRefused(e.message));
          return true;
        },
      }),
    ],
    [cardId],
  );

  const { hostRef, dirty, saving, save } = useDocumentEditor({
    docId: cardId,
    value,
    extensions,
    onSave,
    onEscape,
  });

  /**
   * Report the flag, and report clean on the way out.
   *
   * Both go through a ref, and that is the whole of the bug they fix. The exit
   * report used to be `useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])`
   * — an unmount cleanup keyed on a callback whose identity a caller has no
   * reason to keep stable. `NotePanel`'s blocks build theirs inline, so every
   * render produced a new one, the cleanup fired on every render rather than on
   * unmount, and the two effects drove each other: the first reported `true`, the
   * re-render that caused made a new callback, the cleanup reported `false`, and
   * that re-render re-ran the first. Typing one character in either editor hit
   * React's update-depth limit and blanked the page.
   *
   * A ref is the fix rather than `useCallback` at each call site, because the
   * hazard is in the contract: an effect that means "on unmount" must not take a
   * prop as a dependency, and no caller should have to know that to type safely.
   */
  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;

  useEffect(() => {
    report.current?.(dirty);
  }, [dirty]);

  // Report false on the way out, so the panel's close guard is not left warning
  // about text that no longer exists — closing the editor destroys the document.
  useEffect(() => () => report.current?.(false), []);

  const run = () => {
    save().then(
      () => {
        setRefused(null);
        setNote('saved');
        setTimeout(() => setNote(null), 1400);
      },
      // A refusal is not a success and does not fade. It used to render in the
      // same slot and the same `ok` green as "saved", and then sit there — so the
      // one message telling you your text was *not* written looked like the one
      // telling you it was. The conflict case also says what to do about it:
      // the text is still here, and reloading is what would take it.
      (e: { message: string; conflict?: boolean }) =>
        setRefused(
          e.conflict
            ? `${e.message} — nothing was written. Copy your text out before reloading.`
            : e.message,
        ),
    );
  };

  return (
    <div className="editor">
      <div ref={hostRef} className="editor-host" />
      <div className="editor-bar">
        <Button tone="primary" onClick={run} disabled={!dirty || saving}>
          {saving ? 'saving…' : dirty ? 'Save' : 'Saved'}
        </Button>
        <span className="editor-hint">⌘S</span>
        {note && <span className="editor-note">{note}</span>}
        {dirty && <span className="editor-dirty">unsaved</span>}
      </div>
      {/* Below the bar, in the `.editor` column — the placement
          `.editor > .banner { margin: 0 }` was written for and the frontmatter
          editor beside this one already uses. */}
      {refused && <div className="banner is-bad">{refused}</div>}
    </div>
  );
}
