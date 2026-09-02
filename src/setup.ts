import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { paths, resolvePath } from './config.ts';
import { readAll } from './index/indexer.ts';
import { channelNames } from './intake/run.ts';
import { CONFIG_FILE, settingsFor, settingsPath, settingsTemplate } from './settings.ts';
import { gh, run } from './sources/run.ts';
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
  /** `pj` holds no credential by design: an agent fetches this one over MCP. */
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

function probeGit(root: string): { status: Status; detail: string; fix?: string } {
  let repos: string[] = [];
  try {
    const { notes } = readAll(paths(root).notes);
    const seen = new Set<string>();
    for (const rec of notes.values()) {
      for (const r of rec.project?.repos ?? []) {
        const path = resolve(resolvePath(r.path, root));
        if (!seen.has(path)) seen.add(path);
      }
    }
    repos = [...seen];
  } catch {
    repos = [];
  }
  if (!repos.length) {
    return {
      status: 'unconfigured',
      detail: 'no project note declares any repos',
      fix: 'give a project note a `project.repos` block — `pj set <id> --set "project.repos=[{path: ~/Code/thing, base: main}]"`',
    };
  }
  const missing = repos.filter((r) => !existsSync(r));
  if (missing.length === repos.length) {
    return {
      status: 'failing',
      detail: `${repos.length} declared, none present on disk`,
      fix: `first missing: ${missing[0]}`,
    };
  }
  const note = missing.length ? `, ${missing.length} missing` : '';
  return { status: 'ready', detail: `${repos.length - missing.length} repo(s)${note}` };
}

/**
 * Slack.
 *
 * Deliberately never `ready` or `unconfigured`: `pj` has no Slack credential
 * and is not going to grow one. The agent fetches it over MCP and hands the
 * results back, so only the agent can verify the MCP server.
 */
const AGENT_FETCHED: Record<string, string> = {
  slack: 'fetched by the relay agent over the Slack MCP tools named in mcp.slack; pj holds no Slack credential',
};

async function probeGmail(root: string): Promise<{ status: Status; detail: string; fix?: string }> {
  const cfg = settingsFor(root).gmail;
  const res = await run(
    cfg.command,
    [
      '--readonly',
      '--gmail-no-send',
      '--no-input',
      '--json',
      ...(cfg.account ? ['--account', cfg.account] : []),
      'gmail',
      'search',
      'after:0',
      '--max',
      '1',
    ],
    { timeoutMs: 15_000 },
  );
  if (res.ok) return { status: 'ready', detail: `read-only through ${cfg.command}` };
  const missing = /spawn failed|ENOENT|not found/i.test(res.stderr);
  return {
    status: missing ? 'unconfigured' : 'failing',
    detail: missing ? `${cfg.command} is not installed` : `${cfg.command} could not read Gmail`,
    fix: missing
      ? 'install gogcli, then authorize Gmail with read-only scopes'
      : 'run `gog auth list`, then authorize the account with read-only Gmail access',
  };
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

  // Channels, in the order `pj intake` sweeps them.
  const jira = await probeJira(root);
  const gmail = await probeGmail(root);
  const claude = probeClaude();
  for (const name of channelNames()) {
    if (name === 'claude') add(name, 'channel', on(name), claude);
    else if (name === 'git') add(name, 'channel', on(name), probeGit(root));
    else if (name === 'jira') add(name, 'channel', on(name), jira);
    else if (name === 'gmail' && s.gmail.transport === 'mcp') {
      add(name, 'channel', on(name), { status: 'agent', detail: 'fetched by the relay agent over the Gmail MCP tools named in mcp.gmail' });
    } else if (name === 'gmail') add(name, 'channel', on(name), gmail);
    else add(name, 'channel', on(name), { status: 'agent', detail: AGENT_FETCHED[name] ?? '' });
  }

  // Enrichment. Jira and Claude reuse the answers above rather than asking twice.
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
