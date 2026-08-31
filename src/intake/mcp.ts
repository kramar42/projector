import { evidenceFor } from './match.ts';
import { run } from '../sources/run.ts';
import { settingsFor } from '../settings.ts';
import type { Candidate, Channel, ChannelReport, IntakeContext } from './types.ts';

/**
 * Slack, plus the legacy Gmail fallback: fetched by an agent through MCP.
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
const SCHEMA = `[{"id":"<stable id>","url":"<permalink>","when":"<ISO 8601>","title":"<one line, the sender's words>","detail":"<one line of context: who, where>"}]`;

/** Exported for the test that pins the secrets rule; nothing else calls it. */
export function instructions(kind: 'slack' | 'gmail', cursor: string | null, days: number): string {
  const window = cursor ? `since ${cursor}` : `from the last ${days} days`;
  const what =
    kind === 'slack'
      ? 'messages addressed to the user, mentions, and threads they are part of'
      : 'threads where a person is asking the user something, or waiting on them';
  // Two fields because they answer two questions, which `linkFor` sets out.
  const permalink =
    kind === 'slack'
      ? 'the message permalink, the https://…slack.com/archives/… form'
      : 'the thread URL, the https://mail.google.com/… form';
  return [
    `Search ${kind} for ${what}, ${window}.`,
    '',
    'READ ONLY. Do not post, reply, send, draft, archive, label, or modify anything.',
    'You are gathering, not answering, and not deciding what matters — something',
    'else does that. Return everything you find that a person might want to act on.',
    '',
    '`id` is a stable identifier, used only to recognise this item again — a',
    `channel and timestamp is a fine one. \`url\` is ${permalink}, and it is what a`,
    'person opens, so it must be a real URL and never the id in another costume.',
    'Omit `url` when you genuinely cannot get one; never invent or assemble one.',
    '',
    'Never reproduce a secret. When a message contains a token, an API key or a',
    'password, say that it does — "contains an API token" — and leave the value out',
    'of both title and detail. A scratchpad message is exactly where one turns up.',
    '',
    `Reply with ONLY a JSON array, no prose and no code fences:\n${SCHEMA}`,
    '',
    'An empty array is a valid and common answer. Never invent an item.',
  ].join('\n');
}

interface Item {
  id?: unknown;
  url?: unknown;
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

/**
 * The link a captured message carries, which is not its fingerprint.
 *
 * These two channels used to write `links: [fingerprint]`, and `git` is the one
 * that never did — it builds a `gh:branch:` ref and lets the fingerprint be a
 * fingerprint. The difference showed: a fingerprint is a dedup key, so the id a
 * Slack tool volunteers is a channel and a timestamp, and `fallbackHref` answers
 * `null` for it because there is nowhere to go. The panel then drew the row it
 * draws for any unclickable link — the opaque id as dead text under a `slack`
 * chip. Nothing was wrong with the widget; it was rendering a link that was
 * never one.
 *
 * A url that is not a url buys nothing, so it is dropped rather than written: a
 * note with no link and a `source` facet is honest, and `source_fingerprint`
 * still dedups it.
 *
 * `slack` is a declared kind and keeps its prefix. `gmail` is not one and must
 * not become one — a kind earns its place by being resolvable (see
 * `src/schema/links.ts`), nothing fetches a Gmail thread, and import provenance
 * is the `source` facet's job. So a thread travels as the plain URL it is, which
 * `parseLink` reads as `url` and the panel opens.
 */
export function linkFor(kind: 'slack' | 'gmail', url: string): string[] {
  if (!/^https?:\/\//.test(url)) return [];
  return [kind === 'slack' ? `slack:${url}` : url];
}

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
        cfg.mcp.command,
        [
          '-p',
          instructions(kind, ctx.cursor, defaultDays),
          '--model',
          cfg.mcp.model,
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
        const links = linkFor(kind, str(item.url, 500));
        // The same convergence every other channel has: something the vault
        // already answers for is not new, whatever the agent thinks. Two ways in
        // now that the two are different strings — the fingerprint of a card this
        // sweep wrote before, and the permalink of one somebody linked by hand,
        // which used to be the same check by accident and is now the point of it.
        if (ctx.fingerprints.has(fingerprint) || links.some((l) => ctx.links.has(l))) continue;
        const when = str(item.when, 40);
        if (when && (!newest || when > newest)) newest = when;
        const title = str(item.title, 300) || id;
        const detail = str(item.detail, 400);
        candidates.push({
          channel: kind,
          fingerprint,
          title,
          links,
          ...(when ? { when } : {}),
          ...(detail ? { detail } : {}),
          /**
           * The same evidence every other channel attaches, and it is not a
           * nicety: `classify` may only name a merge target that appears in
           * `matches`, so a candidate with no evidence can never be judged
           * `extend` — the verdict is demoted to a new note. Without this a Slack
           * message that says a ticket has moved could only ever become a second
           * card beside the one it was about.
           *
           * No `cwd` or `branch` to offer — a message has neither — so the match
           * is on the text: a Jira key it mentions, or vocabulary it shares with
           * a note.
           */
          evidence: evidenceFor(ctx, {
            fingerprint,
            links,
            text: [title, detail].filter(Boolean).join(' — '),
          }),
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
    'or fetch by hand and: pj intake cursor set --channel slack --cursor <ts>',
);

/** Compatibility path for vaults that still name Claude MCP tools. */
export const gmailMcpChannel = agentChannel(
  'gmail',
  14,
  'no Gmail tools named for this vault — set mcp.gmail in .projector/config.yaml, ' +
    'or fetch by hand and: pj intake cursor set --channel gmail --cursor <iso>',
);
