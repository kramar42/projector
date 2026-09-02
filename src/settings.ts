import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { paths, resolvePath } from './config.ts';

/**
 * What a vault needs to reach the world: which channels it sweeps, whether its
 * links are enriched, and the credentials both of those want.
 *
 * **Why this lives in the vault and not beside the app.** A credential belongs
 * to the channel that spends it, and which channels are worth sweeping is a fact
 * about *this* set of notes — a vault of work notes wants Jira and the project
 * repos; a vault of reading notes wants neither, and being asked about them
 * every sweep is noise. `vaults.json` stays what it always was: a list of paths
 * an install has opened, holding nothing you would mind reading aloud.
 *
 * **The file is not committed.** `pj setup` writes `.projector/config.yaml` and
 * adds it to the vault's `.gitignore`, because a vault is often a git repository
 * and a token in one is a token pushed. Nothing else in `.projector/` is secret,
 * so the ignore names this file rather than the folder.
 *
 * **The environment wins.** Every credential and path here has a `PROJECTOR_*`
 * variable that already meant it, and the variable is still read first —
 * `channels:` and `enrich:` are the two file-only keys, being vault policy
 * rather than machine facts. A file is where a
 * setting lives; a variable is how you override it for one run without editing
 * anything — which is what CI does, and what every test in this repository does.
 * The precedence is one way round and never the other, so "why is it not picking
 * up my token" has one answer: something exported it.
 *
 * Read per vault and memoised on the file's mtime, because the server holds
 * several vaults open at once and one of them must never answer with another's
 * credentials.
 */

/** Everything a channel or fetcher may ask a vault for. */
export interface Settings {
  /** Channel names this vault sweeps. `null` means all of them — the default. */
  channels: string[] | null;
  /** Link kinds to enrich. `null` means every kind that has a fetcher. */
  enrich: string[] | null;
  jira: { url: string; email: string; token: string } | null;
  /** Overrides the default intake query. */
  jql: string | null;
  gitAuthor: string | null;
  /** Where `pj work` puts worktrees. */
  workspaces: string | null;
  /** A template like `cursor://file{path}` for opening a `doc:` ref. */
  docUrl: string | null;
  /**
   * Sweeping on a timer, in the server, writing candidates into the vault.
   *
   * **Off unless a vault asks**, and that is not timidity. Everything else here
   * changes how a command answers when you run it; this one makes the app write
   * notes you did not ask for, at whatever rate your commits and sessions happen.
   * Nothing judges them yet, so a vault that turned it on by default would fill
   * with its owner's own progress and the first thing anyone would do is turn it
   * off — which is a worse outcome than never having offered it.
   */
  poll: {
    enabled: boolean;
    everySeconds: number;
    /**
     * Local hours a tick may run in, `[from, until)`, or null for always. A
     * window that wraps midnight is written `[22, 6]`. Outside it the timer
     * still fires and the tick says it skipped — a colleague's evening reply
     * is still there at eight.
     */
    hours: { from: number; until: number } | null;
  };
  /**
   * Who judges the candidates a sweep found.
   *
   * On by default, because an unjudged queue of your own commits is the failure
   * the queue exists to prevent, and arriving there by omission would be worse
   * than the feature not working. `enabled: false` is the explicit way to say
   * "write everything down and let me sort it".
   */
  classify: {
    enabled: boolean;
    /** Local by default. `claude` remains an explicit compatibility transport. */
    provider: 'ollama' | 'claude';
    /** Ollama's native API root; unused by the Claude transport. */
    url: string;
    command: string;
    model: string;
    /**
     * How many candidates one call judges. A local model generating at a few
     * tokens a second cannot answer for twenty conversations inside any sane
     * timeout, so a channel's candidates are judged in batches of this many;
     * a batch is still the unit that arrives together, so a model can still say
     * that six commits are one afternoon.
     */
    batch: number;
    /** How long one call may take before the tick holds. */
    timeoutSeconds: number;
  };
  /**
   * How Gmail is read. `mcp` is the relay agent over the tools named below;
   * `gog` is gogcli under its runtime read-only guards. Unset, it follows the
   * tools: named means `mcp`, unnamed means `gog`.
   */
  gmail: { command: string; account: string | null; transport: 'mcp' | 'gog' };
  /**
   * Which MCP tools the relay may call, per channel, and how far it may page.
   *
   * Empty is the default, and a channel with no tools is not fetched. Nothing
   * here can tell a read tool from a write one by its name, so nothing guesses.
   * The vault lists tools explicitly and Claude Code refuses everything else.
   * `pages` bounds each search the relay runs; a run that hits it reports itself
   * truncated and holds its cursor, so nothing is skipped — only deferred.
   */
  mcp: {
    slack: string[];
    gmail: string[];
    command: string;
    model: string;
    pages: number;
    /** How long one relay run may take before the channel reports itself unfetched. */
    timeoutSeconds: number;
  };
}

