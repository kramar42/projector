import { settingsFor, type Settings, type StatusVerdict } from '../settings.ts';
import { spawnRunner, type Runner } from '../intake/kernel.ts';
import type { Note } from '../schema/types.ts';
import { forgetKernel, kernelEnv, kernelIndex, said, type KernelIndex } from './read.ts';
import { shortId, type KernelNote } from './state.ts';

/**
 * The kernel write: `<kernel.bin> observe <intent> <verdict> [--note text]`.
 *
 * **Always as the owner.** The kernel's CLI observes as its owner unless told
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

export type ObserveVerdict = 'met' | 'missed' | 'dropped' | 'partial';

export type Observed = { ok: true; said: string } | { ok: false; reason: string };

/** One observation, as the owner. Never throws. */
export async function observe(
  cfg: Settings['kernel'],
  intent: string,
  verdict: ObserveVerdict,
  note: string | null,
  run: Runner = spawnRunner,
): Promise<Observed> {
  if (!cfg.bin) return { ok: false, reason: 'kernel.bin is not set' };
  try {
    const { code, stdout, stderr } = await run(
      cfg.bin,
      ['observe', intent, verdict, ...(note ? ['--note', note] : [])],
      '',
      kernelEnv(cfg),
      cfg.timeoutSeconds * 1000,
    );
    if (code !== 0) return { ok: false, reason: `kernel observe ${said(code, stdout, stderr)}` };
    return { ok: true, said: stdout.trim().split('\n').pop() ?? '' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------ accept · overrule

export type Decision = 'accept' | 'overrule';

export type Decided =
  | { ok: true; note: string; intent: string; verdict: ObserveVerdict; said: string; kernel: KernelNote | null }
  | { ok: false; note: string; reason: string };

/**
 * The owner's answer to a note's kernel line: accept is `met` (or the drafted
 * verdict, when there is a draft); overrule is `missed`, or `partial` to say
 * "not yet" and keep the intent open.
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
  opts: { verdict?: 'missed' | 'partial'; note?: string; run?: Runner } = {},
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
  const verdict: ObserveVerdict =
    decision === 'accept' ? (k.proposed && k.latest ? (k.latest.verdict as ObserveVerdict) : 'met') : (opts.verdict ?? 'missed');
  const draft = k.proposed && k.latest ? `${k.latest.by ?? 'someone'}'s ${k.latest.verdict}` : null;
  const note =
    opts.note ??
    (decision === 'accept'
      ? draft ? `accepted ${draft} in projector` : 'met, said in projector'
      : draft ? `overruled ${draft} in projector` : `${verdict}, said in projector`);

  const res = await observe(cfg, k.intent, verdict, note, run);
  forgetKernel(root);
  if (!res.ok) return { ok: false, note: id, reason: res.reason };
  const after = await kernelIndex(root, 'owner-answer', { fresh: true, run });
  return { ok: true, note: id, intent: k.intent, verdict, said: res.said, kernel: after.notes.get(id) ?? null };
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
 * so re-saving a note in `done` does not observe `met` again, and moving from one
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
 * declining it, which the kernel takes from the owner and only the owner.
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
    const res = await observe(cfg, k.intent, through.verdict, `${through.axis} set to ${through.value} in projector`, run);
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
