import { settingsFor, type Settings } from '../settings.ts';
import { ingest, noteAlias, spawnRunner, vaultName, type Runner } from '../intake/kernel.ts';
import { paths } from '../config.ts';
import { readAll } from '../index/indexer.ts';
import { forgetKernel, kernelIndex } from './read.ts';
import { kernelEnv, said } from './query.ts';
import { shortId, type KernelNote } from './state.ts';

/**
 * The owner's two writes to the kernel about a note: opening an intent about it
 * (`<kernel.bin> capture … --about vault:<vault>:<id>`), and judging that intent
 * (`<kernel.bin> judge <intent> <verdict> [--note text]`).
 *
 * **Always as the owner.** The kernel's CLI writes as its owner unless told
 * otherwise, and nothing here tells it otherwise: every write on this page is
 * something the owner did in the owner's own UI or shell — opening an intent,
 * accepting a draft, overruling it, answering the panel's ask. No agent reaches
 * it, and the intake sink, which *is* an agent, stays on `ingest` and its
 * proposals.
 *
 * **Never the note.** An intent is a layer over the vault, not a copy of its
 * state (C1, C11): a verdict here writes nothing into a file, and a status set
 * in a file judges nothing here. When the two part ways the panel asks
 * (`askOf`), and the owner answers on whichever side they choose.
 */

export type JudgeVerdict = 'met' | 'missed' | 'dropped' | 'partial';

export type Judged = { ok: true; said: string } | { ok: false; reason: string };

