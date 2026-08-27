import { run } from '../sources/run.ts';
import { settingsFor } from '../settings.ts';
import type { Candidate, Channel, ChannelReport, IntakeContext } from './types.ts';

/**
 * Slack and Gmail: fetched by an agent, because `pj` has no credential for either.
 *
 * A second token in a second place to rotate buys nothing when an agent already
 * has both through MCP. What `pj` keeps is the *watermark* — where the last sweep
 * got to is not a property of who did the fetching — so these look like every
 * other channel from the store's side and differ only in how `collect` works.
 *
 * **The C2 hazard is real and is why this is opt-in per tool.** These are exactly
 * the shared channels the principle names: an agent holding Slack tools could
 * post, and one holding Gmail tools could send. Nothing here can prove a tool is
 * read-only from its name, so nothing tries — the vault names the tools the
 * channel may call and Claude Code refuses everything else. Unconfigured means no
 * tools, which means the channel reports itself unfetched exactly as it always
 * did. So the failure of omission is the old behaviour, and enabling a write is
 * something a person has to spell out.
 *
 * The fetch and the judgement stay separate. This returns candidates in the same
 * shape `git` and `claude` return, and `classify` then judges every channel by
 * one policy — rather than each channel arriving with its own opinion.
 */

/** What the agent is told to produce. Deliberately the smallest useful shape. */
const SCHEMA = `[{"id":"<stable id>","when":"<ISO 8601>","title":"<one line, the sender's words>","detail":"<one line of context: who, where>"}]`;

function instructions(kind: 'slack' | 'gmail', cursor: string | null, days: number): string {
  const window = cursor ? `since ${cursor}` : `from the last ${days} days`;
  const what =
    kind === 'slack'
      ? 'messages addressed to the user, mentions, and threads they are part of'
      : 'threads where a person is asking the user something, or waiting on them';
  return [
    `Search ${kind} for ${what}, ${window}.`,
    '',
    'READ ONLY. Do not post, reply, send, draft, archive, label, or modify anything.',
    'You are gathering, not answering, and not deciding what matters — something',
    'else does that. Return everything you find that a person might want to act on.',
    '',
    `Reply with ONLY a JSON array, no prose and no code fences:\n${SCHEMA}`,
    '',
    'An empty array is a valid and common answer. Never invent an item.',
  ].join('\n');
}

interface Item {
  id?: unknown;
  when?: unknown;
  title?: unknown;
  detail?: unknown;
}

/** The first balanced array in the reply, for the reason `classify` gives. */
function parseItems(text: string): Item[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is Item => Boolean(x) && typeof x === 'object');
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v.trim() : '').slice(0, max);

function agentChannel(kind: 'slack' | 'gmail', defaultDays: number, manualHint: string): Channel {
  return {
    name: kind,
    defaultDays,
    async collect(ctx: IntakeContext): Promise<ChannelReport> {
      const cfg = settingsFor(ctx.root);
      const tools = cfg.mcp[kind];
      const held: ChannelReport = {
        channel: kind,
        cursor: ctx.cursor,
        // A run that fetched nothing has no boundary to move to.
        nextCursor: null,
        fetched: false,
        candidates: [],
        skipped: [],
      };

      if (!tools.length) {
        return { ...held, reason: manualHint };
      }

      const res = await run(
        cfg.classify.command,
        [
          '-p',
          instructions(kind, ctx.cursor, defaultDays),
          '--model',
          cfg.classify.model,
          // The whole safety story in one flag: only the tools the vault named,
          // and Claude Code refuses the rest. No wildcard, because a wildcard over
          // an MCP server's tools is a wildcard over its write tools too.
          '--allowedTools',
          tools.join(' '),
          '--output-format',
          'json',
        ],
        { timeoutMs: 300_000 },
      );
      if (!res.ok) {
        return { ...held, reason: `the ${kind} agent could not be run: ${res.stderr.slice(0, 200)}` };
      }

      let reply: string;
      try {
        const env = JSON.parse(res.stdout) as { result?: unknown; is_error?: boolean };
        if (env.is_error || typeof env.result !== 'string') {
          return { ...held, reason: `the ${kind} agent reported an error` };
        }
        reply = env.result;
      } catch {
        return { ...held, reason: `the ${kind} agent did not answer in JSON` };
      }

      const items = parseItems(reply);
      if (!items) return { ...held, reason: `the ${kind} agent's answer could not be read` };

      const candidates: Candidate[] = [];
      let newest = ctx.cursor;
      for (const item of items) {
        const id = str(item.id, 200);
        if (!id) continue;
        const fingerprint = `${kind}:${id}`;
        // The same convergence every other channel has: a fingerprint the vault
        // already answers for is not new, whatever the agent thinks.
        if (ctx.fingerprints.has(fingerprint) || ctx.links.has(fingerprint)) continue;
        const when = str(item.when, 40);
        if (when && (!newest || when > newest)) newest = when;
        candidates.push({
          channel: kind,
          fingerprint,
          title: str(item.title, 300) || id,
          links: [fingerprint],
          ...(when ? { when } : {}),
          ...(str(item.detail, 400) ? { detail: str(item.detail, 400) } : {}),
        });
      }

      return {
        channel: kind,
        cursor: ctx.cursor,
        // Only when the run actually completed. An agent that answered is a
        // channel that was read, and the boundary is the newest thing it saw.
        nextCursor: newest === ctx.cursor ? null : newest,
        fetched: true,
        candidates,
        skipped: [],
      };
    },
  };
}

export const slackChannel = agentChannel(
  'slack',
  7,
  'no Slack tools named for this vault — set mcp.slack in .projector/config.yaml, ' +
    'or fetch by hand and: pj intake commit --channel slack --cursor <ts>',
);

export const gmailChannel = agentChannel(
  'gmail',
  14,
  'no Gmail tools named for this vault — set mcp.gmail in .projector/config.yaml, ' +
    'or fetch by hand and: pj intake commit --channel gmail --cursor <iso>',
);
