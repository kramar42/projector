import { useEffect, useRef, useState } from 'react';
import { KEYMAP } from '../view/keys.ts';
import { IconButton } from './components/Button.tsx';
import { useDialogFocus } from './components/useDialogFocus.ts';
import {
  cheatsheetModifierLabel,
  cheatsheetKeyLabel,
  cheatsheetStrokeLabel,
  cheatsheetStrokeOf,
  matchesCheatsheetModifierRow,
  matchesCheatsheetModifierToken,
  matchesCheatsheetRow,
  type KeyboardLayout,
  type CheatsheetModifiers,
  type CheatsheetStroke,
} from './cheatsheetKeys.ts';
import type { Meta } from './types.ts';

/**
 * What the keyboard can do, read off the keyboard.
 *
 * The rows come from `KEYMAP` rather than being written again here, because a
 * cheatsheet that restates the bindings in its own words is exactly how one comes
 * to describe a key that was renamed a month ago. `keys.test.ts` holds the table
 * against the dispatcher from the other side: every plain key it lists has to be
 * one the dispatcher claims.
 *
 * The axis keys are the half no table could hold, and the reason this is a
 * component and not a static document. `p` means `priority` only because *this
 * vault* says so in `facets.yaml` — the client names no facet (C4) — so the list
 * is built from `meta.facets` at the moment it is drawn. Open a different vault
 * and it says something different, which is correct rather than a caveat.
 */
