import { statSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import { paths } from '../config.ts';
import { readAll } from '../index/indexer.ts';
import { ingest, noteAlias, spawnRunner, vaultName, type KernelEntity, type KernelEvent, type Runner } from '../intake/kernel.ts';
import { settingsFor, type Settings } from '../settings.ts';
import type { Note } from '../schema/types.ts';
import { ask, eventId, QUERIES, type Row } from './query.ts';

/**
 * What the vault records in the kernel: its status changes and its days, sent
 * as one batch by the registered system (`kernel/manifest.json`). Each index
 * rebuild sends what changed (`record.ts`); `pj kernel import` sends the whole
 * of it by hand, to catch up.
 *
 * **The vault is read through projector's own reader** (`readAll`, the indexer's
 * walk), so the kernel sees exactly the notes the board does — the same places,
 * the same ids, the same facets — and never a second parser's idea of them.
 *
 * **A change is a fact, never an intent (C1, C4).** The note's status stays in
 * its file; nothing here knows which values are open or done. An intent about a
 * note is the owner's to open (`write.ts`, `openIntent`), and when the two part
 * ways the panel asks the owner (`state.ts`, `askOf`).
 *
 * **What the batch holds:**
 *
 * - an entity per note it reports — `vault:<vault>:<id>`, kind `note`, named by
 *   its title — the alias the intake sink and the kernel's old vault reader gave
 *   notes, so a store that imported this vault before stays continuous;
 * - a `vault/status` event per change of the note's value on `kernel.status`
 *   since the kernel last heard, keyed `vault:<vault>:<id>:<status>` (`none`
 *   when the value went away), with `@<n>` — the count of changes before it — on
 *   a status the note held before, and `via`: how the change was made, as far
 *   as projector knows — `app` (the owner's screen), `cli` (`pj`), or `file`
 *   (found in the file: an agent's plain write, an editor, a pull). What was
 *   sent before is the kernel's to say: the import reads this system's status
 *   events back through the saved query `projector/vault-status-events`, so the
 *   kernel is the only record of them (C11) and nothing here keeps a copy;
 * - a `vault/day` event per note in the `kernel.days` folder, keyed
 *   `vault:<vault>:day:<date>`, at that date, its text as the payload.
 *
 * Inbox cards are not reported: an unjudged card is intake's proposal, which
 * the intake sink already sends.
 *
 * Deterministic (C8): the same vault, the same status events in the kernel and
 * the same `via` give the same batch byte for byte.
 */

/** How a change was made, as far as projector knows. */
export type Via = 'app' | 'cli' | 'file';

export interface ImportBatch {
  entities: KernelEntity[];
  events: KernelEvent[];
  links: never[];
  proposals: never[];
}

/** One note as the import reads it: the note, where it is in the vault, and when its file last changed. */
export interface ImportNote {
  note: Pick<Note, 'id' | 'title' | 'facets' | 'body'>;
  /** Vault-relative, with `/` whatever the platform. */
  path: string;
  /** The file's mtime, ms. */
  mtime: number;
}

/** What the kernel holds of one note's status events: every key, oldest first, and the latest status and time. */
export interface StatusSent {
  keys: string[];
  status: string | null;
  at: string;
}

export interface Planned {
  vault: string;
  batch: ImportBatch;
  /** Notes read and left out, with why — a day note with no date in its name. */
  skipped: { id: string; why: string }[];
}

const DATE = /\d{4}-\d{2}-\d{2}/;

/** The note's value on the axis as one string, or null for none. A many-valued axis joins them, sorted. */
const statusOf = (axis: string, facets: Record<string, string[]>): string | null => {
  const values = [...(facets[axis] ?? [])].sort();
  return values.length ? values.join('+') : null;
};

/**
 * The batch, from the notes and the status events the kernel already holds.
 * Pure: no file is read, the kernel is not asked and nothing is written, so the
 * mapping is testable whole.
 */
export function importBatch(
  vault: string,
  cfg: Settings['kernel'],
  notes: ImportNote[],
  sent: ReadonlyMap<string, StatusSent> = new Map(),
  via: ReadonlyMap<string, Via> = new Map(),
): Planned {
  const entities: KernelEntity[] = [];
  const events: KernelEvent[] = [];
  const skipped: { id: string; why: string }[] = [];
  const days = cfg.days ? `${cfg.days}/` : null;

  for (const { note, path, mtime } of [...notes].sort((a, b) => (a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0))) {
    if (path.startsWith('inbox/')) continue;
    const alias = noteAlias(vault, note.id);

    if (days && path.startsWith(days)) {
      const date = DATE.exec(basename(path, '.md'))?.[0];
      if (!date) {
        skipped.push({ id: note.id, why: `in ${cfg.days}/ with no date in its name` });
        continue;
      }
      entities.push({ alias, kind: 'note', name: note.title });
      events.push({
        key: `vault:${vault}:day:${date}`,
        kind: 'vault/day',
        at: date,
        about: [alias],
        payload: { vault, id: note.id, date, path, title: note.title, text: note.body.trim() },
      });
      continue;
    }

    const axis = cfg.status;
    if (!axis) continue;
    const status = statusOf(axis, note.facets);
    const before = sent.get(note.id);
    // A thought, and never anything else as far as the kernel was told.
    if (status === null && (!before || before.status === null)) continue;

    entities.push({ alias, kind: 'note', name: note.title });
    if (!before || before.status !== status) {
      const base = `${alias}:${status ?? 'none'}`;
      const key = before?.keys.includes(base) ? `${base}@${before.keys.length}` : base;
      // The file's time, and always after the change before it.
      const at = new Date(Math.max(mtime, before ? Date.parse(before.at) + 1 : 0)).toISOString();
      events.push({
        key,
        kind: 'vault/status',
        at,
        about: [alias],
        payload: {
          vault,
          id: note.id,
          axis,
          status,
          path,
          via: via.get(note.id) ?? 'file',
          ...(before ? { previous: before.status } : {}),
        },
      });
    }
  }

  return { vault, batch: { entities, events, links: [], proposals: [] }, skipped };
}

/** The vault's notes as the import reads them: projector's own walk, with each file's place and time. */
export function importNotes(root: string): ImportNote[] {
  const dir = paths(root).notes;
  return [...readAll(dir).notes.values()].map((note) => ({
    note,
    path: relative(dir, note.file).split(sep).join('/'),
    mtime: statSync(note.file).mtimeMs,
  }));
}

/**
 * Status events the read lets the kernel return, one per change of every note
 * in the vault. The kernel refuses more rather than cutting them, so a vault
 * past it is a refused import, never one keyed from half the record.
 */
const SENT_LIMIT = 10_000;

/**
 * Which key the kernel holds an event under. The kernel keeps an event's id,
 * derived from its key, not the key: of the two keys the import could have
 * given the note's `n`th change — the bare one, or `@n` for a status it held
 * before — the one whose id is this event's. One that matches neither (an event
 * keyed some other way) is read as the import would key it today.
 */
function keyOf(alias: string, status: string | null, n: number, earlier: string[], id: unknown): string {
  const base = `${alias}:${status ?? 'none'}`;
  const repeat = `${base}@${n}`;
  if (id === eventId(base)) return base;
  if (id === eventId(repeat)) return repeat;
  return earlier.includes(base) ? repeat : base;
}

/**
 * The kernel's `projector/vault-status-events` answer for a vault, as the
 * record `importBatch` keys the next change from: by note id, every key oldest
 * first, the status the latest one moved to and when.
 */
export function statusesOf(vault: string, rows: Row[]): Map<string, StatusSent> {
  const prefix = `vault:${vault}:`;
  const by = new Map<string, { at: string; id: unknown; status: string | null }[]>();
  for (const r of rows) {
    const alias = typeof r.note === 'string' ? r.note : '';
    const id = alias.startsWith(prefix) ? alias.slice(prefix.length) : '';
    const at = typeof r.at === 'string' ? r.at : '';
    if (!id || !at) continue;
    const p = r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {};
    const status = typeof p.status === 'string' && p.status ? p.status : null;
    const list = by.get(id) ?? [];
    list.push({ at, id: r.event, status });
    by.set(id, list);
  }
  const out = new Map<string, StatusSent>();
  for (const [id, list] of [...by].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // Newest first from the kernel; the keys are counted from the first change.
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const keys: string[] = [];
    for (const [n, e] of list.entries()) keys.push(keyOf(`${prefix}${id}`, e.status, n, keys, e.id));
    const last = list[list.length - 1]!;
    out.set(id, { keys, status: last.status, at: new Date(Date.parse(last.at)).toISOString() });
  }
  return out;
}

/** What the kernel holds of this vault's status events, or why it could not say. Never throws. */
export async function statusesSent(
  cfg: Settings['kernel'],
  vault: string,
  run?: Runner,
): Promise<{ ok: true; sent: Map<string, StatusSent> } | { ok: false; reason: string }> {
  const r = await ask(cfg, QUERIES.vaultStatusEvents, { alias: `vault:${vault}:` }, { run, limit: SENT_LIMIT });
  return r.ok ? { ok: true, sent: statusesOf(vault, r.rows) } : r;
}

/**
 * The batch for this vault, as it stands now against what the kernel holds.
 * Refused when the vault has asked for nothing to import, and when the kernel
 * cannot say what it holds: a batch keyed without the record would send a
 * return to an earlier status under a key the kernel already has.
 */
export async function planImport(
  root: string,
  run?: Runner,
): Promise<{ ok: true; plan: Planned } | { ok: false; reason: string }> {
  const settings = settingsFor(root);
  const cfg = settings.kernel;
  if (!cfg.enabled) return { ok: false, reason: 'this vault has no kernel: block with enabled: true — see `pj help kernel`' };
  if (!cfg.status && !cfg.days) {
    return { ok: false, reason: 'nothing to import: the kernel: block names neither a status axis nor days' };
  }
  const vault = vaultName(root, settings);
  // Days carry no status, so a vault that names only days has nothing to ask.
  const sent = cfg.status ? await statusesSent(cfg, vault, run) : { ok: true as const, sent: new Map<string, StatusSent>() };
  if (!sent.ok) return sent;
  return { ok: true, plan: importBatch(vault, cfg, importNotes(root), sent.sent) };
}

export type Imported =
  | { ok: true; plan: Planned; answer: Record<string, unknown> | null }
  | { ok: false; reason: string };

/**
 * Plan, and unless `dryRun`, send: `<bin> ingest --source system:projector
 * --json`. Nothing is recorded here: the next plan
 * asks the kernel again, so a refused import is tried again whole and a taken
 * one is never sent twice.
 */
export async function runImport(root: string, opts: { dryRun?: boolean; run?: Runner } = {}): Promise<Imported> {
  const planned = await planImport(root, opts.run);
  if (!planned.ok) return planned;
  const { plan } = planned;
  if (opts.dryRun) return { ok: true, plan, answer: null };
  const r = await ingest(settingsFor(root).kernel, plan.batch, opts.run ?? spawnRunner);
  if (!r.ok) return r;
  return { ok: true, plan, answer: r.answer };
}

/** One line for what a batch holds. */
export function planLine(p: Planned): string {
  const status = p.batch.events.filter((e) => e.kind === 'vault/status').length;
  const days = p.batch.events.filter((e) => e.kind === 'vault/day').length;
  return (
    `vault:${p.vault} — ${status} status change(s), ${days} day(s), ` +
    `${p.batch.entities.length} entit${p.batch.entities.length === 1 ? 'y' : 'ies'}`
  );
}
