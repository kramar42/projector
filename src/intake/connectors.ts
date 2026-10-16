import { ask, eventId, QUERIES, type Row } from '../kernel/query.ts';
import type { Runner } from './kernel.ts';
import type { Settings } from '../settings.ts';

/**
 * What intake triages: the events the kernel's connectors gathered, read back
 * through projector's saved queries.
 *
 * Gathering is the connectors' job, and the owner runs them by hand
 * (`bin/kernel sync claude-code`, `… jira`, `… slack`, `… gmail`; git's
 * post-commit hook).
 * Projector fetches nothing: it reads what is already in the ledger, judges it,
 * and writes what it decided back as `intake/<channel>` events. So **the cursor
 * is a query**, never a stored value (C11): `projector/intake-newest` answers when
 * the newest intake event of each channel happened — an intake event happens
 * when the connector event it judged did — and `projector/connector-events-since`
 * answers the connector events newer than that. A pass that judged writes intake
 * events, and the next pass's cursor has moved; a pass that held writes none, and
 * the next one reads the same events again.
 *
 * Per channel rather than one instant for all: the owner syncs one connector at
 * a time, so a Jira sync an hour after a Claude Code sync brings events older
 * than the newest session judged, which one cursor would step over.
 */

/** An intake channel: the connector kinds it triages, and how far back it reads with no cursor. */
export interface ChannelDef {
  name: string;
  /** The connector event kinds this channel judges, without the leading colon. */
  kinds: string[];
  /** The kernel connector that gathers them. */
  connector: string;
  /**
   * How the owner runs it. `bin/kernel sync <connector>` for the four that
   * export on demand; git's sync names the repos as a placeholder, so the kernel
   * skips it, and its post-commit hook is what gathers.
   */
  gather: string;
  /** How far back to read when the channel has judged nothing yet, or its cursor is older than this. */
  defaultDays: number;
}

/**
 * The channels, in the order a pass judges them. The names are the intake
 * channels projector has always had — `intake/<name>` events, the `source` facet
 * of a card — so a vault's history and its calibration carry over unchanged.
 */
export const CHANNELS: ChannelDef[] = [
  { name: 'claude', kinds: ['claude/session'], connector: 'claude-code', gather: 'bin/kernel sync claude-code', defaultDays: 7 },
  { name: 'git', kinds: ['git/commit'], connector: 'git', gather: 'the git connector’s post-commit hook', defaultDays: 7 },
  { name: 'jira', kinds: ['jira/issue', 'jira/transition'], connector: 'jira', gather: 'bin/kernel sync jira', defaultDays: 7 },
  { name: 'slack', kinds: ['slack/message'], connector: 'slack', gather: 'bin/kernel sync slack', defaultDays: 7 },
  { name: 'gmail', kinds: ['gmail/message'], connector: 'gmail', gather: 'bin/kernel sync gmail', defaultDays: 14 },
];

export function channelNames(): string[] {
  return CHANNELS.map((c) => c.name);
}

export function channelOfKind(kind: string): ChannelDef | undefined {
  return CHANNELS.find((c) => c.kinds.includes(kind));
}

