import { useEffect, useMemo, useState } from 'react';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { projectorHighlight } from './highlight.ts';
import { yaml as yamlMode } from '@codemirror/legacy-modes/mode/yaml';
import { ApiError } from '../api.ts';
import { Button } from './Button.tsx';
import { useDocumentEditor } from './useDocumentEditor.ts';

/**
 * Direct frontmatter editing.
 *
 * The chip-and-toggle UI only covers what it models — title, facets, links,
 * parent, due. The file can hold more than that: a `project:` block with repos
 * and a branch template, keys added later. Since the file is the source of
 * truth, the app must never be able to express less than it, so this is the
 * escape hatch for everything the panel does not draw.
 *
 * The server validates before writing and refuses on anything the indexer would
 * reject, so a bad edit fails loudly instead of producing a broken card.
 */
export function FrontmatterEditor({
  cardId,
  yaml,
  onSave,
  onDirtyChange,
}: {
  cardId: string;
  yaml: string;
  onSave: (yaml: string) => Promise<{ warnings: string[] }>;
  /**
   * Reported up so the panel's close guard covers this editor too. It did not:
   * only the body reported, so unsaved YAML was discarded by Escape or a scrim
   * click with no prompt — on the one pane the app calls the escape hatch for
   * everything the chips cannot express.
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const extensions = useMemo(
    () => [
      StreamLanguage.define(yamlMode),
      syntaxHighlighting(projectorHighlight, { fallback: true }),
    ],
    [],
  );

  const { hostRef, dirty, saving, save } = useDocumentEditor({
    docId: cardId,
    value: yaml,
    extensions,
    onSave,
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Closing the disclosure destroys the document, so the flag must not outlive it.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const run = () => {
    // The attempt, not its outcome, invalidates the previous answer — otherwise a
    // "Saved, with warnings" from two saves ago sits under a fresh failure. Same
    // rule `nextStatus` applies to the panel's banner.
    setProblem(null);
    setWarnings([]);
    save().then(
      (res) => setWarnings(res.warnings),
      (e: ApiError) => setProblem(e.message),
    );
  };

  return (
    <div className="editor">
      {/* One line, not four. "The whole frontmatter, as it sits in the file" is
          what the pane visibly is, and "validated on save, a bad edit is
          refused" is what the refusal says when it happens. The `id` rule is the
          only part that has to be known *before* typing. */}
      <p className="hint">
        <code>id</code> is fixed — other records' edges point at it.
      </p>
      <div ref={hostRef} className="editor-host is-yaml" />
      <div className="editor-bar">
        <Button tone="primary" onClick={run} disabled={!dirty || saving}>
          {saving ? 'saving…' : dirty ? 'Save frontmatter' : 'Saved'}
        </Button>
        <span className="editor-hint">⌘S</span>
        {dirty && <span className="editor-dirty">unsaved</span>}
      </div>
      {problem && <div className="banner is-bad">{problem}</div>}
      {warnings.length > 0 && (
        <div className="banner is-conflict">Saved, with warnings: {warnings.join('; ')}</div>
      )}
    </div>
  );
}
