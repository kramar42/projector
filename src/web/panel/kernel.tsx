import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Button } from '../components/Button.tsx';
import type { Ask, KernelNote } from '../types.ts';

/**
 * The note's line in the owner's kernel: the intent about it, what the kernel
 * reads, and the latest verdict with who gave it.
 *
 * **An intent is a layer over the note, never a copy of it.** The note's status
 * stays in its file; an intent is the owner asking the kernel for help with the
 * note, or to be held to it. So a note with no intent offers one — what should
 * happen, how to judge it, when it is due — and the kernel holds it from then on
 * (`POST /api/note/:id/intent`, as the owner).
 *
 * **The owner's verdicts, here.** An open intent takes the owner's word: met,
 * not yet (`partial`, still open), missed or dropped. A *draft* — the intent
 * still open and the latest verdict somebody else's — is answered by
 * accepting what it said or overruling it.
 *
 * **When the two part ways, it asks** (`ask`, derived on the server — `askOf`):
 * the note was closed while its intent is open, so judge the intent? Or the
 * intent was closed while the note is not, so set the note's lifecycle? Each
 * answer is the owner's write on its own side; neither side writes the other.
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

type Verdict = 'met' | 'partial' | 'missed' | 'dropped';

export function KernelLine({
  id,
  title,
  kernel,
  ask,
  on,
  setFacet,
}: {
  id: string;
  title: string;
  kernel: KernelNote | null;
  ask: Ask | null;
  /** The vault has a kernel to open an intent in. */
  on: boolean;
  /** The note's own write, for an ask the owner answers on the note's side. */
  setFacet: (name: string, values: string[]) => void;
}) {
  const [line, setLine] = useState(kernel);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // A refetch is newer than what the last answer said.
  useEffect(() => setLine(kernel), [kernel]);
  useEffect(() => setOpening(false), [id]);
  if (!on && !line) return null;

  const answer = (verdict: Verdict) => {
    setBusy(verdict);
    setProblem(null);
    const drafted = line?.draft && line.latest ? line.latest.verdict : null;
    // Saying what the draft said is accepting it; anything else, or no draft, is the owner's own word.
    const call =
      verdict === 'met' || verdict === drafted ? api.kernelDecide(id, 'accept') : api.kernelDecide(id, 'overrule', verdict);
    call
      .then((res) => setLine(res.kernel))
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const live = !!line && (line.status === 'open' || line.status === 'proposed');
  const l = line?.latest;
  const drafted = line?.draft && l ? l : null;
  return (
    <section className="panel-section" data-navlist="kernel" data-nav-flow="row">
      <h3>Kernel</h3>
      {line && (
        <dl className="kv">
          <dt>intent</dt>
          <dd>
            {line.statement || '(no statement)'} <code>{line.intent.slice(0, 8)}</code>
          </dd>
          <dt>reads</dt>
          <dd>{line.value ? READS[line.value] : line.status}</dd>
          {line.horizon && (
            <>
              <dt>due</dt>
              <dd>{line.horizon}</dd>
            </>
          )}
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
      )}

      {ask?.kind === 'judge' && line?.status === 'open' && (
        <div className="banner is-info">This note is {ask.value}, and its intent is still open — what became of it?</div>
      )}
      {line?.status === 'open' && (
        <div className="kernel-acts">
          {drafted ? (
            <>
              <Button
                tone="primary"
                size="small"
                data-nav="kernel-accept"
                disabled={!!busy}
                title={`Accept the draft — the kernel records the intent as ${drafted.verdict}, from you`}
                onClick={() => answer(drafted.verdict as Verdict)}
              >
                Accept: {drafted.verdict}
              </Button>
              {/* Overruling a draft of `missed` with `missed` would be agreeing with it. */}
              {drafted.verdict !== 'missed' && (
                <Button
                  size="small"
                  data-nav="kernel-overrule"
                  disabled={!!busy}
                  title="Overrule the draft — the kernel records the intent as missed, from you"
                  onClick={() => answer('missed')}
                >
                  Overrule: missed
                </Button>
              )}
            </>
          ) : (
            <>
              <Button
                tone={ask ? 'primary' : undefined}
                size="small"
                data-nav="kernel-met"
                disabled={!!busy}
                title="The intent is met — from you"
                onClick={() => answer('met')}
              >
                Met
              </Button>
              <Button size="small" data-nav="kernel-missed" disabled={!!busy} title="The intent was missed — from you" onClick={() => answer('missed')}>
                Missed
              </Button>
              <Button size="small" data-nav="kernel-dropped" disabled={!!busy} title="Drop the intent — from you" onClick={() => answer('dropped')}>
                Dropped
              </Button>
            </>
          )}
          <Button
            tone="ghost"
            size="small"
            data-nav="kernel-partial"
            disabled={!!busy}
            title="Partly there — the intent stays open"
            onClick={() => answer('partial')}
          >
            Not yet
          </Button>
          {busy && <span className="panel-busy">telling the kernel…</span>}
        </div>
      )}

      {ask?.kind === 'close' && (
        <div className="kernel-acts">
          <span>
            The intent is {ask.verdict}, and the note is not closed. Set {ask.axis}:
          </span>
          {ask.values.map((v) => (
            <Button
              key={v}
              size="small"
              data-nav={`kernel-set-${v}`}
              title={`Set ${ask.axis} to ${v} — the note's own write`}
              onClick={() => setFacet(ask.axis, [v])}
            >
              {v}
            </Button>
          ))}
        </div>
      )}

      {on && !live && !opening && (
        <div className="kernel-acts">
          <Button
            size="small"
            data-nav="kernel-intent"
            title="Ask the kernel for help with this note, or to hold you to it"
            onClick={() => setOpening(true)}
          >
            {line ? 'New intent…' : 'Add intent…'}
          </Button>
        </div>
      )}
      {on && !live && opening && (
        <IntentForm
          id={id}
          title={title}
          onOpened={(k) => {
            setLine(k);
            setOpening(false);
          }}
          onCancel={() => setOpening(false)}
        />
      )}
      {problem && <div className="banner is-bad">{problem}</div>}
    </section>
  );
}

/** What should happen, how to judge it, and when — the owner's intent about this note. */
function IntentForm({
  id,
  title,
  onOpened,
  onCancel,
}: {
  id: string;
  title: string;
  onOpened: (k: KernelNote | null) => void;
  onCancel: () => void;
}) {
  const [statement, setStatement] = useState(title);
  const [criterion, setCriterion] = useState('');
  const [horizon, setHorizon] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    if (!statement.trim()) return;
    setBusy(true);
    setProblem(null);
    api
      .kernelIntent(id, { statement, criterion, horizon })
      .then((res) => onOpened(res.kernel))
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <form
      className="kernel-intent"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        // The panel's own keys stay out of a form being typed in; Escape leaves it.
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
      }}
    >
      <label>
        <span>what should happen</span>
        <input className="field-recessed" autoFocus value={statement} onChange={(e) => setStatement(e.target.value)} />
      </label>
      <label>
        <span>how to judge it</span>
        <input className="field-recessed" value={criterion} placeholder="Done when …" onChange={(e) => setCriterion(e.target.value)} />
      </label>
      <label>
        <span>due</span>
        <input className="field-recessed" type="date" value={horizon} onChange={(e) => setHorizon(e.target.value)} />
      </label>
      <div className="kernel-acts">
        <Button tone="primary" size="small" type="submit" disabled={busy || !statement.trim()}>
          Open intent
        </Button>
        <Button tone="ghost" size="small" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {busy && <span className="panel-busy">telling the kernel…</span>}
      </div>
      {problem && <div className="banner is-bad">{problem}</div>}
    </form>
  );
}
