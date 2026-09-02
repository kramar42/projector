import { execFile } from 'node:child_process';

/**
 * Read-only transport, shared by everything that reaches outside the vault.
 *
 * This lives in `src/sources/` rather than under `enrich/` because two different
 * consumers need it and neither owns it: enrichment resolves a ref it was given,
 * intake discovers refs it was not. Same credential, same subprocess, opposite
 * question — so what is shared is the way out, not the store or the policy.
 */

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run a read-only command with a hard timeout.
 *
 * Never rejects: a failure is part of the result. A fetcher that threw would
 * propagate into a request and take a view down with it, and the whole point of
 * enrichment is that it cannot do that.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? 12_000,
        cwd: opts.cwd,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...opts.env },
      },
      (err, stdout, stderr) => {
        // A child killed by the timeout reports a signal and no exit code, and
        // whatever it had printed to stderr — for `claude -p`, a warning about
        // stdin. The reason a caller shows has to say what actually happened.
        const timedOut = Boolean(err && (err as { killed?: boolean }).killed && (err as { signal?: string }).signal);
        const why = timedOut ? `timed out after ${Math.round((opts.timeoutMs ?? 12_000) / 1000)}s` : '';
        resolve({
          ok: !err,
          stdout: String(stdout ?? ''),
          stderr: [why, String(stderr ?? '').trim()].filter(Boolean).join('; '),
          code: err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code?: number }).code!
            : err
              ? 1
              : 0,
        });
      },
    );
    child.on('error', () => resolve({ ok: false, stdout: '', stderr: 'spawn failed', code: null }));
    // Nothing here ever feeds a child; say so. `claude -p` otherwise waits three
    // seconds for piped input, warns that none came, and that warning is then
    // the only thing in stderr when the run fails for some other reason.
    child.stdin?.end();
  });
}

/**
 * `gh` needs GITHUB_TOKEN unset to use the keyring credential for a private
 * org — with the variable present it authenticates as the wrong identity and
 * 404s on private repos.
 */
export function gh(args: string[], timeoutMs = 15_000): Promise<RunResult> {
  return run('gh', args, { timeoutMs, env: { GITHUB_TOKEN: undefined, GH_TOKEN: undefined } });
}

export function firstLine(s: string, max = 200): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line.trim();
}

/** "3 days ago" style, from an ISO timestamp or epoch millis. */
export function ago(when: string | number | undefined): string {
  if (!when) return '';
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}
