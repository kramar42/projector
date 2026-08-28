import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, resolvePath } from '../config.ts';
import { settingsFor } from '../settings.ts';
import { readAll } from '../index/indexer.ts';
import { patchNote } from '../server/mutate.ts';
import { desktopSessionFor, sessionsUnder, type SessionState } from '../sources/claude.ts';
import type { ProjectRepo } from '../schema/types.ts';
import { buildBriefing } from './briefing.ts';
import type { NoteContext } from './context.ts';
import {
  BRIEFING_PROMPT,
  branchFor,
  desktopLink,
  prepareWorkspace,
  workspacePath,
  type RepoResult,
} from './worktree.ts';

/**
 * Starting work on a note, decided once.
 *
 * `pj work` and `POST /api/note/:id/work` are the same act reached two ways, and
 * this file is why they cannot disagree about it: which branch, which directory,
 * which repos, what the briefing says and which link opens it. The CLI used to
 * hold all of it inline, so the app could only have had a second copy.
 *
 * The split is between deciding and doing. `planWork` reads and computes and
 * touches nothing — it is what `--dry-run` prints and what the panel's confirm
 * names — and `startWork` is the only half with side effects. Both refuse through
 * `NotWorkable`, so a caller renders one message rather than inventing wording
 * for each way it can be too early to start.
 */

/**
 * A refusal, not a fault: the note is fine, it just cannot be worked yet.
 *
 * Separate from `Error` so the two callers can answer differently without
 * matching on message text — the CLI exits 1 and the route answers 400, and
 * anything else is still a 500.
 */
export class NotWorkable extends Error {}

export interface WorkPlan {
  /** The directory the worktrees go in — outside every repo, so nothing to exclude. */
  workspace: string;
  branch: string;
  repos: ProjectRepo[];
}

/**
 * Where this note's work would go, without going there.
 *
 * @throws NotWorkable when there is nothing to lay out, or nowhere to lay it.
 */
export function planWork(ctx: NoteContext, root: string): WorkPlan {
  const jiraKeys = ctx.links.filter((l) => l.kind === 'jira').map((l) => l.ref);
  const branch = branchFor(ctx.id, { template: ctx.project?.branch, jiraKeys });

  // Required, with no fallback. Starting work creates real worktrees on disk, and
  // a guessed parent directory puts them somewhere the user did not choose and
  // will not think to look. Being told is cheap; being surprised is not.
  const workspaces = settingsFor(root).workspaces;
  if (!workspaces) {
    throw new NotWorkable(
      'projector has not been told where worktrees go. Run `pj setup`, put\n' +
        '`workspaces: ~/Code/wt` in .projector/config.yaml, or export\n' +
        'PROJECTOR_WORKSPACES.',
    );
  }

  const repos = ctx.project?.repos ?? [];
  if (!repos.length) {
    throw new NotWorkable(
      `"${ctx.id}" has no repos: its project declares none, or it has no project.\n` +
        `Add repos to the project note's frontmatter, then try again.`,
    );
  }

  return {
    workspace: workspacePath(resolvePath(workspaces, process.cwd()), ctx.project?.key ?? 'no-project', branch),
    branch,
    repos,
  };
}

/**
 * The briefing a plan would write, for a caller that is only showing it.
 *
 * The repos are reported as neither created nor failed, which is exactly true of
 * a plan: `buildBriefing` reads `error` to tell the new session which repos are
 * out of scope, and before anything runs none of them are.
 *
 * Each `path` is the *worktree* it would become, matching what `addWorktree`
 * reports — not the source checkout, which is the one path the briefing tells the
 * session never to touch. A dry run that printed the checkout contradicted its
 * own text.
 */
export function plannedBriefing(ctx: NoteContext, plan: WorkPlan): string {
  return buildBriefing({ ...plan, ctx, repos: plan.repos.map((r) => pending(r, plan.workspace)) });
}

const pending = (repo: ProjectRepo, workspace: string): RepoResult => {
  const name = repo.path.split('/').pop()!;
  return { name, path: join(workspace, name), created: false, error: null };
};

/** A session already working in the workspace, as an opening decision sees it. */
export interface OpenSession {
  uuid: string;
  state: SessionState;
  /** The first thing a human typed in it — the closest thing to a title. */
  opening: string;
  lastAt: string;
}

/**
 * What starting work does about a workspace that already has sessions in it.
 *
 * Preparing the worktrees was always idempotent — `addWorktree` returns the
 * directory it finds rather than failing — and opening never was: it fired
 * `claude://code/new`, which mints a session every time. Half the command
 * reopened and half duplicated, silently, so running `pj work` twice left two
 * sessions on the same branch with no sign that it had.
 *
 * Three outcomes rather than two, because "reuse it" is not always available:
 *
 * - `new` — nothing live here, so start one. Also what `--new` forces.
 * - `reopen` — a live session the desktop app holds a chat for, which is every
 *   session this command has ever started. Focus it instead of adding another.
 * - `running` — a live session the app has no chat for, so it was started from a
 *   terminal and there is no deep link that reaches it. Nothing is opened and
 *   the caller says so: quietly starting a second one is the behaviour being
 *   fixed, and picking it back up is something only the user can do.
 *
 * Only *live* sessions count. A finished one in this workspace is history, and
 * history is what the note's `workspace:` link shows.
 */
