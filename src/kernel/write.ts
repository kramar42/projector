import { settingsFor, type Settings, type StatusVerdict } from '../settings.ts';
import { spawnRunner, type Runner } from '../intake/kernel.ts';
import type { Note } from '../schema/types.ts';
import { paths } from '../config.ts';
import { readAll } from '../index/indexer.ts';
import { patchNote } from '../server/mutate.ts';
import { forgetKernel, kernelIndex, type KernelIndex } from './read.ts';
import { kernelEnv, said } from './query.ts';
import { shortId, type KernelNote } from './state.ts';

/**
 * The kernel write: `<kernel.bin> judge <intent> <verdict> [--note text]`.
 *
 * **Always as the owner.** The kernel's CLI judges as its owner unless told
 * otherwise, and nothing here tells it otherwise: every write on this page is
 * something the owner did in the owner's own UI or shell — accepting a draft,
 * overruling it, setting a status. No agent reaches it, and the intake sink,
 * which *is* an agent, stays on `ingest` and its proposals.
 *
 * **Additional, never blocking.** The note file is still the truth for content
 * (C1) and is written exactly as it was before this existed; the kernel write
 * comes after, its failure is a reason and a log line, and nothing the vault
 * holds waits on it.
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
  | {
      ok: true;
      note: string;
      intent: string;
      verdict: JudgeVerdict;
      said: string;
      kernel: KernelNote | null;
      /** What became of the note's file: null for `partial`, which closes nothing and so writes nothing. */
      file: Filed | null;
    }
  | { ok: false; note: string; reason: string };

/**
 * The owner's answer to a note's kernel line: accept is `met` (or the drafted
 * verdict, when there is a draft); overrule is `missed` or `dropped`, or
 * `partial` to say "not yet" and keep the intent open.
 *
 * A verdict that closes the intent is then written into the note too —
 * `kernel.verdicts` read backwards (`fileVerdict`) — so the status chip and the
 * `kernel` axis say the same thing. The kernel goes first: a refusal there
 * writes nothing anywhere, and a file that cannot be written after an accepted
 * judgment is a reason in `file`, not a failed answer.
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
  // Straight to the validated note write, beneath the status write-through
  // that wraps it in `PATCH /api/note/:id` and `pj set`: this value *is* the
  // kernel's answer, so it must not travel back to the kernel as a second
  // judgment. (Were it to, the intent is closed by now and `writeThrough`
  // skips a closed intent — but the guard is not having the path at all.)
  const file = verdict === 'partial' ? null : fileVerdict(root, id, verdict);
  const after = await kernelIndex(root, 'owner-answer', { fresh: true, run });
  return { ok: true, note: id, intent: k.intent, verdict, said: res.said, kernel: after.notes.get(id) ?? null, file };
}

// ------------------------------------------------------------ the verdict, back into the note

/** A value on an axis: where a verdict lands in a note. */
export interface Mapped {
  axis: string;
  value: string;
}

/**
 * The value a verdict writes into a note: `kernel.verdicts` read backwards.
 *
 * The first axis in the map's order with any value mapping to the verdict — the
 * same axis `verdictFor` lets speak first — and on it, `kernel.onVerdict`'s
 * choice when it names one, else the first value that maps to the verdict. No
 * value is named here (C4): with no map, or none that maps to this verdict,
 * there is nothing to write.
 */
export function valueFor(cfg: Settings['kernel'], verdict: StatusVerdict): Mapped | null {
  for (const [axis, map] of Object.entries(cfg.verdicts)) {
    const values = Object.keys(map).filter((v) => map[v] === verdict);
    if (!values.length) continue;
    const chosen = cfg.onVerdict[axis]?.[verdict];
    return { axis, value: chosen && values.includes(chosen) ? chosen : values[0]! };
  }
  return null;
}

export type Filed =
  | { outcome: 'written'; axis: string; value: string; was: string[] }
  | { outcome: 'already'; axis: string; value: string }
  | { outcome: 'unmapped' | 'failed'; reason: string };

/**
 * Write the value a verdict maps to into the note, through `patchNote` — the
 * write `PATCH /api/note/:id` makes, so the vocabulary validates it exactly as
 * it would a chip. The axis is *set* to that one value: it is the lifecycle,
 * and a note is not both active and done. Never throws; a note already holding
 * the value is left byte-for-byte alone.
 */
