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
  onEscape,
}: {
  /** Remount on this, and only this — the editor owns its document after mount. */
  docId: string;
  value: string;
  /** Language, placeholder, paste handling: whatever this document is. */
  extensions: Extension[];
  onSave: (text: string) => Promise<R>;
  /**
   * Leave the document — Escape.
   *
   * It has to be a keymap entry rather than the app's key chain, because
   * CodeMirror's content is `contentEditable` and the chain hands every key in a
   * field back to the field. That is the right rule; this is the field agreeing
   * to give one key back, which is the only way it can be given.
   *
   * Behind a ref for the same reason `onSave` is: the keymap is built once at
   * mount and would otherwise close over the callback of the render that mounted
   * it — the defect this module was extracted to stop happening twice.
   */
  onEscape?: () => void;
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
  /**
   * The text this editor wrote *over*, held until the reload carrying our own
   * write comes back. Nothing else can tell the two apart: the props say only
   * "here is the document", and for the length of a round trip that document is
   * the one we just replaced.
   */
  const superseded = useRef<string | null>(null);

  const save = (): Promise<R> => {
    const text = view.current?.state.doc.toString() ?? '';
    const previous = saved.current;
    setSaving(true);
    return onSave(text)
      .then((res) => {
        saved.current = text;
        superseded.current = previous;
        // Recomputed, not asserted. Nothing stops typing while the request is in
        // flight — a round trip is several keystrokes — and declaring the editor
        // clean over text the server never saw disarms the close guard and lets
        // the adopt effect below replace those keystrokes with the server's copy.
        setDirty((view.current?.state.doc.toString() ?? '') !== text);
        return res;
      })
      .finally(() => setSaving(false));
  };
  // Set during render, as `useLive` sets its own `loadRef`. The keymap below is
  // frozen at mount and reads through this, so it and the button are one function.
  const saveRef = useRef(save);
  saveRef.current = save;
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

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
            { key: 'Escape', run: () => (escapeRef.current?.(), true), preventDefault: true },
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
    // Our own write has not come back yet, so `value` is still the text it
    // replaced. Adopting it here would undo the save and then flip again when
    // the reload lands — a revert-and-restore flash on a surface whose one law
    // is stillness.
    if (superseded.current !== null && value === superseded.current) return;
    if (value === saved.current) superseded.current = null;
    if (value === view.current.state.doc.toString()) return;
    saved.current = value;
    view.current.dispatch({
      changes: { from: 0, to: view.current.state.doc.length, insert: value },
    });
  }, [value, dirty]);

  return { hostRef: host, dirty, saving, save: () => saveRef.current() };
}
