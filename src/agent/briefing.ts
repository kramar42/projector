import { renderContext, type NoteContext } from './context.ts';
import type { RepoResult } from './worktree.ts';

/**
 * The briefing an agent reads before touching anything.
 *
 * Five steps, and step 4 is the point: read everything first, then **stop and
 * ask**. Two framings in it are worth keeping word for word — "the card is not
 * the whole story", and report what was deliberately left out.
 */
export function buildBriefing(input: {
  ctx: NoteContext;
  workspace: string;
  branch: string;
  repos: RepoResult[];
}): string {
  const { ctx, workspace, branch, repos } = input;
  const ok = repos.filter((r) => !r.error);
  const failed = repos.filter((r) => r.error);

  const L: string[] = [];
  L.push(`# Working on: ${ctx.title}`);
  L.push('');
  L.push(`- card: \`${ctx.id}\`  ·  file: \`${ctx.file}\``);
  L.push(`- workspace: \`${workspace}\``);
  L.push(`- branch: \`${branch}\` — commit here, in every repo you touch`);
  if (ctx.project) L.push(`- project: \`${ctx.project.key}\` (${ctx.project.chain.join(' → ')})`);
  L.push('');

  L.push('## Repositories in this workspace');
  L.push('');
  if (ok.length) {
    for (const r of ok) L.push(`- \`${r.name}/\` → ${r.path}`);
  } else {
    L.push('- none could be prepared');
  }
  if (failed.length) {
    L.push('');
    L.push('Not prepared, so out of scope for this session:');
    for (const r of failed) L.push(`- \`${r.name}\` — ${r.error}`);
  }
  L.push('');
  L.push(
    'These are git worktrees created for this card. Work only here; never edit the main checkouts. ' +
      'If a change belongs in a repo that is not in this workspace, stop and say so rather than reaching outside it.',
  );
  L.push('');

  L.push('## Step 1 — Read the card, then its sources');
  L.push('');
  L.push(
    'The context below is complete as of launch. **The card is not the whole story**: open every ' +
      'linked Jira issue, pull request and document before deciding what the work is. A title is not a brief.',
  );
  L.push('');
  L.push('---');
  L.push('');
  L.push(renderContext(ctx).trim());
  L.push('');
  L.push('---');
  L.push('');

  L.push('## Step 2 — Learn how these codebases are built');
  L.push('');
  L.push(
    'For each repository above, read `README.md`, `CLAUDE.md` and anything under `docs/` before ' +
      'writing a line. Follow the conventions you find there. Where two repos disagree, the one you ' +
      'are editing wins.',
  );
  L.push('');

  L.push('## Step 3 — Project instructions');
  L.push('');
  if (ctx.project?.instructions.length) {
    L.push('Already included in the context above, inherited outermost-project-first. Follow them.');
  } else {
    L.push(
      'None recorded for this project. If rules emerge while you work, offer them for the project ' +
        "project's `instructions` rather than keeping them in your head.",
    );
  }
  L.push('');

  L.push('## Step 4 — Ask before you build');
  L.push('');
  L.push(
    'Once you have read the docs and the linked sources: **STOP.** Ask clarifying questions about ' +
      'exactly what this card needs, and wait for answers. Do not plan and do not write code before ' +
      'they are answered.',
  );
  L.push('');

  L.push('## Step 5 — Then build');
  L.push('');
  L.push('Only after the questions are answered:');
  L.push('');
  L.push('1. Implement the change.');
  L.push('2. Run the tests of every repo you touched, and say which commands you ran.');
  L.push('3. Report **per repo**: what changed, what passed, and **what you deliberately left out**.');
  L.push('4. Link this session back to the card so it can be found later:');
  L.push('');
  L.push('   ```bash');
  L.push(`   pj link ${ctx.id} --session`);
  L.push('   ```');
  L.push('');
  L.push(
    'Keep each repo\'s commits to that repo\'s own concern — do not mix a change to one into a ' +
      'commit for another.',
  );
  L.push('');
  return L.join('\n');
}