export const CONFIG_FILE = 'config.yaml';

/** Where a vault's settings live. */
export function settingsPath(root: string): string {
  return join(paths(root).config, CONFIG_FILE);
}

interface Raw {
  channels?: unknown;
  enrich?: unknown;
  jira?: { url?: unknown; email?: unknown; token?: unknown; jql?: unknown };
  git?: { author?: unknown };
  doc?: { url?: unknown };
  workspaces?: unknown;
  poll?: { enabled?: unknown; every?: unknown; hours?: unknown };
  classify?: {
    enabled?: unknown;
    provider?: unknown;
    url?: unknown;
    command?: unknown;
    model?: unknown;
    batch?: unknown;
    timeout?: unknown;
  };
  gmail?: { command?: unknown; account?: unknown; transport?: unknown };
  mcp?: {
    slack?: unknown;
    gmail?: unknown;
    command?: unknown;
    model?: unknown;
    pages?: unknown;
    timeout?: unknown;
  };
}

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

/**
 * A list, a `false`, or nothing.
 *
 * `channels: false` and `enrich: false` are how a vault says *none*, which a
 * list cannot say — an empty list reads like an unfinished edit, and treating it
 * as "all" would be the file quietly doing the opposite of what it looks like.
 */
const list = (v: unknown): string[] | null => {
  if (v === false) return [];
  if (v === true || v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const one = str(v);
  return one ? [one] : null;
};

function readFile(path: string): Raw {
  try {
    const parsed = parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Raw) : {};
  } catch {
    // A malformed file is not a reason to refuse to start. `pj setup --check`
    // is where a person is told about it, in the one place they are looking.
    return {};
  }
}

const cache = new Map<string, { key: string; value: Settings }>();