export function fileVerdict(root: string, id: string, verdict: StatusVerdict): Filed {
  const cfg = settingsFor(root).kernel;
  const target = valueFor(cfg, verdict);
  if (!target) {
    const axes = Object.keys(cfg.verdicts);
    return {
      outcome: 'unmapped',
      reason: axes.length
        ? `no ${axes.join(' or ')} value maps to ${verdict} in kernel.verdicts`
        : 'kernel.verdicts is not set',
    };
  }
  try {
    const was = readAll(paths(root).notes).notes.get(id)?.facets[target.axis] ?? [];
    if (was.length === 1 && was[0] === target.value) return { outcome: 'already', ...target };
    patchNote(root, id, { facet: { name: target.axis, values: [target.value], mode: 'set' } });
    return { outcome: 'written', ...target, was: [...was] };
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** One line for what `fileVerdict` did, for `pj` and the server log. */
export function filedLine(id: string, verdict: StatusVerdict, f: Filed): string {
  if (f.outcome === 'written') {
    return `${id}: ${f.axis} ${f.was.length ? f.was.join(',') : '(none)'} → ${f.value} in the file (kernel ${verdict})`;
  }
  if (f.outcome === 'already') return `${id}: the file already says ${f.axis}=${f.value} (kernel ${verdict})`;
  if (f.outcome === 'unmapped') return `${id}: the file is unchanged — ${f.reason}`;
  return `${id}: the file could not be written — ${f.reason}`;
}

// ------------------------------------------------------------ reconciliation

const CLOSED: readonly string[] = ['met', 'missed', 'dropped'];

/** A note the kernel has closed while its file still reads as open. */
export interface Disagreement {
  id: string;
  intent: string;
  verdict: StatusVerdict;
  axis: string;
  /** What the file holds on `axis` — none of it a value `kernel.verdicts` maps. */
  holds: string[];
  /** What `pj kernel sync` would write, or null when no value maps to the verdict. */
  target: Mapped | null;
}

/**
 * Every note where the kernel reads `met`, `missed` or `dropped` and the file
 * holds no value the map names on the axis that verdict lands on — a status the
 * map leaves unmapped (`active`), or none at all. A file that already says a
 * closed value, even a different one, is the owner's own word and is not
 * second-guessed. Without `kernel.verdicts` there is no axis to compare, so
 * there is never a disagreement. Pure; the reconciliation is `reconcile`.
 */
export function disagreements(
  cfg: Settings['kernel'],
  kernel: Map<string, KernelNote>,
  notes: Map<string, Pick<Note, 'facets'>>,
): Disagreement[] {
  const axes = Object.keys(cfg.verdicts);
  if (!axes.length) return [];
  const out: Disagreement[] = [];
  for (const id of [...kernel.keys()].sort()) {
    const k = kernel.get(id)!;
    const rec = notes.get(id);
    if (!rec || !CLOSED.includes(k.status)) continue;
    const verdict = k.status as StatusVerdict;
    const target = valueFor(cfg, verdict);
    const axis = target?.axis ?? axes[0]!;
    const holds = rec.facets[axis] ?? [];
    if (holds.some((v) => cfg.verdicts[axis]![v])) continue;
    out.push({ id, intent: k.intent, verdict, axis, holds: [...holds], target });
  }
  return out;
}

/** One line per disagreement, for `pj kernel status`. */
export function disagreementLine(d: Disagreement): string {
  const file = d.holds.length ? `the file says ${d.axis}=${d.holds.join(',')}` : `the file has no ${d.axis}`;
  const fix = d.target ? `\`pj kernel sync\` writes ${d.target.value}` : `no ${d.axis} value maps to ${d.verdict}`;
  return `${d.id}: kernel reads ${d.verdict} on ${shortId(d.intent)}, ${file} — ${fix}`;
}

export type Reconciled =
  | { ok: true; results: { id: string; verdict: StatusVerdict; file: Filed }[] }
  | { ok: false; reason: string };

/**
 * `pj kernel sync`: write the kernel's verdict into every file that disagrees
 * with it, and nothing else. Only when the owner asks — nothing runs this on a
 * schedule or a read, because a file the kernel disagrees with may be the one
 * that is right, and only the owner can say which.
 */
export async function reconcile(root: string, opts: { run?: Runner } = {}): Promise<Reconciled> {
  const cfg = settingsFor(root).kernel;
  if (!cfg.enabled) return { ok: false, reason: 'this vault has no kernel: block with enabled: true' };
  const index = await kernelIndex(root, 'reconcile', { fresh: true, run: opts.run ?? spawnRunner });
  if (index.reason) return { ok: false, reason: index.reason };
  const found = disagreements(cfg, index.notes, readAll(paths(root).notes).notes);
  return { ok: true, results: found.map((d) => ({ id: d.id, verdict: d.verdict, file: fileVerdict(root, d.id, d.verdict) })) };
}

// ------------------------------------------------------------ status write-through

/** What one note's watched axes held, by axis. */
export type Watched = Map<string, Record<string, string[]>>;

/** The axes `kernel.verdicts` names: the only ones whose change is worth comparing. */
export function watchedAxes(cfg: Settings['kernel']): string[] {
  return cfg.enabled && cfg.bin ? Object.keys(cfg.verdicts) : [];
}

/** What `ids` hold on `axes`, copied out — the caller may read `notes` once and let it go. */
export function snapshot(notes: Map<string, Pick<Note, 'facets'>>, ids: Iterable<string>, axes: string[]): Watched {
  const out: Watched = new Map();
  if (!axes.length) return out;
  for (const id of ids) {
    const rec = notes.get(id);
    if (!rec) continue;
    out.set(id, Object.fromEntries(axes.map((a) => [a, [...(rec.facets[a] ?? [])]])));
  }
  return out;
}

export interface Through {
  axis: string;
  value: string;
  verdict: StatusVerdict;
}

/**
 * Which verdict a change says, if any.
 *
 * Only a value that *arrived*: an axis whose values did not change says nothing,
 * so re-saving a note in `done` does not judge `met` again, and moving from one
 * value to another that maps to the same verdict says nothing new either. A value
 * the map does not name writes nothing — `active` is not a verdict. The first
 * mapped axis in the map's order wins, so two mapped axes cannot both speak.
 */
export function verdictFor(
  verdicts: Settings['kernel']['verdicts'],
  before: Record<string, string[]> | undefined,
  after: Record<string, string[]> | undefined,
): Through | null {
  for (const [axis, map] of Object.entries(verdicts)) {
    const was = before?.[axis] ?? [];
    const now = after?.[axis] ?? [];
    if (was.length === now.length && was.every((v, i) => v === now[i])) continue;
    const value = now.find((v) => map[v]);
    if (!value) continue;
    const verdict = map[value]!;
    if (was.some((v) => map[v] === verdict)) continue;
    return { axis, value, verdict };
  }
  return null;
}

export type ThroughResult = { id: string; through: Through } & (
  | { outcome: 'written'; intent: string; said: string }
  | { outcome: 'skipped' | 'failed'; reason: string }
);

/**
 * The kernel half of a status write, after the vault half has landed.
 *
 * `before` and `after` are what the watched axes held on either side of the
 * write. A note with no intent is not a skip worth reporting — most notes have
 * none — so it yields nothing. An intent that is not open is skipped with its
 * reason, with one exception: `dropped` on a proposed intent is the owner
 * dropping it, which the kernel takes from the owner and only the owner.
 */
export async function writeThrough(
  root: string,
  before: Watched,
  after: Watched,
  opts: { run?: Runner; index?: KernelIndex } = {},
): Promise<ThroughResult[]> {
  const cfg = settingsFor(root).kernel;
  if (!watchedAxes(cfg).length) return [];
  const changes = [...after.keys()]
    .map((id) => ({ id, through: verdictFor(cfg.verdicts, before.get(id), after.get(id)) }))
    .filter((c): c is { id: string; through: Through } => c.through !== null);
  if (!changes.length) return [];

  const run = opts.run ?? spawnRunner;
  const index = opts.index ?? (await kernelIndex(root, 'write-through', { fresh: true, run }));
  const out: ThroughResult[] = [];
  for (const { id, through } of changes) {
    const k = index.notes.get(id);
    if (!k) {
      if (index.reason) out.push({ id, through, outcome: 'failed', reason: index.reason });
      continue;
    }
    const takes = k.status === 'open' || (k.status === 'proposed' && through.verdict === 'dropped');
    if (!takes) {
      out.push({ id, through, outcome: 'skipped', reason: `intent ${shortId(k.intent)} is ${k.status}` });
      continue;
    }
    const res = await judge(cfg, k.intent, through.verdict, `${through.axis} set to ${through.value} in projector`, run);
    out.push(
      res.ok
        ? { id, through, outcome: 'written', intent: k.intent, said: res.said }
        : { id, through, outcome: 'failed', reason: res.reason },
    );
  }
  if (out.some((r) => r.outcome === 'written')) forgetKernel(root);
  return out;
}

/** One line per result, for the server log and for `pj set`. */
export function throughLine(r: ThroughResult): string {
  const what = `${r.id}: ${r.through.axis}=${r.through.value}`;
  if (r.outcome === 'written') return `${what} → kernel ${r.through.verdict} on ${shortId(r.intent)}`;
  return `${what} → kernel ${r.through.verdict} ${r.outcome === 'skipped' ? 'skipped' : 'not written'}: ${r.reason}`;
}
