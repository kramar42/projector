import { evidenceFor } from './match.ts';
import { run, ago } from '../sources/run.ts';
import { settingsFor } from '../settings.ts';
import {
  conversationsFrom,
  costFromEnvelope,
  knownFor,
  parseGmailRelay,
  parseSlackRelay,
  relayInstructions,
  searchToolIn,
  slackBoundary,
  trackedBy,
  transcribedAll,
  transcript,
  type Conversation,
  type RelayKind,
} from './relay.ts';
import type { Candidate, Channel, ChannelReport, IntakeContext, Match } from './types.ts';

/**
 * Slack and Gmail: fetched by an agent through MCP, as a relay.
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
 * **The agent copies; this file computes; the classifier judges.** What the
 * agent is asked for, and what is made of it, is `relay.ts`. What is left here is
 * the channel: the unit is a conversation rather than a message, a conversation
 * the vault already tracks arrives as an update, and the exchange itself — with
 * the owner's lines marked — is what the classifier is shown. That is the whole
 * difference between "Vivek asks about AWS contracts" as a card and knowing the
 * owner answered eleven minutes later.
 */

/** The link a captured conversation carries, which is not its fingerprint. */
export function linkFor(kind: RelayKind, url: string): string[] {
  if (!/^https?:\/\//.test(url)) return [];
  return [kind === 'slack' ? `slack:${url}` : url];
}

function held(kind: RelayKind, ctx: IntakeContext, reason: string, cost?: ChannelReport['cost']): ChannelReport {
  return {
    channel: kind,
    cursor: ctx.cursor,
    // A run that fetched nothing has no boundary to move to.
    nextCursor: null,
    fetched: false,
    reason,
    candidates: [],
    skipped: [],
    ...(cost ? { cost } : {}),
  };
}

/**
 * The candidates one conversation produces: one, or none.
 *
 * Nothing new from anyone else since the cursor means nothing to react to, so it
 * is skipped with that reason — the owner's own messages are not news to them,
 * and a thread the day-granular Gmail search returned from before the cursor has
 * already been answered for.
 * Otherwise it is an **update** when an open note already tracks the
 * conversation, and a discovery when none does. The two differ in fingerprint —
 * an update is keyed by the newest message, so each new exchange is its own
 * offer and its own decline — and in evidence: an update names the notes it may
 * extend, first among its matches, and `classify` will let it do nothing else.
 */
export function candidateFor(
  kind: RelayKind,
  ctx: IntakeContext,
  conv: Conversation,
  tracked: string[],
): Candidate | null {
  // An ask with no words — an app posting an attachment-only card, a Jira bot's
  // empty DM — gives a reader nothing to read and a classifier nothing to judge.
  if (!conv.asks.some((m) => m.text.trim())) return null;
  const ask = conv.asks.find((m) => m.text.trim()) ?? conv.asks[0]!;
  const newest = conv.asks.at(-1)!;
  const anchor = tracked.length ? newest : ask;
  const fingerprint =
    kind === 'slack'
      ? `slack:${conv.channel}/${anchor.id}`
      : tracked.length
        ? `gmail:${conv.channel}@${anchor.id}`
        : `gmail:${conv.channel}`;
  const links = linkFor(kind, anchor.url ?? '');
  const text = [conv.name, ...conv.asks.map((m) => m.text)].join(' ');
  const mechanical = evidenceFor(ctx, { fingerprint, links, text });

  const others = [...new Set(conv.asks.map((m) => m.from))];
  const who = others.length > 2 ? `${others.slice(0, 2).join(', ')} and others` : others.join(' and ');
  // Slack labels a DM with the other person's name, which the sentence already
  // says; a channel or a thread is worth naming.
  const where =
    kind === 'gmail'
      ? `email “${conv.name.slice(0, 60)}”`
      : others.includes(conv.name) || /^[DG]/.test(conv.channel) && others.length === 1
        ? 'a DM'
        : conv.name;
  const lastBy = conv.last.mine ? 'you' : conv.last.from;
  const detail =
    `${who} in ${where} — ${conv.asks.length} new message(s), last word ${lastBy} ${ago(conv.last.at)}` +
    (tracked.length ? `; already on ${tracked.join(', ')}` : '');

  const trackedMatches: Match[] = tracked.map((id) => ({
    id,
    title: ctx.notes.get(id)?.title ?? id,
    why: 'tracked',
  }));
  const matches = [...trackedMatches];
  for (const m of mechanical.matches ?? []) if (!matches.some((x) => x.id === m.id)) matches.push(m);

  return {
    channel: kind,
    fingerprint,
    title: (ask.text || conv.name).replace(/\s+/g, ' ').slice(0, 300),
    links,
    when: newest.at,
    detail,
    fields: [
      { k: 'conversation', v: transcript(conv) },
      { k: 'ball', v: conv.ball === 'mine' ? 'theirs was the last word, so it is with you' : 'you had the last word' },
      ...(conv.myLastAt ? [{ k: 'you last wrote', v: ago(conv.myLastAt) }] : []),
      ...(tracked.length ? [{ k: 'tracked_as', v: tracked.join(', ') }] : []),
    ],
    evidence: {
      ...(tracked.length ? { linkedTo: tracked } : mechanical.linkedTo ? { linkedTo: mechanical.linkedTo } : {}),
      ...(mechanical.capturedAs ? { capturedAs: mechanical.capturedAs } : {}),
      ...(matches.length ? { matches } : {}),
    },
  };
}

function relayChannel(kind: RelayKind, defaultDays: number, manualHint: string): Channel {
  return {
    name: kind,
    defaultDays,
    async collect(ctx: IntakeContext): Promise<ChannelReport> {
      const cfg = settingsFor(ctx.root);
      const tools = cfg.mcp[kind];
      if (!tools.length) return held(kind, ctx, manualHint);
      const searchTool = searchToolIn(kind, tools);
      if (!searchTool) {
        return held(
          kind,
          ctx,
          `mcp.${kind} names no search tool — the relay needs ` +
            (kind === 'slack' ? 'slack_search_public_and_private' : 'search_threads'),
        );
      }

      const started = Date.now();
      const res = await run(
        cfg.mcp.command,
        [
          '-p',
          relayInstructions(kind, { since: ctx.since, pages: cfg.mcp.pages, searchTool }),
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
        { timeoutMs: cfg.mcp.timeoutSeconds * 1000 },
      );
      const elapsed = Date.now() - started;
      if (!res.ok) {
        return held(kind, ctx, `the ${kind} relay could not be run: ${res.stderr.slice(0, 200)}`, { ms: elapsed });
      }

      let reply: string;
      let env: Record<string, unknown>;
      try {
        env = JSON.parse(res.stdout) as Record<string, unknown>;
        if (env.is_error || typeof env.result !== 'string') {
          return held(kind, ctx, `the ${kind} relay reported an error`, costFromEnvelope(env, elapsed));
        }
        reply = env.result;
      } catch {
        return held(kind, ctx, `the ${kind} relay did not answer in JSON`, { ms: elapsed });
      }
      const cost = costFromEnvelope(env, elapsed);

      const parsed = kind === 'slack' ? parseSlackRelay(reply) : parseGmailRelay(reply);
      if (!parsed) return held(kind, ctx, `the ${kind} relay's answer could not be read`, cost);

      const known = knownFor(kind, ctx);
      const candidates: Candidate[] = [];
      const skipped: ChannelReport['skipped'] = [];
      let newest = ctx.cursor;
      let truncated = parsed.more;

      for (const conv of conversationsFrom(kind, parsed.messages, ctx.cursor)) {
        if (!newest || conv.last.at > newest) newest = conv.last.at;
        const tracked = trackedBy(conv, known);
        const c = candidateFor(kind, ctx, conv, tracked);
        if (!c) {
          skipped.push({
            fingerprint: `${kind}:${conv.key}/${conv.last.id}`,
            title: conv.name,
            why: conv.asks.length ? 'nothing said in words since the cursor' : 'nothing new from anyone else since the cursor',
          });
          continue;
        }
        if (candidates.length >= ctx.limit) {
          truncated = true;
          break;
        }
        // The same convergence every other channel has: a conversation already
        // answered for is not new, whatever the relay returned.
        if (c.evidence?.capturedAs?.length) {
          skipped.push({ fingerprint: c.fingerprint, title: c.title, why: `already captured as ${c.evidence.capturedAs.join(', ')}` });
          continue;
        }
        candidates.push(c);
      }

      const notes: string[] = [];
      if (parsed.dropped) notes.push(`${parsed.dropped} relay record(s) failed validation and were dropped`);

      /**
       * A relay that ran out of pages did not examine the whole window, and what
       * that means for the cursor depends on the order the pages came in. Slack's
       * are oldest-first and contiguous, so the run moves the cursor to the last
       * point both searches reached and says so — the rest arrives next run, and
       * holding instead would make an agent that stops early an agent that never
       * gets past the same first pages (see `slackBoundary`). Gmail's pages are
       * newest-first, so a cut-short run holds, as every other truncated run does.
       */
      let nextCursor = newest === ctx.cursor ? null : newest;
      if (parsed.more && kind === 'slack') {
        const boundary = slackBoundary(parsed.messages);
        nextCursor = boundary && boundary !== ctx.cursor ? boundary : null;
        truncated = false;
        notes.push(`more pages behind ${boundary ?? 'the cursor'} — the next run resumes there`);
      }
      /**
       * A model transcribing pages can leave records out without failing any
       * validation, and a cursor moved past them loses them for good. The relay
       * copies each page's own result count; when the records do not add up to
       * it, the candidates it did produce are still offered, but the cursor
       * holds and the run says why. The next run pays the fetch again — the
       * price of not trusting a copy, and cheaper than the alternative.
       */
      const complete = transcribedAll(parsed);
      if (complete === false) {
        nextCursor = null;
        truncated = true;
        notes.push(
          `the relay reported ${parsed.reported} result(s) and transcribed ${parsed.transcribed} — cursor held`,
        );
      } else if (complete === null) {
        notes.push('the relay reported no page counts, so completeness could not be checked');
      }

      return {
        channel: kind,
        cursor: ctx.cursor,
        nextCursor,
        fetched: true,
        truncated,
        ...(notes.length ? { reason: notes.join('; ') } : {}),
        candidates,
        skipped,
        cost,
      };
    },
  };
}

export const slackChannel = relayChannel(
  'slack',
  7,
  'no Slack tools named for this vault — set mcp.slack in .projector/config.yaml, ' +
    'or fetch by hand and: pj intake cursor set --channel slack --cursor <iso>',
);

/** Gmail through the relay. `gmail.ts` chooses between this and gogcli. */
export const gmailMcpChannel = relayChannel(
  'gmail',
  14,
  'no Gmail tools named for this vault — set mcp.gmail in .projector/config.yaml, ' +
    'or fetch by hand and: pj intake cursor set --channel gmail --cursor <iso>',
);
