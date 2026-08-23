import { useState } from 'react';
import { Button } from './Button.tsx';

/**
 * Type a name, Enter or the button commits, Escape cancels.
 *
 * This existed twice — `SaveAsRow` in the sidebar and `SaveAs` on the canvas —
 * with identical state, identical key handling and an identically disabled button,
 * differing only in the wrapper's class and the placeholder. Two names for one
 * component is one of them free to drift.
 *
 * Deliberately not generalised past those two. `BoardView`'s new-card input and
 * `NotePanel`'s title edit share the Enter-commits convention but not the shape —
 * one also commits on blur, one is a multi-line textarea — and covering all four
 * would take three boolean props, which is the shape of a component that does not
 * know what it is.
 */
export function CommitInput({
  placeholder,
  label = 'Save',
  wrapper,
  onCancel,
  onCommit,
}: {
  placeholder: string;
  label?: string;
  /** The caller owns its own layout, so the wrapper element's class comes from it. */
  wrapper: { tag: 'div' | 'span'; className: string };
  onCancel: () => void;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const Tag = wrapper.tag;
  const commit = () => {
    if (text.trim()) onCommit(text.trim());
  };
  return (
    <Tag className={wrapper.className}>
      <input
        // One class, unconditionally. This used to be
        // `wrapper.tag === 'div' ? 'rail-input' : undefined`, which let the tag a
        // caller picked for layout decide how the field was painted and focused.
        className="field-recessed"
        autoFocus
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter') commit();
        }}
      />
      <Button tone="primary" size="small" disabled={!text.trim()} onClick={commit}>
        {label}
      </Button>
    </Tag>
  );
}
