import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Button } from '../components/Button.tsx';
import type { KernelNote } from '../types.ts';

/**
 * The note's line in the owner's kernel: the intent that speaks for it, what
 * the kernel reads, and the latest verdict with who gave it.
 *
 * Read-only except for one decision. When the latest verdict is a *draft* —
 * the intent still open and the verdict somebody else's — the owner answers it
 * here: **Accept** tells the kernel what the draft said — `met`, usually;
 * **Overrule** says `missed`; **Not yet** says `partial`, which keeps the
 * intent open. These are the owner's acts
 * in the owner's UI, so the server runs them as the owner. A verdict that
 * closes the intent is then written into the note as the value the vault's
 * `kernel.verdicts` maps it to, so the status chip agrees with the `kernel`
 * axis; the server does that (C4 — nothing here names a status), and the line
 * it reports — written, already so, or why not — is drawn under the row.
 *
 * The kernel answers with the line as it now reads, which this draws at once
 * rather than waiting for the refetch the server's change event starts.
 */
const READS: Record<string, string> = {
  open: 'open',
  draft: 'open, with a drafted verdict',
  met: 'met',
  missed: 'missed',
  dropped: 'dropped',
};

export function KernelLine({ id, kernel }: { id: string; kernel: KernelNote | null }) {
  const [line, setLine] = useState(kernel);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  // A refetch is newer than what the last answer said.
  useEffect(() => setLine(kernel), [kernel]);
  if (!line) return null;

  const answer = (decision: 'accept' | 'overrule', verdict?: 'missed' | 'partial') => {
    setBusy(decision);
    setProblem(null);
    setFiled(null);
    api
      .kernelDecide(id, decision, verdict)
      .then((res) => {
        setLine(res.kernel);
        setFiled(res.fileLine);
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const l = line.latest;
  const drafted = line.draft && l;
  return (
    <section className="panel-section" data-navlist="kernel" data-nav-flow="row">
      <h3>Kernel</h3>
      <dl className="kv">
        <dt>intent</dt>
        <dd>
          {line.statement || '(no statement)'} <code>{line.intent.slice(0, 8)}</code>
        </dd>
        <dt>reads</dt>
        <dd>{line.value ? READS[line.value] : line.status}</dd>
        {l && (
          <>
            <dt>{drafted ? 'drafted' : 'latest'}</dt>
            <dd>
              <b>{l.verdict}</b> by {l.by ?? 'someone'}
              {l.at ? ` on ${l.at.slice(0, 10)}` : ''}
              {l.note ? ` — ${l.note}` : ''}
            </dd>
          </>
        )}
      </dl>
      {drafted && (
        <div className="kernel-acts">
          <Button
            tone="primary"
            size="small"
            data-nav="kernel-accept"
            disabled={!!busy}
            title={`Accept the draft — the kernel records the intent as ${l.verdict}, from you`}
            onClick={() => answer('accept')}
          >
            Accept: {l.verdict}
          </Button>
          {/* Overruling a draft of `missed` with `missed` would be agreeing with it. */}
          {l.verdict !== 'missed' && (
            <Button
              size="small"
              data-nav="kernel-overrule"
              disabled={!!busy}
              title="Overrule the draft — the kernel records the intent as missed, from you"
              onClick={() => answer('overrule', 'missed')}
            >
              Overrule: missed
            </Button>
          )}
          <Button
            tone="ghost"
            size="small"
            data-nav="kernel-partial"
            disabled={!!busy}
            title="Overrule the draft as partial — the intent stays open"
            onClick={() => answer('overrule', 'partial')}
          >
            Not yet
          </Button>
          {busy && <span className="panel-busy">telling the kernel…</span>}
        </div>
      )}
      {filed && <div className="panel-busy">{filed}</div>}
      {problem && <div className="banner is-bad">{problem}</div>}
    </section>
  );
}