export function Cheatsheet({ meta, onClose }: { meta: Meta; onClose: () => void }) {
  const axes = Object.entries(meta.facets)
    .filter(([, def]) => def.key)
    .map(([, def]) => ({ key: def.key!, label: def.label, single: def.single }));
  const axisKeys = axes.map((axis) => axis.key);
  const [stroke, setStroke] = useState<CheatsheetStroke | null>(null);
  const [heldModifiers, setHeldModifiers] = useState<CheatsheetModifiers>({ altKey: false, shiftKey: false });
  const [layout, setLayout] = useState<KeyboardLayout | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const heldCode = useRef<string | null>(null);
  useDialogFocus(dialog);

  // The close control is the first tabbable item, but a modal opens as a
  // reading surface rather than as an action menu. Give the surface focus so
  // opening `?` does not make the close control look preselected.
  useEffect(() => {
    dialog.current?.focus();
  }, []);

  // `key` becomes a symbol under Option on macOS, so it cannot tell the sheet
  // whether a Dvorak reader pressed their labelled J. The browser's layout map
  // is the unmodified answer for that physical key and is also what the main
  // dispatcher uses for ⌥J/⌥K.
  useEffect(() => {
    let alive = true;
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<KeyboardLayout> } }).keyboard;
    void keyboard?.getLayoutMap?.().then((map) => alive && setLayout(map)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /**
   * The sheet is a practice surface, not a pass-through overlay. Capture at the
   * window so the application's dispatcher never sees a training key, while
   * leaving Escape alone for its existing topmost-surface close chain.
   */
  useEffect(() => {
    const capture = (event: KeyboardEvent) => {
      // Tab is navigation, not a stroke to rehearse. Let the dialog own its
      // ordinary focus loop so the sheet remains usable without its shortcuts.
      if (event.key === 'Escape' || event.key === 'Tab') return;
      if (event.key === 'Shift' || event.key === 'Alt' || event.key === 'AltGraph') {
        event.preventDefault();
        setHeldModifiers((current) => ({
          altKey: current.altKey || event.key === 'Alt' || event.key === 'AltGraph',
          shiftKey: current.shiftKey || event.key === 'Shift',
        }));
        return;
      }
      if (/^(Control|Meta|CapsLock)$/.test(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // The key is held state, not a history entry: release clears the same
      // physical key so the accent never claims a shortcut that is no longer down.
      setHeldModifiers({ altKey: event.altKey, shiftKey: event.shiftKey });
      setStroke(cheatsheetStrokeOf(event, layout ?? undefined));
    };
    const release = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') return;
      if (event.key === 'Shift' || event.key === 'Alt' || event.key === 'AltGraph') {
        setHeldModifiers((current) => ({
          altKey: event.key === 'Alt' || event.key === 'AltGraph' ? false : current.altKey,
          shiftKey: event.key === 'Shift' ? false : current.shiftKey,
        }));
        if (heldCode.current === null) setStroke(null);
        return;
      }
      if (/^(Control|Meta|CapsLock)$/.test(event.key)) return;
      setStroke((current) => (current && event.code === heldCode.current ? null : current));
      if (event.code === heldCode.current) heldCode.current = null;
    };
    const captureWithHeldKey = (event: KeyboardEvent) => {
      capture(event);
      if (!/^(Shift|Control|Alt|Meta|CapsLock|AltGraph|Escape|Tab)$/.test(event.key)) {
        heldCode.current = event.code;
      }
    };
    window.addEventListener('keydown', captureWithHeldKey, true);
    window.addEventListener('keyup', release, true);
    return () => {
      window.removeEventListener('keydown', captureWithHeldKey, true);
      window.removeEventListener('keyup', release, true);
    };
  }, [layout]);

  return (
    <>
      {/* Its own scrim class, because it has to sit above the note panel: the
          sheet is opened *from* wherever you are, including from an open card,
          and a shared `.scrim` at the panel's own depth left it half covered. */}
      <div className="scrim cheatsheet-scrim" onClick={onClose} />
      <div ref={dialog} className="cheatsheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1}>
        <div className="cheatsheet-grid">
          {KEYMAP.map((section) => (
            <section key={section.section} className="cheatsheet-block">
              <h3>{section.section}</h3>
              <dl>
                {section.rows.map((row) => {
                  const matching = stroke
                    ? matchesCheatsheetRow(row.keys, stroke, axisKeys)
                    : matchesCheatsheetModifierRow(row.keys, heldModifiers);
                  return (
                    <div key={row.keys} className={`cheatsheet-row ${matching ? 'is-match' : ''}`}>
                      <dt>
                        {row.keys.split(' ').map((k) => (
                          <kbd
                            key={k}
                            className={
                              (stroke
                                ? matchesCheatsheetRow(k, stroke, axisKeys)
                                : matchesCheatsheetModifierToken(k, heldModifiers))
                                ? 'is-match'
                                : ''
                            }
                          >
                            {cheatsheetKeyLabel(k)}
                          </kbd>
                        ))}
                      </dt>
                      <dd>{row.does}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}

          {/*
            This vault's own letters. Absent entirely when it declares none, which
            is a legitimate vault — the digits still reach whatever the board is
            grouped by, so the keyboard works with no vocabulary at all.
          */}
          <section className="cheatsheet-block">
            <h3>This vault</h3>
            {axes.length ? (
              <dl>
                {axes.map((axis) => {
                  const matching = stroke
                    ? matchesCheatsheetRow('⟨axis⟩', stroke, [axis.key])
                    : matchesCheatsheetModifierRow('⟨axis⟩', heldModifiers);
                  return (
                    <div key={axis.key} className={`cheatsheet-row ${matching ? 'is-match' : ''}`}>
                      <dt>
                        <kbd className={matching ? 'is-match' : ''}>{axis.key}</kbd>
                        <span className="cheatsheet-then">1–9</span>
                      </dt>
                      <dd>
                        {axis.label}
                        {/* Cardinality decides the verb, so it is the one thing
                            about an axis a reader has to know before pressing a
                            digit. `set` replaces; `add` never destroys. */}
                        <span className="cheatsheet-mode">{axis.single ? 'set' : 'add'}</span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <div className="emptystate">
                No axis declares a <code>key:</code> — add one in <code>facets.yaml</code> for the
                axes you keep reaching for.
              </div>
            )}
          </section>
        </div>
        <div className="cheatsheet-foot">
          <span className="cheatsheet-last-key" aria-live="polite">
            {stroke ? (
              <kbd className="is-match">{cheatsheetStrokeLabel(stroke)}</kbd>
            ) : (
              cheatsheetModifierLabel(heldModifiers) && (
                <kbd className="is-match">{cheatsheetModifierLabel(heldModifiers)}</kbd>
              )
            )}
          </span>
          <span className="cheatsheet-close">
            <IconButton
              glyph="close"
              aria-label="Close keyboard shortcuts"
              title="Close keyboard shortcuts"
              onClick={onClose}
            />
            <kbd>esc</kbd>
          </span>
        </div>
      </div>
    </>
  );
}
