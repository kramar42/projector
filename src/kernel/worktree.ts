import { paths } from '../config.ts';
import { readAll } from '../index/indexer.ts';
import { patchNote } from '../server/mutate.ts';
import { settingsFor } from '../settings.ts';
import { spawnRunner, vaultName, type Runner } from '../intake/kernel.ts';
import { kernelEnv } from './query.ts';
import { readIntents } from './read.ts';
import { notesOf, shortId } from './state.ts';

/**
 * Starting work on a note, through the owner's kernel.
 *
 * The act is the kernel's: `<kernel.bin> worktree <intent> --open none --json`
 * starts an attempt of its `worktree` spec for the note's open intent, makes one
 * git worktree per repository under the kernel's workspaces, installs the hooks
 * that record each commit in the attempt, and writes `BRIEF.md`. The repos, the
 * branch and what the work is about come back to projector as a question about
 * the note — the manifest's `context` command, `pj context --alias …
 * --json-kernel` (`about.ts`) — so nothing here decides them.
 *
 * What is projector's: finding the note's intent, through the same saved query
 * the board's `kernel` axis reads (`read.ts`); asking the kernel; and recording
 * `workspace:<dir>` on the note, so its sessions are read back off the directory
 * (`enrich/claudeSession.ts`) and intake attributes a session inside it to the
 * note (`intake/match.ts`).
 *
 * Two calls, as the panel makes them: `commit: false` passes `--dry-run`, which
 * starts no attempt and writes nothing anywhere — the plan the confirm names —
 * and `commit: true` does it. The kernel call goes through a `Runner`, so a
 * test hands a fake and never reaches the owner's kernel.
 */

/**
 * A refusal, not a fault: the note is fine, it just cannot be worked yet — no
 * intent, a closed one, a vault whose kernel block is off, or the kernel's own
 * refusal (no repositories, a plan with problems). The route answers 400.
 */
export class NotWorkable extends Error {}

/** There is no such note. The route answers 404. */
export class NoNote extends Error {}

/** The kernel could not be reached or did not answer in shape. The route answers 502. */
export class KernelFailed extends Error {}

/** One repository of the attempt's workspace, as the kernel reports it. */
export interface WorkRepo {
  name: string;
  /** The repository's own checkout. */
  path: string;
  /** Where its worktree is, or would be. */
  worktree: string;
  base?: string;
  /** The conventions file the brief tells the session to read first. */
  guide?: string;
  /** On a commit: the worktree is there. */
  ok?: boolean;
  /** On a commit: why this one was not made. Out of scope for the attempt. */
  error?: string;
  hooksError?: string;
}

export interface KernelWork {
  note: string;
  /** The note's open intent, the attempt's. */
  intent: string;
  /** `commit: false`: nothing was started or written. */
  dryRun: boolean;
  /** The workspace: every worktree is a folder in it, beside `BRIEF.md`. */
  dir: string;
  branch: string;
  repos: WorkRepo[];
  /** Who the kernel asked about the note, and whether it answered. */
  context: { alias: string; system: string; error?: string } | null;
  /** On a commit: the attempt the kernel started. */
  attempt: string | null;
  /** On a commit: the desktop app's link that opens a session in the workspace. */
  link: string | null;
  /** On a commit: the same session from a terminal. */
  command: string | null;
  /** Whether the note now carries `workspace:<dir>`. */
  recorded: boolean;
  /** Why it does not, when it does not. Never fatal: the attempt is running by then. */
  recordError: string | null;
}

/**
 * Making worktrees in big repositories and asking projector about the note
 * twice (the kernel plans again on a commit) takes longer than a query, so the
 * vault's `kernel.timeout` is a floor here, not the ceiling.
 */
const WORKTREE_TIMEOUT_S = 180;

/**
 * The note's open intent, or the reason there is none to start work on.
 *
 * Read fresh through `readIntents` rather than the board's cache: an attempt is
 * about to be started for the answer, and an intent the owner closed a moment
 * ago must not get one.
 */
export async function openIntentOf(root: string, id: string, run: Runner = spawnRunner): Promise<string> {
  const settings = settingsFor(root);
  const cfg = settings.kernel;
  if (!cfg.enabled) {
    throw new NotWorkable(
      'work on a note starts in the kernel, as an attempt for its open intent, and this vault’s kernel block is off: set kernel.enabled in .projector/config.yaml',
    );
  }
  if (!cfg.bin) throw new NotWorkable('work on a note starts in the kernel, and kernel.bin is not set in .projector/config.yaml');
  const vault = vaultName(root, settings);
  const read = await readIntents(cfg, vault, run);
  if (!read.ok) throw new KernelFailed(`the kernel could not be read: ${read.reason}`);
  const k = notesOf(vault, read.intents).get(id);
  if (!k) throw new NotWorkable(noIntent(id));
  if (k.status === 'open') return k.intent;
  throw new NotWorkable(
    k.status === 'proposed'
      ? `"${id}"’s intent ${shortId(k.intent)} is still a proposal: the owner opens it before work starts`
      : `"${id}"’s intent ${shortId(k.intent)} is ${k.status}: only an open intent is worked`,
  );
}

