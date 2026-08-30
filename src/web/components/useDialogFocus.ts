import { useEffect, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function controls(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (control) => !control.hidden && control.getClientRects().length > 0,
  );
}

/**
 * Keeps a true modal's Tab walk inside its surface and returns focus to what
 * opened it. Pointer-only scrims look modal, but without this the next Tab can
 * quietly move behind them; that is confusing for keyboard and screen-reader
 * users alike.
 */
export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focus = controls(dialog);
    if (!dialog.contains(document.activeElement)) (focus[0] ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = controls(dialog);
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [dialogRef]);
}
