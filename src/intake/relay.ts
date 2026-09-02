import { loadFacets } from '../schema/facets.ts';
import { parseLink } from '../schema/links.ts';
import { paths } from '../config.ts';
import { isClosed } from '../index/blocking.ts';
import type { Cost, IntakeContext } from './types.ts';

/**
 * The relay: an agent that copies what the tools return, and the code that turns
 * those copies into conversations.
 *
 * Slack and Gmail are reached through MCP servers an agent holds and `pj` does
 * not, so an agent has to sit in the fetch path. What it is asked to *be* is the
 * whole design. It used to be a summariser — "search for what needs attention,
 * one line per message" — and a summariser is a judge with no evidence: it saw one
 * message at a time and could not know that the question it was reporting had been
 * answered eleven minutes later in the same thread. Now it is a relay. It makes a
 * fixed set of tool calls with fixed arguments and copies every field back
 * verbatim into one JSON shape. It filters nothing, summarises nothing and decides
 * nothing; a model copying a tool result is close to deterministic where a model
 * characterising one is not.
 *
 * Everything that follows is then computed here, not asked of anyone (C8): which
 * messages form a conversation, whose turn it is, whether the vault already tracks
 * it, what its fingerprint is. The classifier sees the exchange with the owner's
 * lines marked and decides what it means — that part was always a judgement.
 *
 * **Two searches, no reads.** `to:me` is what was said to the owner; `from:me` is
 * what they said back. Merged by conversation that is enough to know who spoke
 * last, and it costs two paged searches rather than one read per conversation.
 * What it misses is stated rather than hidden: in a channel, a reply from a third
 * person that mentions nobody is in neither search, so `ball` there is about the
 * owner and the people who addressed them, not the whole room.
 */

export type RelayKind = 'slack' | 'gmail';

/** One message as the relay reported it, normalised to one shape for both sources. */
export interface RelayMessage {
  /** Conversation container: a Slack channel id, or a Gmail thread id. */
  channel: string;
  /** What the source calls it — a DM's label, a thread's subject. */
  channelName: string;
  /** Slack thread root ts, when the message is a reply in one. */
  thread?: string;
  /** A Slack ts or a Gmail message id. */
  id: string;
  /** ISO. */
  at: string;
  from: string;
  mine: boolean;
  text: string;
  url?: string;
}

export interface Conversation {
  kind: RelayKind;
  /** `<channel>` or `<channel>/<thread>`; a Gmail thread id. */
  key: string;
  channel: string;
  thread?: string;
  name: string;
  /** Oldest first. */
  messages: RelayMessage[];
  /** Messages from others after the cursor — what there is to react to. */
  asks: RelayMessage[];
  /** Whose move it is, mechanically: the last speaker was the owner or was not. */
  ball: 'mine' | 'theirs';
  last: RelayMessage;
  myLastAt?: string;
}

export interface RelayResult {
  messages: RelayMessage[];
  /** The relay left pages unfetched: the run is truncated and the cursor must hold. */
  more: boolean;
  /** Records the relay produced that failed validation. Counted, never silently dropped. */
  dropped: number;
  /**
   * How many results the tool said it returned, summed over the pages the relay
   * reported — copied from each page's own header, not counted by the model.
   * Null when the relay reported no pages. In the unit the pages count in:
   * messages for Slack, threads for Gmail.
   */
  reported: number | null;
  /** How many records of that unit the relay actually wrote down, valid or not. */
  transcribed: number;
}

/**
 * Whether the relay wrote down at least as much as it read. Null when it said
 * nothing about pages.
 *
 * One direction only. Fewer records than the pages held means something was
 * left out, and a cursor moved past it would lose it for good. More records
 * than the pages held means the relay under-reported its pages — it listed
 * eight of fifteen, say — which loses nothing; a rule that held on that too
 * held one real run on a Gmail fetch that had transcribed every thread.
 */
export function transcribedAll(r: RelayResult): boolean | null {
  if (r.reported === null) return null;
  return r.transcribed >= r.reported;
}

// ----------------------------------------------------------------- secrets

