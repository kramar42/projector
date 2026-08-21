import { useEffect, useRef, useState } from 'react';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { api } from '../api.ts';
import { Button } from './Button.tsx';

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
  onSave: (body: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const saved = useRef(value);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!host.current) return;

    const save = () => {
      const text = view.current?.state.doc.toString() ?? '';
      setSaving(true);
      onSave(text)
        .then(() => {
          saved.current = text;
          setDirty(false);
          setNote('saved');
          setTimeout(() => setNote(null), 1400);
        })
        .catch((e: Error) => setNote(e.message))
        .finally(() => setSaving(false));
      return true;
    };

    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            { key: 'Mod-s', run: save, preventDefault: true },
            { key: 'Mod-Enter', run: save, preventDefault: true },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          placeholder('Free-form markdown — description, links, checklists, pasted images.'),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(u.state.doc.toString() !== saved.current);
          }),
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
                  setNote(`attached ${results.length} image(s)`);
                  setTimeout(() => setNote(null), 1800);
                })
                .catch((e: Error) => setNote(e.message));
              return true;
            },
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor owns its document after mount; remounting on every keystroke
    // would fight CodeMirror's own state, so `cardId` alone is the dependency.
  }, [cardId]);

  // An external change (an agent editing the same file) replaces the document,
  // but only when there is nothing unsaved to lose.
  useEffect(() => {
    if (!view.current || dirty) return;
    if (value === view.current.state.doc.toString()) return;
    saved.current = value;
    view.current.dispatch({
      changes: { from: 0, to: view.current.state.doc.length, insert: value },
    });
  }, [value, dirty]);

  const save = () => {
    const text = view.current?.state.doc.toString() ?? '';
    setSaving(true);
    onSave(text)
      .then(() => {
        saved.current = text;
        setDirty(false);
        setNote('saved');
        setTimeout(() => setNote(null), 1400);
      })
      .catch((e: Error) => setNote(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="editor">
      <div ref={host} className="editor-host" />
      <div className="editor-bar">
        <Button tone="primary" onClick={save} disabled={!dirty || saving}>
          {saving ? 'saving…' : dirty ? 'Save' : 'Saved'}
        </Button>
        <span className="editor-hint">⌘S</span>
        {note && <span className="editor-note">{note}</span>}
        {dirty && <span className="editor-dirty">unsaved</span>}
      </div>
    </div>
  );
}
