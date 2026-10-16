import { basename } from 'node:path';
import { settingsFor, type Settings } from '../settings.ts';
import { vaultName, type Runner } from '../intake/kernel.ts';
import { warn } from '../server/log.ts';
import { ask, QUERIES } from './query.ts';
import { intentsOf, notesOf, type KernelIntent, type KernelNote } from './state.ts';

/**
 * The kernel read: projector's saved query, `<kernel.bin> query --saved
 * projector/vault-intents --in prefix=vault:<vault>: --json` (`query.ts`), once
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
 * no `kernel.bin`, a binary that is not there, one that exits non-zero, refuses
 * the query (one that has not registered projector's queries yet) or prints
 * something other than an answer — is an empty answer with a `reason`, warned
 * once per vault until it recovers. Off unless the vault's `kernel:` block says
 * `enabled: true`, exactly as the sink is.
 */

export const KERNEL_TTL_MS = 30_000;

/** A read is on the request path; a kernel that takes longer than this is treated as absent. */
const READ_TIMEOUT_S = 10;

/**
 * Rows the read lets the kernel return: one per intent, alias and piece of the
 * latest verdict's evidence. The kernel refuses more than it is allowed rather
 * than cutting them, which is a reason here, never a partial board.
 */
const READ_LIMIT = 10_000;

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

/** One read of every intent about this vault's notes. Never throws. */
export async function readIntents(
  cfg: Settings['kernel'],
  vault: string,
  run?: Runner,
): Promise<IntentsRead> {
  const r = await ask(cfg, QUERIES.vaultIntents, { prefix: `vault:${vault}:` }, {
    run,
    timeoutMs: READ_TIMEOUT_S * 1000,
    limit: READ_LIMIT,
  });
  if (!r.ok) return r;
  return { ok: true, intents: intentsOf(r.rows) };
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