/** One judgment, as the owner. Never throws. */
export async function judge(
  cfg: Settings['kernel'],
  intent: string,
  verdict: JudgeVerdict,
  note: string | null,
  run: Runner = spawnRunner,
): Promise<Judged> {
  if (!cfg.bin) return { ok: false, reason: 'kernel.bin is not set' };
  try {
    const { code, stdout, stderr } = await run(
      cfg.bin,
      ['judge', intent, verdict, ...(note ? ['--note', note] : [])],
      '',
      kernelEnv(cfg),
      cfg.timeoutSeconds * 1000,
    );
    if (code !== 0) return { ok: false, reason: `kernel judge ${said(code, stdout, stderr)}` };
    return { ok: true, said: stdout.trim().split('\n').pop() ?? '' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------ accept · overrule

export type Decision = 'accept' | 'overrule';

/** What an overrule may say. `partial` keeps the intent open; the other two close it. */
export type OverruleVerdict = 'missed' | 'dropped' | 'partial';
export const OVERRULE_VERDICTS: readonly OverruleVerdict[] = ['missed', 'dropped', 'partial'];

export type Decided =
  | { ok: true; note: string; intent: string; verdict: JudgeVerdict; said: string; kernel: KernelNote | null }
  | { ok: false; note: string; reason: string };

/**
 * The owner's verdict on a note's open intent: accept is `met` (or the drafted
 * verdict, when there is a draft); overrule is `missed` or `dropped`, or
 * `partial` to say "not yet" and keep the intent open.
 *
 * Refused, not attempted, when there is nothing to answer: the vault has no
 * kernel, the note has no intent, or the intent is no longer open — the kernel
 * would refuse most of those too, but a reason that names the note reads better
 * than one that names a uuid. After a write the cache is forgotten and the
 * kernel asked again, so what comes back is what the kernel now says.
 */
export async function decide(
  root: string,
  id: string,
  decision: Decision,
  opts: { verdict?: OverruleVerdict; note?: string; run?: Runner } = {},
): Promise<Decided> {
  const cfg = settingsFor(root).kernel;
  if (!cfg.enabled) return { ok: false, note: id, reason: 'this vault has no kernel: block with enabled: true' };
  const run = opts.run ?? spawnRunner;
  const before = await kernelIndex(root, 'owner-answer', { fresh: true, run });
  if (before.reason) return { ok: false, note: id, reason: before.reason };
  const k = before.notes.get(id);
  if (!k) return { ok: false, note: id, reason: `${id} has no intent in the kernel` };
  if (k.status !== 'open') {
    return { ok: false, note: id, reason: `${id}'s intent ${shortId(k.intent)} is ${k.status}, not open — there is nothing to ${decision}` };
  }

  // Accepting a draft says what the draft said — `met`, which is the draft an
  // agent finishing work writes, or the `missed`/`dropped` it drafted instead,
  // because writing `met` over a draft of `missed` would invert it. With no
  // draft, accept is the owner saying `met` outright.
  const verdict: JudgeVerdict =
    decision === 'accept' ? (k.draft && k.latest ? (k.latest.verdict as JudgeVerdict) : 'met') : (opts.verdict ?? 'missed');
  const draft = k.draft && k.latest ? `${k.latest.by ?? 'someone'}'s ${k.latest.verdict}` : null;
  const note =
    opts.note ??
    (decision === 'accept'
      ? draft ? `accepted ${draft} in projector` : 'met, said in projector'
      : draft ? `overruled ${draft} in projector` : `${verdict}, said in projector`);

  const res = await judge(cfg, k.intent, verdict, note, run);
  forgetKernel(root);
  if (!res.ok) return { ok: false, note: id, reason: res.reason };
  const after = await kernelIndex(root, 'owner-answer', { fresh: true, run });
  return { ok: true, note: id, intent: k.intent, verdict, said: res.said, kernel: after.notes.get(id) ?? null };
}

// ------------------------------------------------------------ an intent about a note

export interface IntentAsk {
  /** What should be true. Absent, the note's title. */
  statement?: string;
  /** How to judge it met. Absent, the kernel takes the statement. */
  criterion?: string;
  /** YYYY-MM-DD, when it is due. */
  horizon?: string;
}

export type Opened =
  | { ok: true; note: string; intent: string; said: string; kernel: KernelNote | null }
  | { ok: false; note: string; reason: string };

/**
 * Open an intent about a note, as the owner: the owner's entry point into
 * asking the kernel for help with it, or to be held to it. The note's entity
 * goes first (`ingest`, kind `note`, named by its title) because the kernel's
 * `capture --about` names only an entity it holds, and a thought the vault never
 * recorded has none yet; then `<kernel.bin> capture <statement> [--criterion c]
 * [--horizon d] --about vault:<vault>:<id>`.
 *
 * Refused when the vault has no kernel, the note does not exist, or an intent
 * about it is still open — one at a time, so the panel's line has one answer.
 * Never throws.
 */
export async function openIntent(root: string, id: string, ask: IntentAsk, opts: { run?: Runner } = {}): Promise<Opened> {
  const settings = settingsFor(root);
  const cfg = settings.kernel;
  if (!cfg.enabled) return { ok: false, note: id, reason: 'this vault has no kernel: block with enabled: true' };
  if (!cfg.bin) return { ok: false, note: id, reason: 'kernel.bin is not set' };
  const rec = readAll(paths(root).notes).notes.get(id);
  if (!rec) return { ok: false, note: id, reason: `no note ${id}` };
  const horizon = ask.horizon?.trim();
  if (horizon && !/^\d{4}-\d{2}-\d{2}$/.test(horizon)) return { ok: false, note: id, reason: `a horizon is YYYY-MM-DD, not "${horizon}"` };
  const statement = ask.statement?.trim() || rec.title;
  const criterion = ask.criterion?.trim();

  const run = opts.run ?? spawnRunner;
  const before = await kernelIndex(root, 'owner-intent', { fresh: true, run });
  if (before.reason) return { ok: false, note: id, reason: before.reason };
  const live = before.notes.get(id);
  if (live && (live.status === 'open' || live.status === 'proposed')) {
    return { ok: false, note: id, reason: `${id} already has an ${live.status} intent, ${shortId(live.intent)}: answer it first` };
  }

  const alias = noteAlias(vaultName(root, settings), id);
  const entity = await ingest(cfg, { entities: [{ alias, kind: 'note', name: rec.title }], events: [], links: [], proposals: [] }, run);
  if (!entity.ok) return { ok: false, note: id, reason: entity.reason };
  try {
    const args = ['capture', statement, ...(criterion ? ['--criterion', criterion] : []), ...(horizon ? ['--horizon', horizon] : []), '--about', alias];
    const { code, stdout, stderr } = await run(cfg.bin, args, '', kernelEnv(cfg), cfg.timeoutSeconds * 1000);
    forgetKernel(root);
    if (code !== 0) return { ok: false, note: id, reason: `kernel capture ${said(code, stdout, stderr)}` };
    const line = stdout.trim().split('\n').pop() ?? '';
    const after = await kernelIndex(root, 'owner-intent', { fresh: true, run });
    const k = after.notes.get(id) ?? null;
    return { ok: true, note: id, intent: k?.intent ?? /intent\s+(\S+)/.exec(line)?.[1] ?? '', said: line, kernel: k };
  } catch (e) {
    return { ok: false, note: id, reason: e instanceof Error ? e.message : String(e) };
  }
}