/**
 * Credential shapes that can be recognised without reading, redacted before any
 * text leaves this module.
 *
 * NEXT.md carried this for a while as "the secrets rule is asked of a model, not
 * applied by code". A relay makes it urgent: it copies verbatim, which is the
 * point, so a token pasted into a DM arrives here intact. Known shapes only — an
 * entropy heuristic would eat commit hashes, and a Slack ts looks like a number.
 */
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, 'github token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github token'],
  [/\bxox[abposer]-[A-Za-z0-9-]{10,}\b/g, 'slack token'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'api key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'google api key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, 'jwt'],
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, what] of SECRETS) out = out.replace(re, `[redacted ${what}]`);
  return out;
}

// -------------------------------------------------------------------- cost

/**
 * What a `claude -p --output-format json` run cost, read off its envelope.
 *
 * Every field is optional on the way in because the envelope has grown fields
 * over releases and a missing one must not turn a fetched channel into a held
 * one. `ms` falls back to the caller's own clock.
 */
export function costFromEnvelope(env: Record<string, unknown>, elapsedMs: number): Cost {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const usage = (env.usage ?? {}) as Record<string, unknown>;
  const input =
    (num(usage.input_tokens) ?? 0) +
    (num(usage.cache_creation_input_tokens) ?? 0) +
    (num(usage.cache_read_input_tokens) ?? 0);
  const output = num(usage.output_tokens);
  const cost: Cost = { ms: num(env.duration_ms) ?? elapsedMs };
  if (input) cost.inputTokens = input;
  if (output !== undefined) cost.outputTokens = output;
  const usd = num(env.total_cost_usd);
  if (usd !== undefined) cost.costUsd = usd;
  const turns = num(env.num_turns);
  if (turns !== undefined) cost.turns = turns;
  return cost;
}

export function renderCost(c: Cost | undefined): string {
  if (!c) return '';
  const parts = [`${(c.ms / 1000).toFixed(1)}s`];
  if (c.inputTokens !== undefined || c.outputTokens !== undefined) {
    parts.push(`${k(c.inputTokens ?? 0)} in / ${k(c.outputTokens ?? 0)} out tok`);
  }
  if (c.turns !== undefined) parts.push(`${c.turns} turns`);
  if (c.costUsd !== undefined) parts.push(`$${c.costUsd.toFixed(3)}`);
  return parts.join(' · ');
}

function k(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function addCost(a: Cost | undefined, b: Cost | undefined): Cost | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const out: Cost = { ms: a.ms + b.ms };
  const i = sum(a.inputTokens, b.inputTokens);
  const o = sum(a.outputTokens, b.outputTokens);
  const u = sum(a.costUsd, b.costUsd);
  const t = sum(a.turns, b.turns);
  if (i !== undefined) out.inputTokens = i;
  if (o !== undefined) out.outputTokens = o;
  if (u !== undefined) out.costUsd = u;
  if (t !== undefined) out.turns = t;
  return out;
}

// ------------------------------------------------------------ instructions

/** The one tool a relay needs per source, found in the vault's allowlist by suffix. */
export function searchToolIn(kind: RelayKind, tools: string[]): string | null {
  const suffixes =
    kind === 'slack'
      ? ['slack_search_public_and_private', 'slack_search_public']
      : ['search_threads'];
  for (const s of suffixes) {
    const hit = tools.find((t) => t.endsWith(s));
    if (hit) return hit;
  }
  return null;
}

/**
 * The day Gmail's `after:` is given, for a cursor.
 *
 * `after:` is a calendar day in the account's own timezone, which the relay
 * cannot know, so the search is asked for the UTC day *before* the cursor and
 * the parser applies the cursor to the minute. A day of overlap re-fetches a few
 * threads the vault already answers for; a day of gap would lose mail.
 */
