import { useEffect, useRef, useState } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { yaml as yamlMode } from '@codemirror/legacy-modes/mode/yaml';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { ApiError } from '../api.ts';

/**
 * Direct frontmatter editing.
 *
 * The chip-and-toggle UI only covers what it models — title, facets, links,
 * parent. The file can hold more than that: a `project:` block with repos and a
 * branch template, `repos_replace`, keys added later. Since the file is the
 * source of truth, the app must never be able to express less than it, so this
 * is the escape hatch for everything the panel does not draw.
 *
 * The server validates before writing and refuses on anything the indexer would
 * reject, so a bad edit fails loudly instead of producing a broken card.
 */
export function FrontmatterEditor({
  cardId,
  yaml,
  onSave,
  onSaved,
}: {
  cardId: string;
  yaml: string;
  onSave: (yaml: string) => Promise<{ warnings?: string[] }>;
  onSaved?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const saved = useRef(yaml);

  const doSave = () => {
    const text = view.current?.state.doc.toString() ?? '';
    setSaving(true);
    setProblem(null);
    onSave(text)
      .then((res) => {
        saved.current = text;
        setDirty(false);
        setWarnings(res.warnings ?? []);
        onSaved?.();
      })
      .catch((e: ApiError) => setProblem(e.message))
      .finally(() => setSaving(false));
  };
  const saveRef = useRef(doSave);
  saveRef.current = doSave;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: yaml,
        extensions: [
          history(),
          keymap.of([
            { key: 'Mod-s', run: () => (saveRef.current(), true), preventDefault: true },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          StreamLanguage.define(yamlMode),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(u.state.doc.toString() !== saved.current);
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  // Adopt an external change only when there is nothing unsaved to lose.
  useEffect(() => {
    if (!view.current || dirty) return;
    if (yaml === view.current.state.doc.toString()) return;
    saved.current = yaml;
    view.current.dispatch({
      changes: { from: 0, to: view.current.state.doc.length, insert: yaml },
    });
  }, [yaml, dirty]);

  return (
    <div className="editor">
      <p className="hint">
        The whole frontmatter, as it sits in the file. Validated on save — a bad edit is refused, not
        written. <code>id</code> cannot be changed here, because other records' edges point at it.
      </p>
      <div ref={host} className="editor-host is-yaml" />
      <div className="editor-bar">
        <button className="btn primary" onClick={doSave} disabled={!dirty || saving}>
          {saving ? 'saving…' : dirty ? 'Save frontmatter' : 'Saved'}
        </button>
        <span className="editor-hint">⌘S</span>
        {dirty && <span className="editor-dirty">unsaved</span>}
      </div>
      {problem && <div className="banner is-bad">{problem}</div>}
      {warnings.length > 0 && (
        <div className="banner is-conflict">
          Saved, with warnings: {warnings.join('; ')}
        </div>
      )}
    </div>
  );
}
