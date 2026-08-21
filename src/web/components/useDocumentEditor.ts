import { useEffect, useRef, useState } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';

/**
 * A CodeMirror document that saves, held for one card.
 *
 * The two editors in this app — the card body and the raw frontmatter — differ in
 * their language, their chrome and what a save returns, and share about forty-five
 * lines of mechanism: mount the view, track dirty against the last saved text,
 * adopt an external change, and run one save reachable from both a key and a
 * button. Unifying the *components* would need a dozen parameters, nine of them
 * one-use, which is an interface the size of what it hides. Unifying the mechanism
 * needs four.
 *
 * Two things make it worth extracting rather than leaving as a duplicated block.
 *
 * **The save must live behind a ref.** The keymap is built once, at mount, so it
 * closes over the `onSave` of the render that mounted it. The body editor wrote
 * its save twice — once inside the mount effect for ⌘S and once during render for
 * the button — so the two diverged the moment anything else in the panel wrote,
 * and ⌘S started failing while the button beside it worked.
 *
 * **The adopt rule has a partner.** Declining to adopt an incoming document while
 * dirty is what protects unsaved text; `heldBase` in the panel's writer freezes
 * the write's base mtime on *exactly* that condition, so what is saved is gated on
 * the read the document actually came from. Two copies of the adopt rule would be
 * two chances for one of them to drift out from under the thing that makes a
 * concurrent agent edit a refusal rather than a silent overwrite.
 */
export function useDocumentEditor<R>({
  docId,
  value,
  extensions,
  onSave,
}: {
  /** Remount on this, and only this — the editor owns its document after mount. */
  docId: string;
  value: string;
  /** Language, placeholder, paste handling: whatever this document is. */
  extensions: Extension[];
  onSave: (text: string) => Promise<R>;
}): {
  hostRef: React.RefObject<HTMLDivElement | null>;
  dirty: boolean;
  saving: boolean;
  /** Resolves with the save's result, or rejects — the caller renders the outcome. */
  save: () => Promise<R>;
} {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const saved = useRef(value);

  const save = (): Promise<R> => {
    const text = view.current?.state.doc.toString() ?? '';
    setSaving(true);
    return onSave(text)
      .then((res) => {
        saved.current = text;
        setDirty(false);
        return res;
      })
      .finally(() => setSaving(false));
  };
  // Set during render, as `useLive` sets its own `loadRef`. The keymap below is
  // frozen at mount and reads through this, so it and the button are one function.
  const saveRef = useRef(save);
  saveRef.current = save;

  const extRef = useRef(extensions);
  extRef.current = extensions;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            { key: 'Mod-s', run: () => (void saveRef.current(), true), preventDefault: true },
            { key: 'Mod-Enter', run: () => (void saveRef.current(), true), preventDefault: true },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(u.state.doc.toString() !== saved.current);
          }),
          ...extRef.current,
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor owns its document after mount; remounting on every keystroke
    // would fight CodeMirror's own state, so `docId` alone is the dependency.
  }, [docId]);

  // An external change — an agent editing the same file — replaces the document,
  // but only when there is nothing unsaved to lose. See `heldBase`: while this
  // declines, the write's base mtime stays where this document came from.
  useEffect(() => {
    if (!view.current || dirty) return;
    if (value === view.current.state.doc.toString()) return;
    saved.current = value;
    view.current.dispatch({
      changes: { from: 0, to: view.current.state.doc.length, insert: value },
    });
  }, [value, dirty]);

  return { hostRef: host, dirty, saving, save: () => saveRef.current() };
}