const gmailAfter = (since: Date): string => {
  const d = new Date(since.getTime() - 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return [d.getUTCFullYear(), p(d.getUTCMonth() + 1), p(d.getUTCDate())].join('/');
};

/**
 * What the relay is told. Exported so the wording is pinned by a test: the
 * read-only line, the verbatim rule and the schema are load-bearing.
 */
export function relayInstructions(
  kind: RelayKind,
  opts: { since: Date; pages: number; searchTool: string },
): string {
  const head = [
    'You are a relay between a tool and a parser. Copy what the tool returns into the JSON',
    'shape below. Do not filter, summarise, judge, reword, translate or drop anything, and do',
    'not add anything the tool did not return.',
    '',
    'READ ONLY. Never post, reply, send, draft, schedule, react, label, archive or modify',
    'anything. Call only the tool named below.',
    '',
  ];
  if (kind === 'slack') {
    const epoch = String(Math.floor(opts.since.getTime() / 1000));
    return [
      ...head,
      `1. Call ${opts.searchTool} with query "to:me", after "${epoch}", sort "timestamp",`,
      `   sort_dir "asc", limit 20, include_context false, response_format "detailed". While the`,
      `   reply offers a next-page cursor, call it again with that cursor, every page, up to ${opts.pages} pages.`,
      '   Do not stop early; a page left unfetched is work the owner never sees.',
      '2. Do the same with query "from:me".',
      '3. Turn every message in every reply into one record, copying each field exactly as shown:',
      '   {"channel_id": the channel ID, "channel": the channel or DM label as shown,',
      '    "ts": the Message_ts, "thread_ts": the thread parent ts when the result shows one, else null,',
      '    "user_id": the sender ID, "user": the sender name, "mine": true for step 2 results and',
      '    false for step 1, "text": the message text verbatim up to 600 characters,',
      '    "permalink": the permalink URL exactly as given}',
      '4. Reply with ONLY this JSON, no prose and no code fences:',
      '   {"pages": [one per page you fetched: {"query": "to:me" or "from:me", "results": the number in',
      '    that page\'s "(N results)" header}],',
      '    "messages": [records], "more": true if any search still had pages you did not fetch, else false}',
      '',
      'Every result in every page becomes exactly one record — the parser checks the count. An empty',
      '"messages" array is a valid and common answer. Never invent a record.',
    ].join('\n');
  }
  const after = gmailAfter(opts.since);
  return [
    ...head,
    `1. Call ${opts.searchTool} with query "in:inbox after:${after} -in:draft", pageSize 50. While the`,
    `   reply carries a nextPageToken, call it again with that pageToken, up to ${opts.pages} pages.`,
    `2. Do the same with query "in:sent after:${after}".`,
    '3. Turn every thread in every reply into one record, copying each field exactly as shown:',
    '   {"id": the thread id, "subject": the subject, "messages": [one per message:',
    '    {"id": the message id, "date": the date, "from": the sender, "to": the toRecipients,',
    '     "labels": the labelIds, "mine": true for step 2 results and false for step 1,',
    '     "snippet": the snippet verbatim up to 600 characters}]}',
    '4. Reply with ONLY this JSON, no prose and no code fences:',
    '   {"pages": [one per page you fetched: {"query": "in:inbox" or "in:sent", "results": how many threads',
    '    that page listed}],',
    '    "threads": [records], "more": true if any search still had pages you did not fetch, else false}',
    '',
    'Every thread in every page becomes exactly one record — the parser checks the count. An empty',
    '"threads" array is a valid and common answer. Never invent a record.',
  ].join('\n');
}

// ----------------------------------------------------------------- parsing

const str = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v.trim() : '').slice(0, max);

/** The first balanced object in a reply — models fence JSON however the mood takes them. */
function firstObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The per-page counts the relay copied, summed; null when it reported none. */
function reportedIn(env: Record<string, unknown>): number | null {
  if (!Array.isArray(env.pages)) return null;
  let total = 0;
  let any = false;
  for (const p of env.pages as unknown[]) {
    const n = p && typeof p === 'object' ? (p as { results?: unknown }).results : undefined;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
}

const SLACK_TS = /^\d{9,11}\.\d{6}$/;
const SLACK_CHANNEL = /^[CDGW][A-Z0-9]{5,}$/;
const SLACK_PERMALINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{16})/;

