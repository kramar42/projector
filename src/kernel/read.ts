import { basename } from 'node:path';
import { settingsFor, type Settings } from '../settings.ts';
import { spawnRunner, vaultName, type Runner } from '../intake/kernel.ts';
import { warn } from '../server/log.ts';
import { notesOf, parseIntents, type KernelIntent, type KernelNote } from './state.ts';

/**
 * The kernel read: `<kernel.bin> intents --json --about vault:<vault>:`, once
 * per index rebuild and at most once per `KERNEL_TTL_MS` after that.
 *
 * **Why it is cached at all.** The board asks for the `kernel` axis on every
 * query, and a query is a keystroke in the search box. The kernel is a separate
 * process with a store of its own, so each read is a process start; doing one
 * per request would put that start in front of every keystroke. So the answer
 * is held per vault, keyed by whatever the caller says identifies the index it
 * is drawing — the server passes its rebuild generation, the CLI the index
 * stamp — plus a short TTL, because the kernel changes on its own (an agent
 * drafting a verdict) and nothing in the vault would say so.
 *
 * **Why it is not stored.** The answer is derived and disposable like the index
 * (C1, C11): it lives in memory, a restart forgets it, and nothing is written in
 * the vault.
 *
 * **A kernel that is absent costs nothing but its axis.** Every way of failing —
 * no `kernel.bin`, a binary that is not there, one that exits non-zero or prints
 * something other than an array — is an empty answer with a `reason`, warned
 * once per vault until it recovers. Off unless the vault's `kernel:` block says
 * `enabled: true`, exactly as the sink is.
 */

export const KERNEL_TTL_MS = 30_000;

/** A read is on the request path; a kernel that takes longer than this is treated as absent. */
const READ_TIMEOUT_S = 10;

export interface KernelIndex {
  /** The vault's `kernel:` block is on. When it is not, nothing was asked. */
  enabled: boolean;
  /** The name this vault goes by in the kernel's aliases. */
  vault: string;
  intents: KernelIntent[];
  /** By note id: the intent that speaks for that note. */
  notes: Map<string, KernelNote>;
  /** Why the answer is empty, when it is empty for a reason. */
  reason: string | null;
}

export type IntentsRead = { ok: true; intents: KernelIntent[] } | { ok: false; reason: string };

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

/** One read of every intent about this vault's notes. Never throws. */
export async function readIntents(
  cfg: Settings['kernel'],
  vault: string,
  run: Runner = spawnRunner,
): Promise<IntentsRead> {
  if (!cfg.bin) return { ok: false, reason: 'kernel.bin is not set' };
  try {
    const { code, stdout, stderr } = await run(
      cfg.bin,
      ['intents', '--json', '--about', `vault:${vault}:`],
      '',
      kernelEnv(cfg),
      Math.min(cfg.timeoutSeconds, READ_TIMEOUT_S) * 1000,
    );
    if (code !== 0) return { ok: false, reason: `kernel intents ${said(code, stdout, stderr)}` };
    return { ok: true, intents: parseIntents(stdout.trim() || '[]') };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

interface Entry {
  key: string;
  at: number;
  value?: KernelIndex;
  pending?: Promise<KernelIndex>;
}

const entries = new Map<string, Entry>();
/** The reason last warned about, per vault — so an absent kernel is one line, not one per read. */
const warned = new Map<string, string>();

export interface ReadOpts {
  run?: Runner;
  /** Overridable so a test can step past the TTL. */
  now?: () => number;
  ttlMs?: number;
  /** Ask the kernel now whatever the cache holds — a write is about to depend on the answer. */
  fresh?: boolean;
}

const off = (vault: string): KernelIndex => ({ enabled: false, vault, intents: [], notes: new Map(), reason: null });

/**
 * This vault's kernel answer for the index identified by `key`.
 *
 * A hit is the same key inside the TTL. Concurrent callers for one key share one
 * read, so a board loading its query and its panel at once starts one process.
 */
export async function kernelIndex(root: string, key: string, opts: ReadOpts = {}): Promise<KernelIndex> {
  const settings = settingsFor(root);
  const vault = vaultName(root, settings);
  if (!settings.kernel.enabled) return off(vault);

  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? KERNEL_TTL_MS;
  const hit = entries.get(root);
  if (!opts.fresh && hit && hit.key === key) {
    if (hit.pending) return hit.pending;
    if (hit.value && now() - hit.at < ttl) return hit.value;
  }

  const entry: Entry = { key, at: now() };
  entry.pending = readIntents(settings.kernel, vault, opts.run).then((res) => {
    const value: KernelIndex = res.ok
      ? { enabled: true, vault, intents: res.intents, notes: notesOf(vault, res.intents), reason: null }
      : { enabled: true, vault, intents: [], notes: new Map(), reason: res.reason };
    if (res.ok) warned.delete(root);
    else if (warned.get(root) !== res.reason) {
      warned.set(root, res.reason);
      warn('kernel', `${basename(root)}: the kernel could not be read, so no note has a kernel value — ${res.reason}`);
    }
    entry.value = value;
    entry.at = now();
    delete entry.pending;
    return value;
  });
  entries.set(root, entry);
  return entry.pending;
}

/** Forget a vault's answer — after a write to the kernel, so the next read sees it. */
export function forgetKernel(root?: string): void {
  if (root === undefined) {
    entries.clear();
    warned.clear();
  } else entries.delete(root);
}
