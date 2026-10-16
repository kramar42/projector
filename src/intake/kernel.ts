import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { readAll } from '../index/indexer.ts';
import { paths } from '../config.ts';
import { settingsFor, type Settings } from '../settings.ts';
import { listVaults, normalise } from '../vault.ts';
import { alreadyAnswered } from './materialise.ts';
import type { Verdict } from './classify.ts';
import type { Candidate } from './types.ts';
import type { Note } from '../schema/types.ts';

/**
 * The kernel sink: what a tick examined, written to the owner's kernel as a
 * source batch, beside the inbox card.
 *
 * The kernel is the owner's ledger of intentions and what became of them; in
 * its terms projector's intake *gathers*, so it is a source: it writes events
 * about what it saw and **proposes** intents, and never opens one. Every
 * candidate a tick judged becomes one `intake/<channel>` event keyed by its
 * fingerprint — and by the source's state when the candidate carries one, so a
 * Jira issue or a Claude session seen again after it moved is a second event
 * rather than the first one again; a candidate kept as a card (`keep` or
 * `extend`) also becomes one proposal citing that event, which the kernel files
 * as a proposed intent by `system:projector`, waiting for the owner's `opened`
 * or `dropped`. Declines, links and unanswered candidates are events only.
 *
 * **As the registered system.** The batch goes in as `system:projector`, the
 * system `kernel/manifest.json` registers, so the kernel checks every item
 * against what the manifest says projector writes — `intake/` events, `vault:`
 * entities, proposals — and refuses the batch whole when one falls outside.
 *
 * Both halves are idempotent in the kernel — an event by its key, a proposal by
 * its statement and evidence — so a candidate examined twice, or a batch sent
 * twice, lands once.
 *
 * **The card stays the UI's view.** The inbox is still where a person judges a
 * candidate, and nothing here reads back from the kernel; a later step makes the
 * board read commitment from the kernel, and until then the card and the
 * proposal are two drafts of one decision, the card being the one the UI shows.
 *
 * **Each tick that judged something is an attempt.** Intake's judgment is
 * projector's spec `judge-intake` (`kernel/specs/judge-intake.edn`), so the
 * kernel judges the judging the way it judges any work: the tick starts an
 * attempt of it before the first channel with candidates is judged
 * (`startAttempt`, executor `agent:projector-intake`, the judge), every event
 * a channel sends carries that attempt, and the tick ends it with its counts
 * as the result (`endAttempt`) — `failed` when the judge could not be reached.
 * A tick with nothing to judge starts none, so a quiet hour is no verdict.
 *
 * **It never holds a tick.** The kernel is a second destination, not a
 * precondition: the cursor rule is about what the vault has written down, and a
 * kernel that cannot be reached changes nothing there. So a failure is logged
 * against the channel and the tick carries on; it does not retry, and the next
 * tick sends only what it examines itself (C2 is not touched: the kernel is the
 * owner's own store, read by nobody else).
 */

export interface KernelEntity {
  alias: string;
  kind: string;
  name?: string;
}

export interface KernelEvent {
  key: string;
  kind: string;
  at?: string;
  /** The running attempt of `judge-intake` this tick is, when the kernel started one. */
  attempt?: string;
  about: string[];
  payload: Record<string, unknown>;
}

export interface KernelProposal {
  statement: string;
  about: string[];
  evidence: string[];
}

export interface KernelBatch {
  entities: KernelEntity[];
  events: KernelEvent[];
  links: never[];
  proposals: KernelProposal[];
}

/** One candidate a tick examined, and what the tick decided about it. */
export interface Examined {
  candidate: Candidate;
  /** The judge's verdict; absent for a candidate declined for want of one. */
  verdict?: Verdict;
  /** `drop` and `unjudged` carry their reason here; a verdict carries its own. */
  decision: Verdict['decision'] | 'unjudged';
  reason: string;
}

/** The alias a vault note goes by in the kernel. Stable for as long as the note id and the vault's name are. */
export const noteAlias = (vault: string, id: string): string => `vault:${vault}:${id}`;

/** The system `kernel/manifest.json` registers, and the source of every batch projector sends. */
export const KERNEL_SOURCE = 'system:projector';

/** The spec a tick is an attempt of, published in `kernel/specs/judge-intake.edn`. */
export const INTAKE_SPEC = 'judge-intake';

/**
 * Who works that attempt: the judge, an agent of projector's. Not `agent:claude`,
 * whose running attempts an executor session picks up and works — this one is
 * projector's own, running inside the tick.
 */
export const INTAKE_EXECUTOR = 'agent:projector-intake';