export const slackTsToIso = (ts: string): string => new Date(Number(ts) * 1000).toISOString();

/** `…/archives/C123/p1700000000000100` → `{channel: 'C123', ts: '1700000000.000100'}`. */
export function slackPermalinkParts(url: string): { channel: string; ts: string } | null {
  const m = SLACK_PERMALINK.exec(url.trim());
  if (!m) return null;
  return { channel: m[1]!, ts: `${m[2]!.slice(0, 10)}.${m[2]!.slice(10)}` };
}

export function parseSlackRelay(text: string): RelayResult | null {
  const env = firstObject(text);
  if (!env || !Array.isArray(env.messages)) return null;
  const out: RelayMessage[] = [];
  let dropped = 0;
  for (const raw of env.messages as unknown[]) {
    if (!raw || typeof raw !== 'object') {
      dropped++;
      continue;
    }
    const r = raw as Record<string, unknown>;
    const channel = str(r.channel_id, 40);
    const ts = str(r.ts, 40);
    if (!SLACK_CHANNEL.test(channel) || !SLACK_TS.test(ts)) {
      dropped++;
      continue;
    }
    const thread = str(r.thread_ts, 40);
    const url = str(r.permalink, 500);
    out.push({
      channel,
      channelName: scrubSecrets(str(r.channel, 120)) || channel,
      ...(SLACK_TS.test(thread) && thread !== ts ? { thread } : {}),
      id: ts,
      at: slackTsToIso(ts),
      from: scrubSecrets(str(r.user, 120)) || str(r.user_id, 40) || 'someone',
      mine: r.mine === true,
      text: scrubSecrets(str(r.text, 600)),
      ...(SLACK_PERMALINK.test(url) ? { url } : {}),
    });
  }
  return { messages: out, more: env.more === true, dropped, reported: reportedIn(env), transcribed: out.length + dropped };
}

const GMAIL_ID = /^[A-Za-z0-9_-]{8,}$/;

/** The thread URL Gmail's web client opens, assembled from the id the API gave. */
export const gmailThreadUrl = (id: string): string => `https://mail.google.com/mail/u/0/#all/${id}`;

/** A Gmail thread id off any of the URL shapes a note may carry. */
export function gmailThreadIdOf(url: string): string | null {
  const m = /mail\.google\.com\/mail\/u\/\d+\/#[a-z]+\/([A-Za-z0-9_-]{8,})/.exec(url);
  return m ? m[1]! : null;
}

