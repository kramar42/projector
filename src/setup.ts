import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CHANNELS } from './intake/connectors.ts';
import { CONFIG_FILE, settingsFor, settingsPath, settingsTemplate } from './settings.ts';
import { gh } from './sources/run.ts';
import { jiraGet } from './sources/jira.ts';

/**
 * What this vault can actually reach, asked rather than assumed.
 *
 * Setup fails in two ways that look identical from the outside — a credential
 * that was never set, and one that was set and is wrong — so nothing here infers
 * readiness from configuration being *present*. Where a check is cheap and
 * read-only it is made: Jira answers `/myself` or it does not, `gh` knows whether
 * it is signed in. A green line means something was reached.
 *
 * The report is the same object whether a person or the `pj-setup` skill is
 * reading it. `--json` is not a second code path.
 */

export type Status =
  /** Reached it. */
  | 'ready'
  /** Nothing configured. `fix` says what to write. */
  | 'unconfigured'
  /** Configured and refused, or configured and pointing at nothing. */
  | 'failing'
  /** `pj` holds no credential by design: something else gathers this one — the kernel's connectors. */
  | 'agent'
  /** Turned off in this vault's config. */
  | 'off';

export interface Probe {
  name: string;
  /** `channel` is intake; `enrich` is link display; `tool` is neither. */
  kind: 'channel' | 'enrich' | 'tool';
  status: Status;
  /** What it can do, or what went wrong. One line. */
  detail: string;
  /** The exact thing to change, when there is something to change. */
  fix?: string;
}

export interface Report {
  root: string;
  /** The config file, whether or not it exists yet. */
  config: string;
  configExists: boolean;
  probes: Probe[];
}

/** `~/.claude`, or wherever it was pointed. Machine-level, not per vault. */
const claudeHome = () => process.env.PROJECTOR_CLAUDE_HOME || join(homedir(), '.claude');

async function probeJira(root: string): Promise<{ status: Status; detail: string; fix?: string }> {
  const cfg = settingsFor(root).jira;
  if (!cfg) {
    return {
      status: 'unconfigured',
      detail: 'no host, account or token',
      fix: `put jira.url, jira.email and jira.token in ${CONFIG_FILE} — the token is an Atlassian API token, not a password`,
    };
  }
  const me = await jiraGet<{ displayName?: string }>(root, '/rest/api/3/myself', {}, 10_000);
  if (me.ok) return { status: 'ready', detail: `${cfg.url} as ${me.data.displayName ?? cfg.email}` };
  if (me.status === 401 || me.status === 403) {
    return {
      status: 'failing',
      detail: `${cfg.url} refused the credential (${me.status})`,
      fix: 'the token may have expired, or the email may not be the one it belongs to',
    };
  }
  return { status: 'failing', detail: `${cfg.url}: ${me.reason}`, fix: 'check the host is right and reachable' };
}

async function probeGh(): Promise<{ status: Status; detail: string; fix?: string }> {
  const res = await gh(['auth', 'status'], 10_000);
  if (res.ok) {
    const who = /account (\S+)/.exec(res.stdout + res.stderr)?.[1];
    return { status: 'ready', detail: who ? `signed in as ${who}` : 'signed in' };
  }
  return {
    status: 'unconfigured',
    detail: 'the gh CLI is not signed in',
    fix: 'run `gh auth login` — projector never stores a GitHub token of its own',
  };
}

function probeClaude(): { status: Status; detail: string; fix?: string } {
  const dir = join(claudeHome(), 'projects');
  if (existsSync(dir)) return { status: 'ready', detail: dir };
  return {
    status: 'unconfigured',
    detail: `no transcripts at ${dir}`,
    fix: 'export PROJECTOR_CLAUDE_HOME if Claude keeps its projects elsewhere',
  };
}

/**
 * An intake channel: what the kernel's connector for it gathers, read back. `pj`
 * holds no credential for it and fetches nothing — the owner runs the
 * connector — so all a probe can say is whether the vault
 * has a kernel to read from.
 */
function probeChannel(root: string, c: { connector: string; gather: string }): { status: Status; detail: string; fix?: string } {
  const k = settingsFor(root).kernel;
  if (!k.enabled || !k.bin) {
    return {
      status: 'unconfigured',
      detail: 'intake reads the kernel, and this vault has no kernel block',
      fix: `put kernel.enabled: true and kernel.bin in ${CONFIG_FILE}`,
    };
  }
  return { status: 'agent', detail: `triaged from the kernel's ${c.connector} connector — gathered by ${c.gather}` };
}