function stamp(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Every variable that can override the file, in one string.
 *
 * The memo cannot key on the file alone. A variable exported after the first
 * read would then never be seen — which is not a hypothetical: the tests in this
 * repository set and delete these between cases, and a memo that ignored them
 * would hand the second case the first one's answer.
 */
const OVERRIDES = [
  'PROJECTOR_JIRA_URL',
  'PROJECTOR_JIRA_EMAIL',
  'PROJECTOR_JIRA_TOKEN',
  'PROJECTOR_INTAKE_JQL',
  'PROJECTOR_GIT_AUTHOR',
  'PROJECTOR_WORKSPACES',
  'PROJECTOR_DOC_URL',
] as const;

const envKey = () => OVERRIDES.map((k) => process.env[k] ?? '').join('\u0000');

/** The settings for one vault: its file, with any exported variable winning. */
export function settingsFor(root: string): Settings {
  const path = settingsPath(root);
  const at = stamp(path);
  const key = `${at}\u0000${envKey()}`;
  const hit = cache.get(root);
  if (hit && hit.key === key) return hit.value;

  const raw = at === -1 ? {} : readFile(path);
  const env = process.env;

  const url = str(env.PROJECTOR_JIRA_URL) ?? str(raw.jira?.url);
  const email = str(env.PROJECTOR_JIRA_EMAIL) ?? str(raw.jira?.email);
  const token = str(env.PROJECTOR_JIRA_TOKEN) ?? str(raw.jira?.token);

  /**
   * Before providers were named, either `command` or `model` meant Claude.
   * Preserve that spelling for existing vaults; an untouched vault gets the new
   * local default, and an edited one switches deliberately with `provider`.
   */
  const namedProvider = str(raw.classify?.provider);
  const legacyClaude = !namedProvider && (str(raw.classify?.command) || str(raw.classify?.model));
  const provider: 'ollama' | 'claude' =
    namedProvider === 'claude' || legacyClaude ? 'claude' : 'ollama';

  const value: Settings = {
    channels: list(raw.channels),
    enrich: list(raw.enrich),
    jira: url && email && token ? { url: url.replace(/\/+$/, ''), email, token } : null,
    jql: str(env.PROJECTOR_INTAKE_JQL) ?? str(raw.jira?.jql),
    gitAuthor: str(env.PROJECTOR_GIT_AUTHOR) ?? str(raw.git?.author),
    workspaces: (() => {
      const w = str(env.PROJECTOR_WORKSPACES) ?? str(raw.workspaces);
      return w ? resolvePath(w, root) : null;
    })(),
    docUrl: str(env.PROJECTOR_DOC_URL) ?? str(raw.doc?.url),
    poll: {
      enabled: raw.poll?.enabled === true,
      // Floored so a typo cannot turn the loop into a spin. The default is
      // fifteen minutes: a sweep reads `git log` and a Jira search, and the
      // things it looks for do not happen faster than that.
      everySeconds: Math.max(60, Number(raw.poll?.every ?? 900) || 900),
      hours: (() => {
        const h = raw.poll?.hours;
        if (!Array.isArray(h) || h.length !== 2) return null;
        const [from, until] = h.map((x) => Number(x));
        const ok = (n: number | undefined) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 24;
        return ok(from) && ok(until) && from !== until ? { from: from!, until: until! } : null;
      })(),
    },
    classify: {
      enabled: raw.classify?.enabled !== false,
      provider,
      url: (str(raw.classify?.url) ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      command: str(raw.classify?.command) ?? 'claude',
      // 9B Q4 leaves useful headroom on a 16 GB Apple Silicon machine while
      // being large enough to follow the classifier's structured contract.
      model: str(raw.classify?.model) ?? (provider === 'ollama' ? 'qwen3.5:9b-q4_K_M' : 'haiku'),
      // Eight verdicts at ~70 tokens each, behind a 6k-token prompt, is about
      // 160 s for a 9B model generating at 6 tok/s — inside the timeout with
      // room. Floored at one and capped so a typo cannot ask for a thousand.
      batch: Math.max(1, Math.min(100, Number(raw.classify?.batch ?? 8) || 8)),
      timeoutSeconds: Math.max(30, Number(raw.classify?.timeout ?? 300) || 300),
    },
    gmail: {
      command: str(raw.gmail?.command) ?? 'gog',
      account: str(raw.gmail?.account),
      transport: (() => {
        const named = str(raw.gmail?.transport);
        if (named === 'mcp' || named === 'gog') return named;
        return (list(raw.mcp?.gmail) ?? []).length ? 'mcp' : 'gog';
      })(),
    },
    mcp: {
      slack: list(raw.mcp?.slack) ?? [],
      gmail: list(raw.mcp?.gmail) ?? [],
      command: str(raw.mcp?.command) ?? 'claude',
      model: str(raw.mcp?.model) ?? 'haiku',
      // Five pages of twenty is a hundred messages per search per tick. Past
      // that the run reports itself truncated and the next tick resumes.
      pages: Math.max(1, Math.min(20, Number(raw.mcp?.pages ?? 5) || 5)),
      // Four days of one busy person's DMs took the relay four minutes; ten is
      // the ceiling before the channel gives up and says so.
      timeoutSeconds: Math.max(60, Number(raw.mcp?.timeout ?? 600) || 600),
    },
  };

  cache.set(root, { key, value });
  return value;
}

/** Whether this vault sweeps a channel. Unconfigured vaults sweep everything. */
export function channelEnabled(root: string, name: string): boolean {
  const { channels } = settingsFor(root);
  return channels === null || channels.includes(name);
}

/** Whether this vault enriches a link kind. Unconfigured vaults enrich all. */
export function enrichEnabled(root: string, kind: string): boolean {
  const { enrich } = settingsFor(root);
  if (enrich === null) return true;
  // `gh` in the file covers `gh:pr`, `gh:branch` and `gh:commit` — three refs of
  // one credential, and nobody wants to enable them one at a time. `claude`
  // covers `workspace` on the same grounds one step further out: a workspace
  // resolves by reading `~/.claude` and nothing else, so a vault that has said it
  // does not want its sessions read has said it about both.
  const named = kind === 'workspace' ? 'claude' : kind;
  return enrich.includes(named) || enrich.includes(named.split(':')[0]!);
}

/** Forget the memo. Only tests need this; the mtime handles the real case. */
export function forgetSettings(): void {
  cache.clear();
}

/** The file `pj setup` writes, with everything commented out but the choices. */
export function settingsTemplate(channels: string[], enrich: boolean): string {
  return `# projector — what this vault reaches for.
#
# Written by \`pj setup\`. Gitignored, because it holds credentials and a vault is
# often a git repository. Any PROJECTOR_* variable you export overrides the value
# here for that run.

# Channels \`pj intake\` sweeps. Remove one to stop being asked about it;
# \`channels: false\` sweeps none.
channels: [${channels.join(', ')}]

# Sweep on a timer, in the server, and write what deserves a note.
# poll:
#   enabled: true
#   every: 7200               # seconds between ticks
#   hours: [8, 20]            # local hours a tick may run in, from inclusive to until exclusive

# Link kinds to resolve for display. \`false\` turns enrichment off entirely and
# every link renders as its raw ref.
enrich: ${enrich ? 'true' : 'false'}

# jira:
#   url: https://your-org.atlassian.net
#   email: you@example.com
#   token: <an Atlassian API token, not your password>
#   jql: <optional — overrides the default intake query>

# git:
#   author: you@example.com   # defaults to this repository's git config

# doc:
#   url: 'cursor://file{path}'   # how a doc: ref opens; defaults to the OS

# workspaces: ~/Code/wt   # where \`pj work\` puts worktrees
#
# The unattended classifier is local by default. Ollama must be running and the
# model downloaded; set provider: claude to keep the older Claude CLI transport.
# classify:
#   provider: ollama
#   url: http://127.0.0.1:11434
#   model: qwen3.5:9b-q4_K_M
#   batch: 8                   # candidates per call; a slow local model wants fewer
#   timeout: 300               # seconds one call may take before the tick holds
#
# Slack and Gmail are fetched by a relay agent over the MCP tools named here — a
# headless \`claude -p\` that may call only these and copies what they return.
# mcp:
#   slack: [mcp__yourserver__slack_search_public_and_private]
#   gmail: [mcp__yourserver__search_threads]
#   model: haiku
#   pages: 5                   # pages per search per tick
#   timeout: 600               # seconds one relay run may take
#
# Gmail may be read through gogcli instead, under its runtime read-only guards.
# gmail:
#   transport: gog             # default: mcp when mcp.gmail names tools, gog otherwise
#   command: gog
#   account: you@example.com   # optional when gog has one/default account
#
# Where Claude itself lives is a fact about the machine, not about this vault, so
# it stays an environment variable: PROJECTOR_CLAUDE_HOME, PROJECTOR_CLAUDE_DESKTOP.
`;
}

export { existsSync };
