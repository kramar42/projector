import { basename } from 'node:path';
import { settingsFor } from '../settings.ts';
import { ingest, spawnRunner, vaultName, type Runner } from '../intake/kernel.ts';
import { info, warn } from '../server/log.ts';
import { importBatch, importNotes, statusesSent, type Via } from './import.ts';

/**
 * Recording what changed in the vault, as it changes: after each index rebuild
 * the vault's status changes and new days go to the kernel as events — the
 * batch `pj kernel import` sends (`import.ts`), cut to what is new. A change is
 * a fact for the kernel to learn from, never an intent and never a verdict.
 *
 * **Cheap when nothing changed.** What every note held on the recorded axis,
 * and which days there were, is kept from the last record that landed; a
 * rebuild that leaves both as they were starts no process. Only a change asks
 * the kernel what it holds (`statusesSent`) and sends what it lacks, so two
 * processes recording the same vault — the server and a `pj` — never key one
 * change twice and never miss one: whichever sends first, the other finds it
 * held.
 *
 * **How a change was made** is what the write paths say before the rebuild
 * (`noteWrites`): `app` for the owner's screen, `cli` for `pj`; a change no
 * write path claimed was found in the file (`file`). Best known, never
 * guessed: a change two paths raced to is the first one's to name.
 *
 * **Never blocking.** The server calls `recordSoon` after a rebuild and goes
 * on; a kernel that is absent or refuses costs a warning, once per reason, and
 * the next rebuild tries again with the record unchanged.
 */

interface Seen {
  statuses: Map<string, string | null>;
  days: Set<string>;
}

interface State {
  seen: Seen | null;
  running: Promise<Recorded> | null;
  again: boolean;
}

const states = new Map<string, State>();
const marks = new Map<string, Map<string, Via>>();
const warned = new Map<string, string>();

/** Say how the notes about to change were written, before the rebuild that records them. */
export function noteWrites(root: string, ids: Iterable<string>, via: Via): void {
  const m = marks.get(root) ?? new Map<string, Via>();
  for (const id of ids) m.set(id, via);
  marks.set(root, m);
}

export type Recorded =
  | { ok: true; events: number; skipped: boolean }
  | { ok: false; reason: string };

/** What every note holds on the recorded axis, and the days there are, as the batch would key them. */
function look(root: string): Seen {
  const settings = settingsFor(root);
  const plan = importBatch(vaultName(root, settings), settings.kernel, importNotes(root));
  const statuses = new Map<string, string | null>();
  const days = new Set<string>();
  for (const e of plan.batch.events) {
    const p = e.payload as { id?: string; status?: string | null };
    if (e.kind === 'vault/status' && p.id) statuses.set(p.id, p.status ?? null);
    else if (e.kind === 'vault/day') days.add(e.key);
  }
  return { statuses, days };
}

const same = (a: Seen, b: Seen): boolean =>
  a.statuses.size === b.statuses.size &&
  [...a.statuses].every(([id, s]) => b.statuses.has(id) && b.statuses.get(id) === s) &&
  a.days.size === b.days.size &&
  [...a.days].every((d) => b.days.has(d));

async function once(root: string, st: State, run: Runner): Promise<Recorded> {
  const settings = settingsFor(root);
  const cfg = settings.kernel;
  if (!cfg.enabled || !cfg.bin || (!cfg.status && !cfg.days)) return { ok: true, events: 0, skipped: true };

  const now = look(root);
  if (st.seen && same(st.seen, now)) {
    marks.delete(root);
    return { ok: true, events: 0, skipped: true };
  }

  const vault = vaultName(root, settings);
  const sent = cfg.status ? await statusesSent(cfg, vault, run) : { ok: true as const, sent: new Map() };
  if (!sent.ok) return sent;
  const via = marks.get(root) ?? new Map<string, Via>();
  marks.delete(root);
  const plan = importBatch(vault, cfg, importNotes(root), sent.sent, via);
  const events = plan.batch.events.filter((e) => e.kind !== 'vault/day' || !st.seen?.days.has(e.key));
  if (events.length) {
    const about = new Set(events.flatMap((e) => e.about ?? []));
    const r = await ingest(cfg, { ...plan.batch, entities: plan.batch.entities.filter((e) => about.has(e.alias)), events }, run);
    if (!r.ok) return r;
  }
  st.seen = now;
  return { ok: true, events: events.length, skipped: false };
}

/**
 * Record what changed since the last record that landed. Runs one at a time per
 * vault: a call while one runs is folded into one more run after it. Never
 * throws.
 */
export function recordChanges(root: string, opts: { run?: Runner } = {}): Promise<Recorded> {
  const st = states.get(root) ?? { seen: null, running: null, again: false };
  states.set(root, st);
  if (st.running) {
    st.again = true;
    return st.running;
  }
  const run = opts.run ?? spawnRunner;
  const go = async (): Promise<Recorded> => {
    let r: Recorded;
    do {
      st.again = false;
      r = await once(root, st, run).catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }));
    } while (st.again);
    st.running = null;
    return r;
  };
  st.running = go();
  return st.running;
}

/** The server's call after a rebuild: record, and say what happened in the log. */
export function recordSoon(root: string): void {
  void recordChanges(root).then((r) => {
    if (r.ok) {
      warned.delete(root);
      if (r.events) info('kernel', `${basename(root)}: recorded ${r.events} change(s) in the kernel`);
    } else if (warned.get(root) !== r.reason) {
      warned.set(root, r.reason);
      warn('kernel', `${basename(root)}: changes not recorded in the kernel — ${r.reason}`);
    }
  });
}

/** Forget what was recorded — for a test, or a vault whose kernel changed. */
export function forgetRecord(root?: string): void {
  if (root === undefined) {
    states.clear();
    marks.clear();
    warned.clear();
  } else {
    states.delete(root);
    marks.delete(root);
    warned.delete(root);
  }
}