export async function probe(root: string): Promise<Report> {
  const s = settingsFor(root);
  const on = (name: string) => s.channels === null || s.channels.includes(name);
  const enrichOn = (kind: string) =>
    s.enrich === null || s.enrich.includes(kind) || s.enrich.includes(kind.split(':')[0]!);

  const probes: Probe[] = [];
  const add = (
    name: string,
    kind: Probe['kind'],
    enabled: boolean,
    r: { status: Status; detail: string; fix?: string },
  ) => probes.push({ name, kind, ...(enabled ? r : { status: 'off' as Status, detail: 'off in this vault' }) });

  // Channels, in the order `pj intake` judges them.
  for (const c of CHANNELS) add(c.name, 'channel', on(c.name), probeChannel(root, c));

  // Enrichment.
  const jira = await probeJira(root);
  const claude = probeClaude();
  add('jira', 'enrich', enrichOn('jira'), jira);
  add('gh', 'enrich', enrichOn('gh:pr'), await probeGh());
  add('claude', 'enrich', enrichOn('claude'), claude);
  add('doc', 'enrich', enrichOn('doc'), { status: 'ready', detail: 'local files; nothing to configure' });

  probes.push({
    name: 'workspaces',
    kind: 'tool',
    ...(s.workspaces
      ? { status: 'ready' as Status, detail: s.workspaces }
      : {
          status: 'unconfigured' as Status,
          detail: '`pj work` has nowhere to put worktrees',
          fix: `put \`workspaces: ~/Code/wt\` in ${CONFIG_FILE}`,
        }),
  });

  const config = settingsPath(root);
  return { root, config, configExists: existsSync(config), probes };
}

/**
 * Write a starter config, and never over an existing one.
 *
 * The file holds credentials somebody typed, so this refuses rather than merges:
 * a merge that got it wrong would destroy the one thing here that cannot be
 * regenerated.
 */
export function writeTemplate(
  root: string,
  channels: string[],
  enrich: boolean,
): { written: boolean; path: string; reason?: string } {
  const path = settingsPath(root);
  if (existsSync(path)) return { written: false, path, reason: 'it already exists — edit it in place' };
  writeFileSync(path, settingsTemplate(channels, enrich), 'utf8');
  ensureIgnored(root);
  return { written: true, path };
}

/**
 * Keep the config out of git.
 *
 * A vault is often a repository, and this is the one file under `.projector/`
 * that must never be committed. The line names the file rather than the folder,
 * because the vocabulary and the saved views in there are exactly what a vault
 * *should* commit.
 */
export function ensureIgnored(root: string): void {
  const ignore = join(root, '.gitignore');
  const line = `.projector/${CONFIG_FILE}`;
  const body = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (body.split('\n').some((l) => l.trim() === line)) return;
  const sep = !body || body.endsWith('\n') ? '' : '\n';
  writeFileSync(ignore, `${body}${sep}${line}\n`, 'utf8');
}

const MARK: Record<Status, string> = {
  ready: '✓',
  unconfigured: '·',
  failing: '✗',
  agent: '~',
  off: ' ',
};

/** The report as a person reads it. */
export function formatReport(r: Report): string {
  const L: string[] = [];
  L.push(`vault   ${r.root}`);
  L.push(`config  ${r.config}${r.configExists ? '' : '  (not written yet — `pj setup --init`)'}`);
  for (const kind of ['channel', 'enrich', 'tool'] as const) {
    const rows = r.probes.filter((p) => p.kind === kind);
    if (!rows.length) continue;
    L.push('');
    L.push(kind === 'channel' ? 'intake' : kind === 'enrich' ? 'enrichment' : 'tools');
    const w = Math.max(...rows.map((p) => p.name.length));
    for (const p of rows) {
      L.push(`  ${MARK[p.status]} ${p.name.padEnd(w)}  ${p.detail}`);
      // Aligned under the detail column: two spaces, the mark, a space, the
      // padded name, two spaces.
      if (p.fix) L.push(`${' '.repeat(w + 6)}→ ${p.fix}`);
    }
  }
  return L.join('\n');
}
