import { useEffect, useRef, useState } from 'react';
import { KEYMAP } from '../view/keys.ts';
import { Button } from './components/Button.tsx';
import { useDialogFocus } from './components/useDialogFocus.ts';
import {
  cheatsheetKeyLabel,
  cheatsheetStrokeLabel,
  cheatsheetStrokeOf,
  matchesCheatsheetRow,
  type KeyboardLayout,
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
  const [layout, setLayout] = useState<KeyboardLayout | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog);

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
      if (/^(Shift|Control|Alt|Meta|CapsLock|AltGraph)$/.test(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setStroke(cheatsheetStrokeOf(event, layout ?? undefined));
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
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
                  const matching = matchesCheatsheetRow(row.keys, stroke, axisKeys);
                  return (
                    <div key={row.keys} className={`cheatsheet-row ${matching ? 'is-match' : ''}`}>
                      <dt>
                        {row.keys.split(' ').map((k) => (
                          <kbd
                            key={k}
                            className={matchesCheatsheetRow(k, stroke, axisKeys) ? 'is-match' : ''}
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
                  const matching = matchesCheatsheetRow('⟨axis⟩', stroke, [axis.key]);
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
            {stroke && <kbd className="is-match">{cheatsheetStrokeLabel(stroke)}</kbd>}
          </span>
          <Button tone="ghost" size="tiny" extra="cheatsheet-close" onClick={onClose}>
            close
          </Button>
        </div>
      </div>
    </>
  );
}
