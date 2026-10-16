/**
 * The branch a note's work goes on.
 *
 * Laying out the worktrees is the kernel's now: `bin/kernel worktree <intent>`
 * starts an attempt for the note's open intent and makes one git worktree per
 * repository, on the branch projector names when the kernel asks about the note
 * (`kernel/about.ts`). This is that name, and intake's reading of a legacy
 * `<project>-wt-<branch>` workspace (`intake/match.ts`) uses the same rule, so
 * the two cannot disagree about which note a branch is.
 */

/** Branch name for a note: the project's template, a lone Jira key, else the id. */
export function branchFor(
  cardId: string,
  opts: { template?: string; jiraKeys?: string[] },
): string {
  if (opts.template) {
    // `{note}` is the placeholder the manual documents; `{card}` and `{id}` are
    // the spellings templates written before the card→note rename carry. All
    // three mean the note's id.
    const branch = opts.template.replace(/\{(?:note|card|id)\}/g, cardId);
    // Anything else left in braces would become a literal `{...}` branch shared
    // by every note in the project — refuse it while it is still a template,
    // not a worktree.
    const leftover = branch.match(/\{[^}]*\}/);
    if (leftover) {
      throw new Error(
        `branch template "${opts.template}" has an unknown placeholder ${leftover[0]} — {note} is the one that names the note`,
      );
    }
    return branch;
  }
  if (opts.jiraKeys?.length === 1) return opts.jiraKeys[0]!;
  return cardId;
}