/** One connector event, as the kernel holds it. */
export interface ConnectorEvent {
  /** The kernel's id for it, derived from its key. */
  id: string;
  /** `claude/session`, `git/commit`, … without the colon the kernel prints. */
  kind: string;
  /**
   * The key the connector wrote it under, recovered from its payload and checked
   * against `id` — or null when the payload does not carry enough to rebuild it
   * (a `jira/transition`, whose key names a changelog entry its payload omits).
   */
  key: string | null;
  /** ISO, with milliseconds. */
  at: string;
  /** Every alias of every entity it is about. */
  about: string[];
  payload: Record<string, unknown>;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** ISO with milliseconds, as JavaScript writes it and the connectors key with. The kernel prints none when they are zero. */
export const isoOf = (at: string): string => {
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toISOString() : at;
};

/**
 * The keys a connector could have written this event under, by its kind. Each
 * is the connector's own rule (`kernel/connectors/<id>/kernel/export.bb`):
 * `claude:<session>@<ended>`, `git:<repo>:<sha>`, `jira:<KEY>@<status> ·
 * <assignee>`, `slack:<channel>/<ts>`, `gmail:<thread>@<message>` (or `@<at>`,
 * through gog, which names no message).
 */
function keysFor(kind: string, p: Record<string, unknown>, about: string[], at: string): string[] {
  switch (kind) {
    case 'claude/session':
      return [`claude:${s(p.session)}@${s(p.ended)}`];
    case 'git/commit':
      return about.filter((a) => a.startsWith('repo:')).map((a) => `git:${a.slice(5)}:${s(p.sha)}`);
    case 'jira/issue':
      return [`jira:${s(p.key)}@${s(p.status)} · ${s(p.assignee)}`];
    case 'slack/message':
      return [`slack:${s(p.channel)}/${s(p.ts)}`];
    case 'gmail/message':
      return [
        ...(p.message ? [`gmail:${s(p.thread)}@${s(p.message)}`] : []),
        `gmail:${s(p.thread)}@${isoOf(at)}`,
      ];
    default:
      return [];
  }
}

/**
 * The key this event was written under, or null. Only a key the kernel would
 * derive this event's id from is answered, so a payload that changed shape
 * reads as unrecoverable rather than as a wrong key.
 */
export function keyOf(e: Omit<ConnectorEvent, 'key'>): string | null {
  return keysFor(e.kind, e.payload, e.about, e.at).find((k) => eventId(k) === e.id) ?? null;
}

/**
 * The key a judged connector event's intake event goes by: `intake:` and the
 * connector's key — never the connector's key itself, which the kernel already
 * holds and would take for the same event. An event whose key cannot be
 * recovered goes by its kind and kernel id instead, which is as stable.
 */
export function intakeKey(e: Pick<ConnectorEvent, 'key' | 'kind' | 'id'>): string {
  return e.key ? `intake:${e.key}` : `intake:${e.kind}:${e.id}`;
}

/** Rows of `connector-events-since` or `connector-event`, one per event and alias, folded into events, oldest first. */
export function eventsOf(rows: Row[]): ConnectorEvent[] {
  const byId = new Map<string, Omit<ConnectorEvent, 'key'>>();
  for (const r of rows) {
    const id = s(r.event);
    if (!id) continue;
    const about = s(r.about);
    const had = byId.get(id);
    if (had) {
      if (about && !had.about.includes(about)) had.about.push(about);
      continue;
    }
    const payload = r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload) ? (r.payload as Record<string, unknown>) : {};
    byId.set(id, {
      id,
      kind: s(r.kind).replace(/^:/, ''),
      at: isoOf(s(r.at)),
      about: about ? [about] : [],
      payload,
    });
  }
  return [...byId.values()]
    .map((e) => ({ ...e, about: e.about.sort(), key: keyOf(e) }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** Every answer below: what it read, or why it read nothing. Never throws. */
export type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * A read is on a timer's path and the CLI's, never a request's, so it may take
 * the kernel's whole timeout. Rows: one per event and alias. The kernel refuses
 * more than this rather than cutting them, which is a reason, never a partial pass.
 */
const ROWS = 10_000;

/** The cursor: each channel's newest judged instant, by channel name. A channel absent from the map never judged. */
export async function readCursors(cfg: Settings['kernel'], run?: Runner): Promise<Read<Map<string, string>>> {
  const r = await ask(cfg, QUERIES.intakeNewest, {}, { ...(run ? { run } : {}) });
  if (!r.ok) return r;
  const out = new Map<string, string>();
  for (const row of r.rows) {
    const vals = Object.values(row);
    const kind = s(vals[0]).replace(/^:/, '');
    const at = s(vals[1]);
    if (!kind.startsWith('intake/') || !Number.isFinite(Date.parse(at))) continue;
    out.set(kind.slice('intake/'.length), isoOf(at));
  }
  return { ok: true, value: out };
}

/** The connector events of `kinds` that happened after `since`, oldest first. */
export async function readEvents(
  cfg: Settings['kernel'],
  since: string,
  kinds: string[],
  run?: Runner,
): Promise<Read<ConnectorEvent[]>> {
  if (!kinds.length) return { ok: true, value: [] };
  const r = await ask(
    cfg,
    QUERIES.connectorEventsSince,
    { since, kinds: ` ${kinds.map((k) => `:${k}`).join(' ')} ` },
    { ...(run ? { run } : {}), limit: ROWS },
  );
  if (!r.ok) return r;
  return { ok: true, value: eventsOf(r.rows) };
}

/** One connector event by its kernel id, or null when the kernel holds none. */
export async function readEvent(cfg: Settings['kernel'], id: string, run?: Runner): Promise<Read<ConnectorEvent | null>> {
  const r = await ask(cfg, QUERIES.connectorEvent, { event: id }, { ...(run ? { run } : {}) });
  if (!r.ok) return r;
  return { ok: true, value: eventsOf(r.rows)[0] ?? null };
}
