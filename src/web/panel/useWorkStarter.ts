import { useCallback, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { WorkResult } from '../types.ts';

/**
 * Starting work on the open note, from the panel.
 *
 * A sibling of `usePanelWriter` rather than a member of it, and the reason is the
 * rule that hook states about itself: every write it makes carries a base mtime,
 * because every write it makes changes a note file. This changes no note. It lays
 * out git worktrees under `$PROJECTOR_WORKSPACES` and writes a briefing beside
 * them, so there is no mtime to carry and nothing for the conflict machinery to
 * do — and folding it in would have made "every write carries a base" a sentence
 * with an exception in it.
 *
 * Two calls, both to the same route. The first is the plan and touches nothing;
 * it exists so the confirm can name the directory and the branch it is about to
 * create, which is the whole of the safety here — `!` is one keystroke, and a
 * dialog that only says "are you sure" would be a speed bump rather than
 * information. The second does it.
 */
export interface WorkStarter {
  /** Plan, confirm, prepare, open. Never rejects; failure lands in `banner`. */
  start(): void;
  /** What the head says while it is happening, in `panel-busy`'s words. */
  busy: string | null;
  banner: { tone: 'bad' | 'info'; message: string } | null;
}

/**
 * A refusal reads as one line in a banner, and the server's are written for a
 * terminal — three lines of instruction for an unset `workspaces`. Newlines
 * collapse in a `<div>` anyway, so they are joined deliberately rather than
 * rendered as a run of spaces.
 */
const oneLine = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');

function askAbout(title: string, plan: WorkResult): boolean {
  const repos = plan.repos.map((r) => `  · ${r.path}${r.base ? ` @ ${r.base}` : ''}`).join('\n');
  return confirm(
    `Start work on "${title}"?\n\n` +
      `workspace   ${plan.workspace}\n` +
      `branch      ${plan.branch}\n\n` +
      `A git worktree on that branch, in each of:\n${repos}\n\n` +
      `Then the workspace opens in Claude. Nothing in the vault is written.`,
  );
}

/** What a finished launch says: where it went, and anything that did not come. */
function outcome(done: WorkResult): { tone: 'bad' | 'info'; message: string } {
  const failed = (done.results ?? []).filter((r) => r.error);
  const prepared = (done.results ?? []).length - failed.length;
  const head = `${prepared} of ${done.results?.length} repos ready in ${done.workspace}`;
  return failed.length
    ? { tone: 'bad', message: `${head} — ${failed.map((r) => `${r.name}: ${r.error}`).join('; ')}` }
    : { tone: 'info', message: head };
}

export function useWorkStarter(o: { id: string; title: string }): WorkStarter {
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<WorkStarter['banner']>(null);
  // Read at call time, as `usePanelWriter` does: `!` builds no handler, but the
  // panel's own button is rebuilt every render and the two must not diverge.
  const live = useRef(o);
  live.current = o;
  // `!` is one keystroke and the dialog is modal to the tab, not to this hook —
  // so a second press while the first is still in flight has to be dropped here.
  const running = useRef(false);

  const start = useCallback(() => {
    if (running.current) return;
    running.current = true;
    const { id, title } = live.current;
    setBanner(null);
    setBusy('reading the plan');
    api
      .work(id, false)
      .then((plan) => {
        setBusy(null);
        if (!askAbout(title, plan)) return null;
        setBusy('preparing worktrees');
        return api.work(id, true);
      })
      .then((done) => {
        setBusy(null);
        if (!done) return;
        setBanner(outcome(done));
        /**
         * Following the link is the last thing, and it is a navigation rather
         * than a fetch: `claude://` is the desktop app's scheme, so the browser
         * hands it to the OS and this page stays exactly where it is — which is
         * why the banner above is set *first* and survives to be read.
         */
        if (done.link) window.location.href = done.link;
      })
      .catch((err: unknown) => {
        setBusy(null);
        setBanner({ tone: 'bad', message: oneLine((err as Error).message) });
      })
      .finally(() => {
        running.current = false;
      });
  }, []);

  return { start, busy, banner };
}
