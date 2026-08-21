import type { Channel, ChannelReport } from './types.ts';

/**
 * Channels `pj` cannot reach, whose cursor it keeps anyway.
 *
 * Slack and Gmail have no credential here and are not getting one: an agent
 * already has both through MCP, and a second token in a second place to rotate
 * buys nothing. But the *watermark* is not a property of who fetched — it is
 * where the last sweep got to — so it belongs in one store regardless. The agent
 * reads the cursor from here, fetches through MCP, and commits the new one back.
 *
 * That seam is why intake is a store plus a set of channels rather than a
 * fetcher: two of the five channels have no fetcher at all, and the design has to
 * hold anyway.
 */

function manual(name: string, defaultDays: number, note: string): Channel {
  return {
    name,
    defaultDays,
    collect(ctx): ChannelReport {
      return {
        channel: name,
        cursor: ctx.cursor,
        // Never advanced by a run that fetched nothing. Only `pj intake commit`
        // moves this one, once the agent has actually looked.
        nextCursor: null,
        fetched: false,
        note,
        candidates: [],
        skipped: [],
      };
    },
  };
}

export const slackChannel = manual(
  'slack',
  7,
  'no Slack credential in pj — fetch through the Slack MCP since this cursor ' +
    '(a message ts), then: pj intake commit --channel slack --cursor <ts>',
);

export const gmailChannel = manual(
  'gmail',
  14,
  'no Gmail credential in pj — fetch through the Gmail MCP since this cursor ' +
    '(an ISO date), then: pj intake commit --channel gmail --cursor <iso>',
);