function noIntent(id: string): string {
  return (
    `"${id}" has no intent in the kernel, so there is nothing to start work on: open one first — what should ` +
    `happen and how to judge it — in the note's panel, or with \`pj kernel intent ${id} --criterion <how to judge>\``
  );
}

/**
 * Plan (`commit: false`) or start (`commit: true`) the kernel's worktree attempt
 * for a note, and on a start record the workspace on the note.
 *
 * @throws NoNote, NotWorkable, KernelFailed — see each.
 */
export async function startWork(
  root: string,
  id: string,
  opts: { commit: boolean; run?: Runner },
): Promise<KernelWork> {
  if (!readAll(paths(root).notes).notes.has(id)) throw new NoNote(`no note "${id}"`);
  const run = opts.run ?? spawnRunner;
  const intent = await openIntentOf(root, id, run);

  const cfg = settingsFor(root).kernel;
  const args = ['worktree', intent, '--open', 'none', '--json', ...(opts.commit ? [] : ['--dry-run'])];
  let out: Awaited<ReturnType<Runner>>;
  try {
    out = await run(cfg.bin!, args, '', kernelEnv(cfg), Math.max(cfg.timeoutSeconds, WORKTREE_TIMEOUT_S) * 1000);
  } catch (e) {
    throw new KernelFailed(`kernel worktree: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out.code === null) throw new KernelFailed('kernel worktree did not finish in time');
  if (out.code !== 0) throw new NotWorkable(`kernel worktree: ${refusal(out.stdout, out.stderr)}`);

  const work = answer(out.stdout, id, intent, !opts.commit);
  if (opts.commit) {
    try {
      work.recorded = recordWorkspace(root, id, work.dir);
    } catch (e) {
      work.recordError = e instanceof Error ? e.message : String(e);
    }
  }
  return work;
}

/**
 * The kernel's refusal in its own words: its last line, without the `error: `
 * the CLI prefixes and the EDN data it may print after the message.
 */
function refusal(stdout: string, stderr: string): string {
  const line = (stderr || stdout).trim().split('\n').pop() ?? '';
  return line.replace(/^error:\s*/, '').replace(/\s+\{:[^]*\}\s*$/, '').slice(0, 400) || 'refused, saying nothing';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** `--json`'s object, from the whole output or else its last line (a launcher may print first). */
function parseObject(stdout: string): Record<string, unknown> {
  const all = stdout.trim();
  for (const text of [all, all.split('\n').pop() ?? '']) {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // the next candidate
    }
  }
  throw new KernelFailed('kernel worktree --json printed no JSON object');
}

function answer(stdout: string, note: string, intent: string, dryRun: boolean): KernelWork {
  const a = parseObject(stdout);
  const dir = str(a.dir);
  const branch = str(a.branch);
  if (!dir || !branch) throw new KernelFailed('kernel worktree answered no workspace and branch');
  const repos: WorkRepo[] = (Array.isArray(a.repos) ? a.repos : []).flatMap((r): WorkRepo[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const name = str(o.name);
    const path = str(o.path);
    if (!name || !path) return [];
    return [
      {
        name,
        path,
        worktree: str(o.worktree) ?? path,
        ...(str(o.base) ? { base: str(o.base)! } : {}),
        ...(str(o.guide) ? { guide: str(o.guide)! } : {}),
        ...(o.ok === true ? { ok: true } : {}),
        ...(str(o.error) ? { error: str(o.error)! } : {}),
        ...(str(o['hooks-error']) ? { hooksError: str(o['hooks-error'])! } : {}),
      },
    ];
  });
  const c = a.context && typeof a.context === 'object' ? (a.context as Record<string, unknown>) : null;
  const opened = a.opened && typeof a.opened === 'object' ? (a.opened as Record<string, unknown>) : {};
  return {
    note,
    intent,
    dryRun,
    dir,
    branch,
    repos,
    context: c
      ? { alias: str(c.alias) ?? '', system: str(c.system) ?? '', ...(str(c.error) ? { error: str(c.error)! } : {}) }
      : null,
    attempt: str(a.attempt) ?? null,
    link: str(opened.link) ?? null,
    command: str(opened.command) ?? null,
    recorded: false,
    recordError: null,
  };
}

/**
 * Put `workspace:<dir>` on the note, so its sessions can be read back later.
 *
 * It records a *place* rather than a session: every session that ever runs in
 * the directory is discoverable from it, live or finished, without any of them
 * having to register itself (`sessionsUnder`). The kernel records the attempt's
 * own session too (its SessionStart hook); this is the note's view of the same
 * work, derived from nothing the kernel holds.
 *
 * Idempotent by the ref, so starting again in the same workspace does not bump
 * `updated` on a note nothing changed about. No base mtime: the ref is derived
 * from the act, appending it twice is a no-op, and there is nothing to conflict
 * with.
 */
export function recordWorkspace(root: string, id: string, dir: string): boolean {
  // The one place this ref is written. Everything that reads one goes through
  // `parseLink`, so the kind is declared in `schema/links.ts` and spelled here.
  const ref = `workspace:${dir}`;
  const rec = readAll(paths(root).notes).notes.get(id);
  if (!rec) throw new Error(`no note with id "${id}"`);
  const existing = rec.links.map((l) => l.raw);
  if (existing.includes(ref)) return false;
  patchNote(root, id, { links: [...existing, ref] });
  return true;
}