/**
 * The key a candidate's event goes by: its fingerprint, and the state the
 * source was in when the candidate carries one. A fingerprint names the thing
 * — `jira:KEY`, `claude:<session>` — and the kernel writes an event once per
 * key, so without the state the second sighting of a moved issue would be the
 * first event again and never recorded. A fingerprint that already ends in the
 * state (a Jira update with no timestamp) is not given it twice.
 */
export function eventKey(c: Pick<Candidate, 'fingerprint' | 'state'>): string {
  const value = c.state?.value;
  if (!value || c.fingerprint.endsWith(`@${value}`)) return c.fingerprint;
  return `${c.fingerprint}@${value}`;
}

/**
 * The vault's name in kernel aliases: `kernel.vault` when the file sets one,
 * else the name it is registered under, else its folder's name. Set it in the
 * file to keep aliases stable through a rename in the registry.
 */
export function vaultName(root: string, settings: Settings = settingsFor(root)): string {
  if (settings.kernel.vault) return settings.kernel.vault;
  const want = normalise(root);
  return listVaults().find((v) => v.path === want)?.name ?? basename(want);
}

/**
 * A channel's examined candidates as one kernel batch. Pure: everything it
 * needs is passed in, so the mapping is testable without a kernel.
 */
export function kernelBatch(
  vault: string,
  channel: string,
  examined: Examined[],
  notes: Map<string, Pick<Note, 'id' | 'title'>>,
  /** The tick's attempt: every event lands in it, as the attempt's evidence. */
  attempt?: string,
): KernelBatch {
  const entities = new Map<string, KernelEntity>();
  const entity = (id: string, fallback?: string): string => {
    const alias = noteAlias(vault, id);
    if (!entities.has(alias)) {
      entities.set(alias, { alias, kind: 'note', name: notes.get(id)?.title ?? fallback ?? id });
    }
    return alias;
  };

  const events: KernelEvent[] = [];
  const proposals: KernelProposal[] = [];
  for (const { candidate: c, verdict: v, decision, reason } of examined) {
    const ev = c.evidence ?? {};
    // The notes this candidate is mechanically about: what tracks it, what
    // captured it, what it matched, and the note it extends. Only notes the
    // vault has, so an alias never names something that is not there.
    const ids = [
      ...(ev.linkedTo ?? []),
      ...(ev.capturedAs ?? []),
      ...(ev.matches ?? []).map((m) => m.id),
      ...(v?.target ? [v.target] : []),
    ];
    const titles = new Map((ev.matches ?? []).map((m) => [m.id, m.title]));
    const about = [...new Set(ids)].filter((id) => notes.has(id)).map((id) => entity(id, titles.get(id)));

    const key = eventKey(c);
    events.push({
      key,
      kind: `intake/${channel}`,
      ...(c.when ? { at: c.when } : {}),
      ...(attempt ? { attempt } : {}),
      about,
      payload: {
        title: c.title,
        ...(c.detail ? { detail: c.detail } : {}),
        links: c.links,
        evidence: ev,
        verdict: decision,
        ...(v?.kind ? { kind: v.kind } : {}),
        ...(v?.target ? { target: v.target } : {}),
        ...(v?.title ? { proposed: v.title } : {}),
        reason,
      },
    });

    // A card is a proposal; so is an extension. Not a candidate the vault
    // already answers for, which materialise writes nothing for either.
    if ((decision === 'keep' || decision === 'extend') && v && !alreadyAnswered(c, v)) {
      proposals.push({
        statement: v.title ?? c.title,
        about: v.target && notes.has(v.target) ? [entity(v.target)] : [],
        evidence: [key],
      });
    }
  }
  return { entities: [...entities.values()], events, links: [], proposals };
}

/** What the kernel answered, or why it could not be reached. */
export type Sent =
  | { ok: true; events: number; proposals: number }
  | { ok: false; reason: string };

/**
 * Run a command with `input` on stdin; resolves to its exit code and output.
 * Injected so a test can stand in for the kernel without spawning one.
 */
