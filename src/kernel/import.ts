import { statSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import { paths } from '../config.ts';
import { readAll } from '../index/indexer.ts';
import { recordStatusesSent, statusesSent, type StatusSent } from '../intake/db.ts';
import { ingest, noteAlias, spawnRunner, vaultName, type KernelEntity, type KernelEvent, type Runner } from '../intake/kernel.ts';
import { settingsFor, type Settings } from '../settings.ts';
import type { Note } from '../schema/types.ts';

/**
 * `pj kernel import`: the vault as the owner's commitments and days, sent to the
 * kernel as one batch by the registered system (`kernel/manifest.json`).
 *
 * **The vault is read through projector's own reader** (`readAll`, the indexer's
 * walk), so the kernel sees exactly the notes the board does — the same places,
 * the same ids, the same facets — and never a second parser's idea of them.
 *
 * **What a note says is the vault's to define (C4).** Nothing here knows which
 * axis is the lifecycle or what any of its values mean: `kernel.commitments`
 * names the axis and the values that are open, `kernel.verdicts` the values
 * that are met, missed or dropped, and every other value — or none — is no
 * commitment. A note in planning is not a promise yet; a note on hold is not a
 * broken one.
 *
 * **What the batch holds:**
 *
 * - an entity per note it reports — `vault:<vault>:<id>`, kind `note`, named by
 *   its title — the alias the intake sink and the kernel's old vault reader gave
 *   notes, so a store that imported this vault before stays continuous;
 * - a `vault/status` event per status change since the last import, keyed
 *   `vault:<vault>:<id>:<status>` (`none` when the value went away), with `@<n>`
 *   — the count of changes before it — on a status the note held before;
 * - a commitment per note carrying a value on the axis, keyed by its alias, with
 *   the state the vault's map gives that value, citing the note's latest status
 *   event. The kernel turns a change of state into the owner's observation and
 *   the same state again into nothing (`docs/registration.md` in the kernel);
 * - a `vault/day` event per note in the `kernel.days` folder, keyed
 *   `vault:<vault>:day:<date>`, at that date, its text as the payload. A day is
 *   never a commitment.
 *
 * Inbox cards are not reported: an unjudged card is intake's proposal, which
 * the intake sink already sends.
 *
 * Deterministic (C8): the same vault and the same record of what was sent give
 * the same batch byte for byte.
 */

export type CommitmentState = 'open' | 'met' | 'missed' | 'dropped' | 'none';

export interface Commitment {
  key: string;
  statement: string;
  criterion: string;
  horizon?: string;
  about: string[];
  state: CommitmentState;
  evidence: string[];
}

export interface ImportBatch {
  entities: KernelEntity[];
  events: KernelEvent[];
  links: never[];
  proposals: never[];
  commitments: Commitment[];
}

/** One note as the import reads it: the note, where it is in the vault, and when its file last changed. */
export interface ImportNote {
  note: Pick<Note, 'id' | 'title' | 'facets' | 'body'>;
  /** Vault-relative, with `/` whatever the platform. */
  path: string;
  /** The file's mtime, ms. */
  mtime: number;
}

/** A status event this batch carries, for the record once the kernel has taken it. */
export interface StatusRow {
  note: string;
  status: string | null;
  key: string;
  at: string;
}

export interface Planned {
  vault: string;
  batch: ImportBatch;
  /** The status events in the batch, to record as sent once the kernel takes it. */
  rows: StatusRow[];
  /** Notes read and left out, with why — a day note with no date in its name. */
  skipped: { id: string; why: string }[];
}

const DATE = /\d{4}-\d{2}-\d{2}/;

/** What one note's values on the commitments axis say, through the vault's own map. */
export function commitmentState(cfg: Settings['kernel'], facets: Record<string, string[]>): CommitmentState {
  const c = cfg.commitments;
  if (!c) return 'none';
  const values = facets[c.axis] ?? [];
  const verdicts = cfg.verdicts[c.axis] ?? {};
  // A verdict is the stronger word: a value the vault maps to one has been
  // answered, whatever `open` also says of it.
  for (const v of values) if (verdicts[v]) return verdicts[v];
  return values.some((v) => c.open.includes(v)) ? 'open' : 'none';
}

/** The note's value on the axis as one string, or null for none. A many-valued axis joins them, sorted. */
const statusOf = (axis: string, facets: Record<string, string[]>): string | null => {
  const values = [...(facets[axis] ?? [])].sort();
  return values.length ? values.join('+') : null;
};

/**
 * What would make the intent met: the body's own `Done when …` line, else the
 * axis arriving at a value the vault maps to `met`.
 */
function criterionOf(cfg: Settings['kernel'], body: string): string {
  const said = /^[ \t]*(Done when\b.*)$/m.exec(body)?.[1]?.trim();
  if (said) return said;
  const axis = cfg.commitments!.axis;
  const met = Object.entries(cfg.verdicts[axis] ?? {})
    .filter(([, v]) => v === 'met')
    .map(([value]) => value);
  return met.length ? `${axis} ${met.join(' or ')} in the vault` : `${axis} closed in the vault`;
}

/**
 * The batch, from the notes and the record of what earlier imports sent. Pure:
 * no file is read and nothing is written, so the mapping is testable whole.
 */
export function importBatch(
  vault: string,
  cfg: Settings['kernel'],
  notes: ImportNote[],
  sent: ReadonlyMap<string, StatusSent> = new Map(),
): Planned {
  const entities: KernelEntity[] = [];
  const events: KernelEvent[] = [];
  const commitments: Commitment[] = [];
  const rows: StatusRow[] = [];
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

    const c = cfg.commitments;
    if (!c) continue;
    const status = statusOf(c.axis, note.facets);
    const before = sent.get(note.id);
    // A thought, and never anything else as far as the kernel was told.
    if (status === null && (!before || before.status === null)) continue;

    entities.push({ alias, kind: 'note', name: note.title });
    let evidence = before?.keys[before.keys.length - 1];
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
          axis: c.axis,
          status,
          path,
          ...(before ? { previous: before.status } : {}),
        },
      });
      rows.push({ note: note.id, status, key, at });
      evidence = key;
    }

    const horizon = c.horizon ? note.facets[c.horizon]?.find((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)) : undefined;
    commitments.push({
      key: alias,
      statement: note.title,
      criterion: criterionOf(cfg, note.body),
      ...(horizon ? { horizon } : {}),
      about: [alias],
      state: commitmentState(cfg, note.facets),
      evidence: evidence ? [evidence] : [],
    });
  }

  return { vault, batch: { entities, events, links: [], proposals: [], commitments }, rows, skipped };
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