export function parseGmailRelay(text: string): RelayResult | null {
  const env = firstObject(text);
  if (!env || !Array.isArray(env.threads)) return null;
  const out: RelayMessage[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let threads = 0;
  for (const raw of env.threads as unknown[]) {
    if (!raw || typeof raw !== 'object') {
      dropped++;
      continue;
    }
    const t = raw as Record<string, unknown>;
    const thread = str(t.id, 80);
    if (!GMAIL_ID.test(thread)) {
      dropped++;
      continue;
    }
    threads++;
    const subject = scrubSecrets(str(t.subject, 300)) || '(no subject)';
    const messages = Array.isArray(t.messages) ? (t.messages as unknown[]) : [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') {
        dropped++;
        continue;
      }
      const r = m as Record<string, unknown>;
      const id = str(r.id, 80);
      const when = Date.parse(str(r.date, 80));
      if (!GMAIL_ID.test(id) || !Number.isFinite(when)) {
        dropped++;
        continue;
      }
      // The two searches overlap on any thread the owner both received and
      // answered, so the same message can arrive twice. The id says so.
      const dedup = `${thread}/${id}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      const labels = Array.isArray(r.labels) ? r.labels.map((l) => String(l).toUpperCase()) : [];
      out.push({
        channel: thread,
        channelName: subject,
        id,
        at: new Date(when).toISOString(),
        from: scrubSecrets(str(r.from, 200)) || 'someone',
        mine: r.mine === true || labels.includes('SENT'),
        text: scrubSecrets(str(r.snippet, 600)),
        url: gmailThreadUrl(thread),
      });
    }
  }
  // Gmail's unit of completeness is the thread, not the message: a page header
  // counts threads, and the relay writes one thread record per thread per page,
  // so a thread both searches listed is two records and two in the count alike.
  return { messages: out, more: env.more === true, dropped, reported: reportedIn(env), transcribed: threads + dropped };
}

/**
 * Where a Slack run that ran out of pages may safely move the cursor.
 *
 * Slack is searched oldest-first from the cursor, so each search's pages are
 * contiguous from the boundary: everything before the newest message a search
 * returned has been examined. Two searches run — what was said to the owner and
 * what the owner said — and either may have been the one cut short, so the safe
 * boundary is the *earlier* of the two newest messages; anything one search saw
 * past that point is fetched again next run and answered for by fingerprint.
 * Null when nothing came back at all. Gmail gets no such boundary: its pages run
 * newest-first, so a cut-short run leaves the *old* end unexamined and must hold.
 */
export function slackBoundary(messages: RelayMessage[]): string | null {
  let mine: string | null = null;
  let theirs: string | null = null;
  for (const m of messages) {
    if (m.mine) {
      if (mine === null || m.at > mine) mine = m.at;
    } else if (theirs === null || m.at > theirs) {
      theirs = m.at;
    }
  }
  if (mine !== null && theirs !== null) return mine < theirs ? mine : theirs;
  return mine ?? theirs;
}

// ----------------------------------------------------------- conversations

/**
 * Messages into conversations, with the facts a judgement needs beside them.
 *
 * A Slack conversation is a channel, or a thread within one. A Gmail conversation
 * is a thread. The same message arriving from both searches — the owner mentioning
 * themselves, say — is one message, and the later record's `mine` wins because
 * `from:me` is the more specific claim.
 */
export function conversationsFrom(
  kind: RelayKind,
  messages: RelayMessage[],
  cursor: string | null,
): Conversation[] {
  const since = cursor ? Date.parse(cursor) : NaN;
  const groups = new Map<string, Map<string, RelayMessage>>();
  for (const m of messages) {
    const key = m.thread ? `${m.channel}/${m.thread}` : m.channel;
    const g = groups.get(key) ?? new Map<string, RelayMessage>();
    const prior = g.get(m.id);
    g.set(m.id, prior ? { ...prior, ...m, mine: prior.mine || m.mine } : m);
    groups.set(key, g);
  }
  const out: Conversation[] = [];
  for (const [key, g] of groups) {
    const list = [...g.values()].sort((a, b) => a.at.localeCompare(b.at));
    const last = list.at(-1)!;
    const asks = list.filter((m) => !m.mine && (!Number.isFinite(since) || Date.parse(m.at) > since));
    const mine = list.filter((m) => m.mine);
    out.push({
      kind,
      key,
      channel: last.channel,
      ...(last.thread ? { thread: last.thread } : {}),
      name: last.channelName,
      messages: list,
      asks,
      ball: last.mine ? 'theirs' : 'mine',
      last,
      ...(mine.length ? { myLastAt: mine.at(-1)!.at } : {}),
    });
  }
  // Oldest conversation first, by its newest message: the cursor advances
  // through them in order, which is the rule every channel keeps.
  return out.sort((a, b) => a.last.at.localeCompare(b.last.at));
}

/** The exchange as the classifier reads it: one line per message, the owner's marked. */
export function transcript(conv: Conversation, max = 12): string {
  const tail = conv.messages.slice(-max);
  const lines = tail.map((m) => {
    const hhmm = m.at.slice(5, 16).replace('T', ' ');
    const who = m.mine ? 'you' : m.from;
    return `${hhmm} ${who}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`;
  });
  if (conv.messages.length > max) lines.unshift(`(${conv.messages.length - max} earlier message(s) not shown)`);
  return lines.join('\n');
}

// ----------------------------------------------------------------- tracked

/**
 * Which open notes already track a conversation.
 *
 * Identity is by **what the notes already point at**, not by any window: a Slack
 * note links a message permalink, or carries a `slack:<channel>/<ts>`
 * fingerprint; a Gmail note links the thread URL or carries `gmail:<thread>`.
 * A conversation is tracked when it shares a container with one of those —
 * the same DM or group DM, the same thread, or the same message in a public
 * channel, where a whole channel would be far too broad.
 *
 * Closed notes are left out on purpose. A note that is done has nothing to hear
 * about later chatter in the same DM, and routing every such conversation to the
 * classifier as a possible update is exactly the noise this replaced.
 */
export interface Known {
  /** `<channel>/<ts>` or gmail thread id → open note ids. */
  byMessage: Map<string, string[]>;
  /** Slack channel id → open note ids, for DMs and group DMs. */
  byContainer: Map<string, string[]>;
}

export function knownFor(kind: RelayKind, ctx: IntakeContext): Known {
  const defs = loadFacets(paths(ctx.root).facets);
  /**
   * Open notes only — and a card still in the queue is not one of them. An
   * unjudged card is a proposal, and a proposal must not collect further
   * proposals: one live run chained an update onto the previous tick's card
   * instead of onto the note. A card that `extends` something stands in for
   * that note, which is where its conversation belongs; a card that extends
   * nothing tracks nothing until somebody accepts it.
   */
  const open = (ids: string[]) => {
    const out: string[] = [];
    for (const id of ids) {
      const rec = ctx.notes.get(id);
      if (!rec || isClosed(rec, defs)) continue;
      if (rec.facets.intake?.length) {
        const target = rec.facets.extends?.[0];
        const real = target ? ctx.notes.get(target) : undefined;
        if (real && !isClosed(real, defs) && !real.facets.intake?.length) out.push(real.id);
        continue;
      }
      out.push(id);
    }
    return out;
  };
  const byMessage = new Map<string, string[]>();
  const byContainer = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, ids: string[]) => {
    const kept = open(ids);
    if (kept.length) map.set(key, [...new Set([...(map.get(key) ?? []), ...kept])]);
  };

  for (const [raw, ids] of ctx.links) {
    const link = parseLink(raw);
    if (kind === 'slack' && link.kind === 'slack') {
      const parts = slackPermalinkParts(link.ref);
      if (!parts) continue;
      add(byMessage, `${parts.channel}/${parts.ts}`, ids);
      if (/^[DG]/.test(parts.channel)) add(byContainer, parts.channel, ids);
    }
    if (kind === 'gmail' && link.kind === 'url') {
      const id = gmailThreadIdOf(link.ref);
      if (id) add(byMessage, id, ids);
    }
  }
  for (const [fp, ids] of ctx.fingerprints) {
    if (!fp.startsWith(`${kind}:`)) continue;
    const rest = fp.slice(kind.length + 1);
    if (kind === 'slack') {
      // Both spellings a sweep has written: `C123/1700.000` and `C123:1700.000`.
      const m = /^([A-Z0-9]+)[/:](\d+\.\d+)$/.exec(rest);
      if (!m) continue;
      add(byMessage, `${m[1]}/${m[2]}`, ids);
      if (/^[DG]/.test(m[1]!)) add(byContainer, m[1]!, ids);
    } else {
      // `gmail:<thread>` or `gmail:<thread>@<message>`.
      add(byMessage, rest.split('@')[0]!, ids);
    }
  }
  return { byMessage, byContainer };
}

export function trackedBy(conv: Conversation, known: Known): string[] {
  const ids = new Set<string>();
  if (conv.kind === 'gmail') {
    for (const id of known.byMessage.get(conv.channel) ?? []) ids.add(id);
    return [...ids];
  }
  for (const m of conv.messages) {
    for (const id of known.byMessage.get(`${m.channel}/${m.id}`) ?? []) ids.add(id);
  }
  if (conv.thread) {
    for (const id of known.byMessage.get(`${conv.channel}/${conv.thread}`) ?? []) ids.add(id);
  }
  if (/^[DG]/.test(conv.channel)) {
    for (const id of known.byContainer.get(conv.channel) ?? []) ids.add(id);
  }
  return [...ids];
}
