import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePath } from '../config.ts';
import { settingsFor } from '../settings.ts';
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

export interface WorkStarted extends WorkPlan {
  /** One entry per declared repo, in order, whether or not it worked. */
  results: RepoResult[];
  briefingPath: string;
  /** Where to open it. Following the link is the caller's move, not this one's. */
  link: string;
}

/**
 * Lay out the worktrees, write the briefing, and say how to open it.
 *
 * Does not open anything. The CLI hands the link to `open` and the browser
 * navigates to it, and neither belongs in here — this file's whole job is that
 * the two agree about *what* is opened.
 *
 * @throws NotWorkable when every declared repo failed, so there is nothing to open.
 */
export function startWork(ctx: NoteContext, plan: WorkPlan): WorkStarted {
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

  return { ...plan, results, briefingPath, link: desktopLink(plan.workspace, BRIEFING_PROMPT) };
}
