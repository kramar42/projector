import { join } from 'node:path';
import { appRoot } from '../config.ts';
import { spawnRunner, type Runner } from '../intake/kernel.ts';
import type { Settings } from '../settings.ts';
import { kernelEnv, said } from './read.ts';

/**
 * `pj kernel register`: `<kernel.bin> register <repo>/kernel/manifest.json`.
 *
 * The manifest is projector's own file, beside the code that writes what it
 * declares: the system, what it writes (`vault/` and `intake/` events, `vault:`
 * entities, proposals and the owner's commitments, no judgments), the specs it
 * brings and how its facts are synced. Registering hands it to the kernel, which
 * from then on checks every batch projector sends against it. Registering the
 * same manifest again records nothing, so this is safe to run after any change.
 */

/** Where the manifest is: `kernel/manifest.json` at the root of this checkout. */
export const MANIFEST = join(appRoot, 'kernel', 'manifest.json');

export type Registered = { ok: true; said: string } | { ok: false; reason: string };

/** One `register` call against the vault's kernel. Never throws. */
export async function register(cfg: Settings['kernel'], run: Runner = spawnRunner, manifest = MANIFEST): Promise<Registered> {
  if (!cfg.bin) return { ok: false, reason: 'kernel.bin is not set' };
  try {
    const { code, stdout, stderr } = await run(cfg.bin, ['register', manifest], '', kernelEnv(cfg), cfg.timeoutSeconds * 1000);
    if (code !== 0) return { ok: false, reason: `kernel register ${said(code, stdout, stderr)}` };
    return { ok: true, said: stdout.trim() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
