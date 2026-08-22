import { useEffect, useMemo, useState } from 'react';
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
}: {
  cardId: string;
  value: string;
  /** Rejects on failure. A save that cannot fail is a save that can lose text. */
  onSave: (body: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

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
              setNote({ text: `attached ${plural(results.length, 'image')}` });
              setTimeout(() => setNote(null), 1800);
            })
            .catch((e: Error) => setNote({ text: e.message, bad: true }));
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
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Report false on the way out, so the panel's close guard is not left warning
  // about text that no longer exists — switching to `read` destroys the document.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const run = () => {
    save().then(
      () => {
        setNote({ text: 'saved' });
        setTimeout(() => setNote(null), 1400);
      },
      // A refusal is not a success and does not fade. It used to render in the
      // same slot and the same `ok` green as "saved", and then sit there — so the
      // one message telling you your text was *not* written looked like the one
      // telling you it was. The conflict case also says what to do about it:
      // the text is still here, and reloading is what would take it.
      (e: { message: string; conflict?: boolean }) =>
        setNote({
          text: e.conflict
            ? `${e.message} — nothing was written. Copy your text out before reloading.`
            : e.message,
          bad: true,
        }),
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
        {note && <span className={`editor-note ${note.bad ? 'is-bad' : ''}`}>{note.text}</span>}
        {dirty && <span className="editor-dirty">unsaved</span>}
      </div>
    </div>
  );
}