export type Opening =
  | { how: 'new'; link: string }
  | { how: 'reopen'; link: string; session: OpenSession }
  | { how: 'running'; session: OpenSession };

export function openingFor(workspace: string, fresh = false): Opening {
  const fallback: Opening = { how: 'new', link: desktopLink(workspace, BRIEFING_PROMPT) };
  if (fresh) return fallback;

  // Newest first, and the newest live one is the one to go back to.
  const live = sessionsUnder(workspace).filter((s) => s.state !== 'closed');
  const found = live[0];
  if (!found) return fallback;

  const session: OpenSession = {
    uuid: found.uuid,
    state: found.state,
    opening: found.summary.opening,
    lastAt: found.lastAt,
  };
  const chat = desktopSessionFor(found.uuid);
  return chat
    ? { how: 'reopen', link: `claude://claude.ai/epitaxy/${chat.sessionId}`, session }
    : { how: 'running', session };
}

export interface WorkStarted extends WorkPlan {
  /** One entry per declared repo, in order, whether or not it worked. */
  results: RepoResult[];
  briefingPath: string;
  /** Whether the note now carries `workspace:<path>`. */
  recorded: boolean;
  /** Why it does not, when it does not. Never fatal — see `startWork`. */
  recordError: string | null;
  /** Where to go, and whether that is a new session. Following it is the caller's move. */
  opening: Opening;
}

/**
 * Put `workspace:<path>` on the note, so its sessions can be read back later.
 *
 * The one thing `pj work` records, and it records a *place* rather than a
 * session: every session that ever runs in this directory is discoverable from
 * it, live or finished, without any of them having to register itself
 * (`sessionsUnder`). The briefing used to end by telling the new agent to run
 * `pj link <id> --session`, which meant the note stayed empty for the whole life
 * of the work and stayed empty for ever if the agent never got that far — which
 * is the normal case, not the edge one.
 *
 * Idempotent by the ref, so reopening a workspace does not bump `updated` on a
 * note nothing changed about.
 */
function recordWorkspace(root: string, id: string, workspace: string): boolean {
  // The one place this ref is written. Everything that reads one goes through
  // `parseLink`, so the kind is declared in `schema/links.ts` and spelled here.
  const ref = `workspace:${workspace}`;
  const rec = readAll(paths(root).notes).notes.get(id);
  if (!rec) throw new Error(`no note with id "${id}"`);
  const existing = rec.links.map((l) => l.raw);
  if (existing.includes(ref)) return false;
  patchNote(root, id, { links: [...existing, ref] });
  return true;
}

/**
 * Lay out the worktrees, write the briefing, record the workspace on the note,
 * and say where to go.
 *
 * Does not open anything. The CLI hands the link to `open` and the browser
 * navigates to it, and neither belongs in here — this file's whole job is that
 * the two agree about *what* is opened, including whether it is a new session at
 * all.
 *
 * The note write is the one step that cannot fail the command. The worktrees are
 * on disk and the briefing is written by the time it runs, so reporting failure
 * for the whole act because a link could not be appended would be a lie about
 * work that succeeded — it comes back as `recordError` for the caller to
 * mention.
 *
 * @throws NotWorkable when every declared repo failed, so there is nothing to open.
 */
export function startWork(
  ctx: NoteContext,
  plan: WorkPlan,
  root: string,
  opts: { fresh?: boolean } = {},
): WorkStarted {
  const results = prepareWorkspace(plan.workspace, plan.repos, plan.branch);

  // One repo failing does not stop the others — the briefing tells the new
  // session which are out of scope. All of them failing is different: there is no
  // workspace to work in, so nothing is written and nothing is opened.
  if (!results.some((r) => !r.error)) {
    throw new NotWorkable(
      `no worktree could be created:\n` +
        results.map((r) => `  ${r.name}: ${r.error}`).join('\n'),
    );
  }

  const briefingPath = join(plan.workspace, 'AGENT_BRIEFING.md');
  writeFileSync(briefingPath, buildBriefing({ ...plan, ctx, repos: results }), 'utf8');

  let recorded = false;
  let recordError: string | null = null;
  try {
    recorded = recordWorkspace(root, ctx.id, plan.workspace);
  } catch (err) {
    recordError = err instanceof Error ? err.message : String(err);
  }

  return {
    ...plan,
    results,
    briefingPath,
    recorded,
    recordError,
    opening: openingFor(plan.workspace, opts.fresh),
  };
}
