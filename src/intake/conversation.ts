import { loadFacets } from '../schema/facets.ts';
import { parseLink } from '../schema/links.ts';
import { paths } from '../config.ts';
import { isClosed } from '../index/blocking.ts';
import type { VaultRead } from './run.ts';

/**
 * Slack and Gmail messages, as the conversations they belong to.
 *
 * The connectors write one event per message; what the judge needs is the
 * exchange. So a pass groups the messages it read into conversations — a Slack
 * channel or a thread within one, a Gmail thread — marks the owner's own lines,
 * says whose move it is, and finds the open note that already tracks it. All of
 * it computed, none of it asked of anyone (C8); the classifier sees the exchange
 * and decides what it means.
 *
 * What it can see is what the connectors gathered: `to:me` and `from:me`, so in
 * a channel a third person's reply that mentions nobody is in neither, and a
 * conversation is the messages this pass read — earlier ones were judged by an
 * earlier pass.
 */

export type ConversationKind = 'slack' | 'gmail';

/** One message, in one shape for both sources. */
export interface Message {
  /** The connector event this message is, by kernel id. */
  event: string;
  /** Conversation container: a Slack channel id, or a Gmail thread id. */
  channel: string;
  /** What the source calls it — a channel's name, a thread's subject. */
  channelName: string;
  /** Slack thread root ts, when the message is a reply in one. */
  thread?: string;
  /** A Slack ts, or a Gmail message id (its instant, when gog named none). */
  id: string;
  /** ISO. */
  at: string;
  from: string;
  mine: boolean;
  text: string;
  url?: string;
}

export interface Conversation {
  kind: ConversationKind;
  /** `<channel>` or `<channel>/<thread>`; a Gmail thread id. */
  key: string;
  channel: string;
  thread?: string;
  name: string;
  /** Oldest first. */
  messages: Message[];
  /** Messages from others — what there is to react to. */
  asks: Message[];
  /** Whose move it is, mechanically: the last speaker was the owner or was not. */
  ball: 'mine' | 'theirs';
  last: Message;
  myLastAt?: string;
}

/** Messages into conversations, oldest conversation first by its newest message. */
export function conversationsFrom(kind: ConversationKind, messages: Message[]): Conversation[] {
  const groups = new Map<string, Message[]>();
  for (const m of messages) {
    const key = m.thread ? `${m.channel}/${m.thread}` : m.channel;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const out: Conversation[] = [];
  for (const [key, g] of groups) {
    const list = g.sort((a, b) => a.at.localeCompare(b.at));
    const last = list.at(-1)!;
    const mine = list.filter((m) => m.mine);
    out.push({
      kind,
      key,
      channel: last.channel,
      ...(last.thread ? { thread: last.thread } : {}),
      name: last.channelName,
      messages: list,
      asks: list.filter((m) => !m.mine),
      ball: last.mine ? 'theirs' : 'mine',
      last,
      ...(mine.length ? { myLastAt: mine.at(-1)!.at } : {}),
    });
  }
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

// ------------------------------------------------------------------- links

const SLACK_PERMALINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{16})/;
const SLACK_HOST = /^(?:slack:)?https:\/\/([a-z0-9-]+\.slack\.com)\/archives\//;

/** `…/archives/C123/p1700000000000100` → `{channel: 'C123', ts: '1700000000.000100'}`. */
export function slackPermalinkParts(url: string): { channel: string; ts: string } | null {
  const m = SLACK_PERMALINK.exec(url.trim());
  if (!m) return null;
  return { channel: m[1]!, ts: `${m[2]!.slice(0, 10)}.${m[2]!.slice(10)}` };
}

/** The thread URL Gmail's web client opens, assembled from the id the API gave. */
export const gmailThreadUrl = (id: string): string => `https://mail.google.com/mail/u/0/#all/${id}`;

/** A Gmail thread id off any of the URL shapes a note may carry. */
export function gmailThreadIdOf(url: string): string | null {
  const m = /mail\.google\.com\/mail\/u\/\d+\/#[a-z]+\/([A-Za-z0-9_-]{8,})/.exec(url);
  return m ? m[1]! : null;
}

/** The link a captured conversation carries, which is not its fingerprint. */
export function linkFor(kind: ConversationKind, url: string): string[] {
  if (!/^https?:\/\//.test(url)) return [];
  return [kind === 'slack' ? `slack:${url}` : url];
}

/**
 * Every Slack message with a permalink, assembling the ones the connector had
 * none for: a permalink is a pure function of the workspace host, the channel
 * and the ts, and the host is read off a permalink this pass has, or one a note
 * already carries. With no host anywhere, nothing is invented.
 */
export function withPermalinks(messages: Message[], known: Iterable<string>): Message[] {
  const hostOf = (u: string) => SLACK_HOST.exec(u)?.[1];
  let host = messages.map((m) => (m.url ? hostOf(m.url) : undefined)).find(Boolean);
  if (!host) {
    for (const raw of known) {
      host = hostOf(raw);
      if (host) break;
    }
  }
  if (!host) return messages;
  return messages.map((m) => {
    if (m.url || !/^\d{10}\.\d{6}$/.test(m.id)) return m;
    const thread = m.thread ? `?thread_ts=${m.thread}&cid=${m.channel}` : '';
    return { ...m, url: `https://${host}/archives/${m.channel}/p${m.id.replace('.', '')}${thread}` };
  });
}

// ----------------------------------------------------------------- tracked

/**
 * Which open notes already track a conversation.
 *
 * Identity is by **what the notes already point at**: a Slack note links a
 * message permalink, or carries a `slack:<channel>/<ts>` fingerprint; a Gmail
 * note links the thread URL or carries `gmail:<thread>`. A conversation is
 * tracked when it shares a container with one of those — the same DM or group
 * DM, the same thread, or the same message in a public channel, where a whole
 * channel would be far too broad.
 *
 * Closed notes are left out on purpose: a note that is done has nothing to hear
 * about later chatter in the same DM.
 */
export interface Known {
  /** `<channel>/<ts>` or gmail thread id → open note ids. */
  byMessage: Map<string, string[]>;
  /** Slack channel id → open note ids, for DMs and group DMs. */
  byContainer: Map<string, string[]>;
}

export function knownFor(kind: ConversationKind, ctx: Pick<VaultRead, 'root' | 'notes' | 'links' | 'fingerprints'>): Known {
  const defs = loadFacets(paths(ctx.root).facets);
  /**
   * Open notes only — and a card still in the queue is not one of them. An
   * unjudged card is a proposal, and a proposal must not collect further
   * proposals; a card that `extends` something stands in for that note.
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
