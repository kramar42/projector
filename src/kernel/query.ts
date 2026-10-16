import { createHash } from 'node:crypto';
import { spawnRunner, type Runner } from '../intake/kernel.ts';
import type { Settings } from '../settings.ts';

/**
 * Projector reads the kernel through its own saved queries, and only those.
 *
 * `kernel/manifest.json` names them (`queries`, each an `.edn` file under
 * `kernel/queries/`), so what projector reads is ledger data like what it
 * writes: the kernel checks every one against its query allow-list when
 * projector registers, `orient` lists them, and `<kernel.bin> query --saved
 * projector/<name>` runs the version last registered. A query changed here is
 * read by the kernel only after `pj kernel register`.
 *
 * **The kernel is the only record (C11).** Nothing the kernel answers is kept
 * on disk here: the board's axis is held in memory for a TTL (`read.ts`), and
 * the import asks the kernel which status events it already has each time it
 * plans (`import.ts`). A kernel that cannot answer is a `reason`, never a stale
 * copy standing in for it.
 */

/** The saved queries `kernel/manifest.json` registers, by name. */
export const QUERIES = {
  /** Every intent about this vault's notes, with its latest verdict and who proposed it. Input `prefix`. */
  vaultIntents: 'vault-intents',
  /** The `vault/status` events the import sent about a note or a vault's notes, newest first. Input `alias`. */
  vaultStatusEvents: 'vault-status-events',
  /** The intents intake proposed that the owner has not answered. No input. */
  intakeProposals: 'intake-proposals',
} as const;

export type QueryName = (typeof QUERIES)[keyof typeof QUERIES];

/** The system that registers them: `projector/<name>` is how the kernel finds one. */
const SYSTEM = 'projector';

/** The kernel's environment: this process's, with `KERNEL_DB` from `kernel.db` when the file sets it. */
export const kernelEnv = (cfg: Settings['kernel']): Record<string, string | undefined> => ({
  ...process.env,
  ...(cfg.db ? { KERNEL_DB: cfg.db } : {}),
});

/** The last line a failed kernel command said, for a reason a person can act on. */
export function said(code: number | null, stdout: string, stderr: string): string {
  const line = (stderr || stdout).trim().split('\n').pop() ?? '';
  return `exited ${code ?? 'on a signal'}${line ? `: ${line.slice(0, 300)}` : ''}`;
}

/** The answer as JSON: the whole output, else its last line (a launcher may print before it). */
function json(stdout: string): unknown {
  const all = stdout.trim();
  try {
    return JSON.parse(all || '{}');
  } catch (e) {
    const last = all.split('\n').pop() ?? '';
    if (last === all) throw e;
    return JSON.parse(last);
  }
}

/** One row of an answer, by column name. */
export type Row = Record<string, unknown>;

/**
 * `<bin> query --json`'s answer as rows by column: `{columns, rows}`, each row
 * as long as the columns. Anything else is an error, which the caller reports.
 */
export function parseAnswer(stdout: string): Row[] {
  const parsed = json(stdout);
  const r = parsed as { columns?: unknown; rows?: unknown };
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(r.columns) ||
    !r.columns.every((c) => typeof c === 'string') ||
    !Array.isArray(r.rows)
  ) {
    throw new Error('kernel query --json did not print {columns, rows}');
  }
  const columns = r.columns as string[];
  return r.rows
    .filter((row): row is unknown[] => Array.isArray(row) && row.length === columns.length)
    .map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

export type Answered = { ok: true; rows: Row[] } | { ok: false; reason: string };

export interface AskOpts {
  run?: Runner;
  /** Capped by `kernel.timeoutSeconds`. */
  timeoutMs?: number;
  /** Rows the kernel may return; it refuses more rather than cutting them. Its default is 1000. */
  limit?: number;
}

/**
 * One saved query: `<bin> query --saved projector/<name> --in k=v … [--limit n]
 * --json`, with `KERNEL_DB` from `kernel.db`. Never throws: a kernel that is
 * not there, refuses the query (unregistered, an input it does not take, too
 * many rows) or prints something other than an answer is a `reason`.
 */
export async function ask(
  cfg: Settings['kernel'],
  name: QueryName,
  inputs: Record<string, string>,
  opts: AskOpts = {},
): Promise<Answered> {
  if (!cfg.bin) return { ok: false, reason: 'kernel.bin is not set' };
  const ref = `${SYSTEM}/${name}`;
  const args = [
    'query',
    '--saved',
    ref,
    ...Object.entries(inputs).flatMap(([k, v]) => ['--in', `${k}=${v}`]),
    ...(opts.limit ? ['--limit', String(opts.limit)] : []),
    '--json',
  ];
  const timeout = Math.min(cfg.timeoutSeconds * 1000, opts.timeoutMs ?? Infinity);
  try {
    const { code, stdout, stderr } = await (opts.run ?? spawnRunner)(cfg.bin, args, '', kernelEnv(cfg), timeout);
    if (code !== 0) {
      const why = `kernel query ${ref} ${said(code, stdout, stderr)}`;
      // The kernel runs the version last registered; one it has never seen is a registration away.
      return { ok: false, reason: /no saved query/.test(why) ? `${why} — run \`pj kernel register\`` : why };
    }
    return { ok: true, rows: parseAnswer(stdout) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The kernel id of the event a system wrote under `key`: the kernel derives it
 * from the key (`ingest/stable-id`, Java's name-based UUID of `event|<key>`),
 * so a query that returns an event's id says which key it was sent under
 * without the kernel storing the key.
 */
export function eventId(key: string): string {
  const b = createHash('md5').update(`event|${key}`, 'utf8').digest();
  b[6] = (b[6]! & 0x0f) | 0x30;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