/** The batch for this vault, as it stands now. Refused when the vault has asked for nothing to import. */
export function planImport(root: string): { ok: true; plan: Planned } | { ok: false; reason: string } {
  const settings = settingsFor(root);
  const cfg = settings.kernel;
  if (!cfg.enabled) return { ok: false, reason: 'this vault has no kernel: block with enabled: true — see `pj help kernel`' };
  if (!cfg.commitments && !cfg.days) {
    return { ok: false, reason: 'nothing to import: the kernel: block names neither commitments (axis, open) nor days' };
  }
  const vault = vaultName(root, settings);
  return { ok: true, plan: importBatch(vault, cfg, importNotes(root), statusesSent(root, vault)) };
}

export type Imported =
  | { ok: true; plan: Planned; answer: Record<string, unknown> | null }
  | { ok: false; reason: string };

/**
 * Plan, and unless `dryRun`, send as the owner: `<bin> ingest --source
 * system:projector --owner --json`. The status events are recorded as sent only
 * once the kernel has taken the batch, so a refused import is tried again whole.
 */
export async function runImport(root: string, opts: { dryRun?: boolean; run?: Runner } = {}): Promise<Imported> {
  const planned = planImport(root);
  if (!planned.ok) return planned;
  const { plan } = planned;
  if (opts.dryRun) return { ok: true, plan, answer: null };
  const r = await ingest(settingsFor(root).kernel, plan.batch, { owner: true }, opts.run ?? spawnRunner);
  if (!r.ok) return r;
  recordStatusesSent(root, plan.vault, plan.rows);
  return { ok: true, plan, answer: r.answer };
}

/** One line for what a batch holds. */
export function planLine(p: Planned): string {
  const by = (s: CommitmentState) => p.batch.commitments.filter((c) => c.state === s).length;
  const states = (['open', 'met', 'missed', 'dropped', 'none'] as const)
    .map((s) => [s, by(s)] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');
  const status = p.batch.events.filter((e) => e.kind === 'vault/status').length;
  const days = p.batch.events.filter((e) => e.kind === 'vault/day').length;
  return (
    `vault:${p.vault} — ${p.batch.commitments.length} commitment(s)${states ? ` (${states})` : ''}, ` +
    `${status} status change(s), ${days} day(s), ${p.batch.entities.length} entit${p.batch.entities.length === 1 ? 'y' : 'ies'}`
  );
}
