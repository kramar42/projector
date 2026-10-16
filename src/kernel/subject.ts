import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { paths } from '../config.ts';
import { listVaults } from '../vault.ts';
import { vaultName } from '../intake/kernel.ts';
import { INSTRUCTIONS_FILE } from '../index/project.ts';
import { branchFor } from '../agent/worktree.ts';
import { renderContext, type NoteContext } from '../agent/context.ts';

/**
 * What projector says about one of its notes when the kernel asks.
 *
 * Starting work on a note is the kernel's act now: `bin/kernel worktree
 * <intent>` starts an attempt for the note's open intent, lays out one git
 * worktree per repository and writes the brief the session reads. The kernel
 * names no app, so it asks the system whose `writes.entities` prefix covers the
 * intent's subject — `vault:` is projector's — through the manifest's `context`
 * command: `pj context --alias vault:<vault>:<id> --json-kernel`, which prints
 * this, one JSON object.
 *
 * - `text` is the note's context as `pj context` renders it — project chain,
 *   inherited `AGENTS.md` instructions, relations, links, body — after a short
 *   preface saying where the note lives. The kernel embeds it in `BRIEF.md` as
 *   what the work is about.
 * - `repos` are the note's project's declared repositories, absolute, with a
 *   declared base where there is one. The kernel makes a worktree in each.
 * - `branch` is the project's branch template applied to the note, a lone Jira
 *   key, else the id — the same rule `pj work` used, so a note's branch did not
 *   change when the act moved (`branchFor`).
 *
 * Assembly only (C8): nothing here judges whether the note can be worked. A
 * note with no repos answers with none, and the kernel refuses with its own
 * words, naming projector as the system that named none.
 */
export interface SubjectContext {
  text: string;
  repos: { path: string; base?: string }[];
  branch: string;
  title: string;
}

/** `vault:<vault>:<id>` — the alias the import and the sink give every note (`noteAlias`). */
export function parseNoteAlias(alias: string): { vault: string; id: string } | null {
  const m = /^vault:([^:]+):(.+)$/.exec(alias.trim());
  return m ? { vault: m[1]!, id: m[2]! } : null;
}

export type FoundVault = { ok: true; root: string } | { ok: false; reason: string };

/**
 * The registered vault an alias's vault part names.
 *
 * By the name the vault goes by in the kernel (`vaultName`): `kernel.vault`
 * when its file sets one, else its registered name — the name `--vault` takes
 * — else its folder's. Read backwards rather than looked up as a registry name,
 * so a vault that pinned its kernel name through a rename still answers for the
 * aliases it wrote.
 */
export function vaultForAlias(name: string): FoundVault {
  const vaults = listVaults().filter((v) => v.exists);
  const hits = vaults.filter((v) => vaultName(v.path) === name);
  if (hits.length === 1) return { ok: true, root: hits[0]!.path };
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `${hits.length} registered vaults go by "${name}" in the kernel (${hits.map((v) => v.path).join(', ')}): set kernel.vault in one of them`,
    };
  }
  return {
    ok: false,
    reason:
      `no registered vault goes by "${name}" in the kernel` +
      (vaults.length ? `. Registered: ${vaults.map((v) => v.name).join(', ')}` : '; none is registered'),
  };
}

/** The context the kernel embeds, for a note already assembled. Throws on a branch template it cannot apply. */
export function subjectContext(ctx: NoteContext, where: { root: string; vault: string }): SubjectContext {
  const jiraKeys = ctx.links.filter((l) => l.kind === 'jira').map((l) => l.ref);
  const branch = branchFor(ctx.id, { template: ctx.project?.branch, jiraKeys });
  return {
    text: preface(ctx, where) + renderContext(ctx),
    repos: (ctx.project?.repos ?? []).map((r) => ({ path: resolve(r.path), ...(r.base ? { base: r.base } : {}) })),
    branch,
    title: ctx.title,
  };
}

/**
 * Where the note lives, and the two things the old `AGENT_BRIEFING.md` said that
 * the kernel's brief cannot know: the vault's `memory/AGENTS.md`, the day agent's
 * own account of how to read this vault's sources — named, never embedded, since
 * it is that agent's file to rewrite — and, for a project with none, where
 * instructions that emerge belong.
 */
function preface(ctx: NoteContext, { root, vault }: { root: string; vault: string }): string {
  const L: string[] = [];
  L.push(
    `Projector note \`${ctx.id}\` in the vault \`${vault}\` (\`${root}\`). ` +
      `\`pj --vault ${vault} context ${ctx.id} --fresh\` reads it again with every link resolved as of now.`,
  );
  const memory = join(paths(root).memory, INSTRUCTIONS_FILE);
  if (existsSync(memory)) {
    L.push('');
    L.push(
      `Before the sources, read \`${memory}\`: how the agent that runs this vault's days reads them. ` +
        "It is that agent's file: read it and leave it as it is.",
    );
  }
  if (ctx.project && !ctx.project.instructions.length) {
    L.push('');
    L.push(
      `No instructions are recorded for the project \`${ctx.project.key}\`. Rules that emerge while working ` +
        `belong in its \`${INSTRUCTIONS_FILE}\`, beside its note: offer them rather than keeping them in your head.`,
    );
  }
  L.push('');
  return L.join('\n') + '\n';
}