export type Runner = (
  bin: string,
  args: string[],
  input: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const spawnRunner: Runner = (bin, args, input, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

/** What a `--json` kernel command answered, as its own keys, or why there is no answer. */
export type Ingested = { ok: true; answer: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Run one kernel command that answers with a JSON object on its last line:
 * `<bin> <args>`, `input` on stdin, `KERNEL_DB` from `kernel.db` when the file
 * sets it. Never throws: every way of failing is a `reason`.
 */
async function call(cfg: Settings['kernel'], args: string[], input: string, run: Runner): Promise<Ingested> {
  if (!cfg.bin) return { ok: false, reason: 'kernel.bin is not set' };
  const env = { ...process.env, ...(cfg.db ? { KERNEL_DB: cfg.db } : {}) };
  const what = `kernel ${args[0]}${args[0] === 'attempt' ? ` ${args[1]}` : ''}`;
  try {
    const { code, stdout, stderr } = await run(cfg.bin, args, input, env, cfg.timeoutSeconds * 1000);
    if (code !== 0) {
      const said = (stderr || stdout).trim().split('\n').pop() ?? '';
      return { ok: false, reason: `${what} exited ${code ?? 'on a signal'}${said ? `: ${said.slice(0, 300)}` : ''}` };
    }
    const r = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as unknown;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, reason: `${what} answered something other than a JSON object` };
    return { ok: true, answer: r as Record<string, unknown> };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Send one batch: `<bin> ingest --source system:projector [--owner] --json`,
 * the batch on stdin, `KERNEL_DB` from `kernel.db` when the file sets it.
 * `owner` is for the owner's own reports — the import's commitments — and
 * never for the intake sink, whose proposals are an agent's. Never throws:
 * every way of failing is a `reason`.
 */
export async function ingest(
  cfg: Settings['kernel'],
  batch: object,
  opts: { owner?: boolean } = {},
  run: Runner = spawnRunner,
): Promise<Ingested> {
  return call(cfg, ['ingest', '--source', KERNEL_SOURCE, ...(opts.owner ? ['--owner'] : []), '--json'], JSON.stringify(batch), run);
}

/** The tick's attempt, as the kernel started it, or why it did not. */
export type Started = { ok: true; id: string } | { ok: false; reason: string };

/**
 * Start the tick's attempt: `<bin> attempt start judge-intake --executor
 * agent:projector-intake --json`. No intent is named, so the kernel picks the
 * open intent that owns the spec, else the owner's standing intent. Never throws.
 */
export async function startAttempt(cfg: Settings['kernel'], run: Runner = spawnRunner): Promise<Started> {
  const r = await call(cfg, ['attempt', 'start', INTAKE_SPEC, '--executor', INTAKE_EXECUTOR, '--json'], '', run);
  if (!r.ok) return r;
  const id = r.answer.id;
  return typeof id === 'string' && id ? { ok: true, id } : { ok: false, reason: 'kernel attempt start answered no id' };
}

/** How the kernel's attempt ends: the kernel's own words, not a status axis of a vault. */
export type AttemptStatus = 'done' | 'failed';
export const ATTEMPT_DONE: AttemptStatus = 'done';

/** What a tick counted, the attempt's result. */
export interface TickCounts {
  seen: number;
  created: number;
  extending: number;
  updates: number;
  linked: number;
  declined: number;
  unanswered: number;
  skipped: number;
  advanced: number;
  /** Why the tick held, when it did: the judge could not be reached. */
  held?: string;
  /** Why the tick failed, when it threw. */
  error?: string;
}

/**
 * End the tick's attempt: `<bin> attempt end <id> done|failed --result <counts>
 * --json`. The kernel judges it on its next tick, by the events the channels put
 * in it. Never throws.
 */
export async function endAttempt(
  cfg: Settings['kernel'],
  id: string,
  status: AttemptStatus,
  result: TickCounts,
  run: Runner = spawnRunner,
): Promise<Ingested> {
  return call(cfg, ['attempt', 'end', id, status, '--result', JSON.stringify(result), '--json'], '', run);
}

/** The intake sink's send: one tick's batch, as the system and never as the owner. */
export async function sendToKernel(
  cfg: Settings['kernel'],
  batch: KernelBatch,
  run: Runner = spawnRunner,
): Promise<Sent> {
  const r = await ingest(cfg, batch, {}, run);
  if (!r.ok) return r;
  return { ok: true, events: Number(r.answer['events-new'] ?? 0), proposals: Number(r.answer['proposals-new'] ?? 0) };
}

/**
 * The sink as a tick calls it: map, send, and answer for one channel. Nothing
 * when the vault has not turned the kernel on, or the channel examined nothing.
 */
export async function sinkToKernel(
  root: string,
  channel: string,
  examined: Examined[],
  run: Runner = spawnRunner,
  /** The tick's attempt, when the kernel started one. */
  attempt?: string,
): Promise<Sent | null> {
  const settings = settingsFor(root);
  if (!settings.kernel.enabled || !examined.length) return null;
  try {
    const notes = readAll(paths(root).notes).notes;
    return await sendToKernel(settings.kernel, kernelBatch(vaultName(root, settings), channel, examined, notes, attempt), run);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
