import { useEffect, useState } from 'react';
import { KEYMAP } from '../view/keys.ts';
import {
  cheatsheetKeyLabel,
  cheatsheetStrokeLabel,
  cheatsheetStrokeOf,
  matchesCheatsheetRow,
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

  /**
   * The sheet is a practice surface, not a pass-through overlay. Capture at the
   * window so the application's dispatcher never sees a training key, while
   * leaving Escape alone for its existing topmost-surface close chain.
   */
  useEffect(() => {
    const capture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return;
      if (/^(Shift|Control|Alt|Meta|CapsLock|AltGraph)$/.test(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setStroke(cheatsheetStrokeOf(event));
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, []);

  return (
    <>
      {/* Its own scrim class, because it has to sit above the note panel: the
          sheet is opened *from* wherever you are, including from an open card,
          and a shared `.scrim` at the panel's own depth left it half covered. */}
      <div className="scrim cheatsheet-scrim" onClick={onClose} />
      <div className="cheatsheet" aria-label="Keyboard shortcuts">
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
          <span className="cheatsheet-close">esc to close</span>
        </div>
      </div>
    </>
  );
}
