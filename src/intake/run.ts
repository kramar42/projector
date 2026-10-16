import { resolve, sep } from 'node:path';
import { reindex } from '../index/indexer.ts';
import { ago } from '../sources/run.ts';
import { localBaseName, originSlug } from '../sources/git.ts';
import { loadFacets } from '../schema/facets.ts';
import { parseLink } from '../schema/links.ts';
import { paths } from '../config.ts';
import { isClosed } from '../index/blocking.ts';
import { channelEnabled, settingsFor } from '../settings.ts';
import { suppressedFingerprints, unofferedRescues } from './db.ts';
import { evidenceFor, repoIndex } from './match.ts';
import {
  CHANNELS,
  channelNames,
  channelOfKind,
  readCursors,
  readEvent,
  readEvents,
  type ChannelDef,
  type ConnectorEvent,
} from './connectors.ts';
import {
  conversationsFrom,
  knownFor,
  linkFor,
  transcript,
  trackedBy,
  withPermalinks,
  type ConversationKind,
  type Message,
} from './conversation.ts';
import type { Runner } from './kernel.ts';
import type { Candidate, IntakeContext, Match, Skipped } from './types.ts';

/**
 * The pass's read: the connector events intake has not judged, as candidates.
 *
 * It reads; it decides nothing and writes nothing. Each channel's cursor is the
 * newest `intake/<channel>` event in the kernel (`connectors.ts`), so what this
 * returns is everything the connectors gathered after the last judgment — and a
 * pass that judged it (`pollOnce`, behind both the timer and `pj intake`) writes
 * the intake events that move the cursor past it. `pj intake --dry-run` is this
 * read alone.
 *
 * **What it decides is only what is decidable.** A session too short to be work,
 * one outside every declared repo, an item a note already carries, one somebody
 * declined, the owner's own message — each is a `skipped` with its reason, which
 * the pass still records, so the cursor passes it. Everything else is a
 * candidate with the vault's evidence beside it, for the judge.
 */

export { CHANNELS, channelNames };

/**
 * Candidates sent to the judge per channel per pass. A backlog — a week of
 * sessions synced at once — is judged a slice at a time, oldest first, the cursor
 * moving to the end of each, and the server's next tick comes sooner while a
 * channel is behind (`poll.catchUpSeconds`). Skips do not count: they cost the
 * judge nothing, and a backlog of the app's own sessions must not take a pass
 * per forty of them.
 */
export const DEFAULT_LIMIT = 25;

export type VaultRead = IntakeContext;

/**
 * The vault, read once for all channels.
 *
 * The index rebuild is ~37ms and every channel wants the same three things out of
 * it — which fingerprints exist, which links exist, and the full-text index — so
 * paying for it per channel would be paying three times for one answer.
 */
export function readVault(root: string): VaultRead {
  const { db, notes } = reindex(root);
  const fingerprints = new Map<string, string[]>();
  const links = new Map<string, string[]>();

  for (const rec of notes.values()) {
    // A note's own fingerprint and every one it absorbed in a merge, which count
    // the same here: both mean "this candidate is already in the vault", and the
    // note that answers for it is this one.
    for (const fp of [rec.source_fingerprint, ...(rec.absorbed_fingerprints ?? [])]) {
      if (fp) fingerprints.set(fp, [...(fingerprints.get(fp) ?? []), rec.id]);
    }
    for (const l of rec.links) {
      links.set(l.raw, [...(links.get(l.raw) ?? []), rec.id]);
    }
  }
  return { root, db, notes, fingerprints, links, suppressed: suppressedFingerprints(root) };
}

/** One channel of a pass: what it read, and what of that goes to the judge. */
export interface ChannelReport {
  channel: string;
  /** The connector that gathers it. */
  connector: string;
  /** How the owner runs that connector. */
  gather: string;
  /** The newest connector event this channel has judged — the newest intake event's instant — or null when none. */
  cursor: string | null;
  /** Where reading began: the cursor, or the window's start when there is none or it is older. */
  since: string;
  /** Connector events read, rescues included. */
  read: number;
  candidates: Candidate[];
  skipped: Skipped[];
  /** The limit stopped the read before the events did: more are waiting behind this slice. */
  truncated?: boolean;
  /** Anything else worth saying: a cursor older than the window, a key that could not be recovered. */
  note?: string;
  /** Fingerprints of declines taken back that this pass offers again. */
  rescued?: string[];
}

export type Pending =
  | { ok: true; reports: ChannelReport[]; unknown: string[] }
  | { ok: false; reason: string; unknown: string[] };

/** What intake says when the vault's kernel block is off: there is nowhere to read from. */
export const KERNEL_OFF =
  'the kernel block is off for this vault, so intake has nothing to read: it triages what the kernel’s connectors gathered (bin/kernel sync), and never fetches';

export interface PendingOptions {
  /** Channel names to read. Empty means the ones this vault turned on. */
  only?: string[];
  /** Read from here instead of each channel's cursor, for a preview. */
  since?: Date;
  limit?: number;
  /** Stands in for spawning the kernel, for a test. */
  run?: Runner;
  now?: number;
}

const daysAgo = (n: number, now: number) => new Date(now - n * 86_400_000).toISOString();
const day = (iso: string) => iso.slice(0, 10);

/**
 * Where a channel reads from: `--since` wins, then the cursor, then the
 * channel's window — and the window bounds the cursor too. **Intake is for
 * current asks**: a cursor weeks old, from a vault that stopped polling, is not
 * followed back through asks settled since; the pass reads from the window and
 * says what it stepped over.
 */
export function startOf(
  channel: Pick<ChannelDef, 'defaultDays'>,
  cursor: string | null,
  since?: Date,
  now = Date.now(),
): { since: string; note?: string } {
  if (since && Number.isFinite(since.getTime())) return { since: since.toISOString() };
  const window = daysAgo(channel.defaultDays, now);
  if (!cursor) return { since: window };
  if (cursor >= window) return { since: cursor };
  return {
    since: window,
    note: `cursor ${day(cursor)} is older than the ${channel.defaultDays}-day window: read from ${day(window)}, and stepped over what came between`,
  };
}

export async function pending(root: string, opts: PendingOptions = {}): Promise<Pending> {
  const wanted = opts.only?.length ? opts.only : channelNames().filter((n) => channelEnabled(root, n));
  const unknown = wanted.filter((w) => !CHANNELS.some((c) => c.name === w));
  const settings = settingsFor(root);
  if (!settings.kernel.enabled) return { ok: false, reason: KERNEL_OFF, unknown };

  const channels = CHANNELS.filter((c) => wanted.includes(c.name));
  if (!channels.length) return { ok: true, reports: [], unknown };
  const now = opts.now ?? Date.now();
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);

  const cursors = await readCursors(settings.kernel, opts.run);
  if (!cursors.ok) return { ok: false, reason: cursors.reason, unknown };
  const starts = new Map(channels.map((c) => [c.name, startOf(c, cursors.value.get(c.name) ?? null, opts.since, now)]));
  const earliest = [...starts.values()].map((s) => s.since).sort()[0]!;
  const read = await readEvents(settings.kernel, earliest, channels.flatMap((c) => c.kinds), opts.run);
  if (!read.ok) return { ok: false, reason: read.reason, unknown };

  // Declines taken back: their events sit behind the cursor, so each is read by
  // id and offered once more. Never in a preview from an arbitrary `--since`,
  // which is about what the window holds.
  const rescued = new Map<string, { fingerprint: string; event: ConnectorEvent }[]>();
  if (!opts.since) {
    for (const r of unofferedRescues(root)) {
      const got = await readEvent(settings.kernel, r.event, opts.run);
      if (!got.ok) return { ok: false, reason: got.reason, unknown };
      const ch = got.value ? channelOfKind(got.value.kind) : undefined;
      if (!got.value || !ch) continue;
      rescued.set(ch.name, [...(rescued.get(ch.name) ?? []), { fingerprint: r.fingerprint, event: got.value }]);
    }
  }

  const vault = readVault(root);
  const reports: ChannelReport[] = [];
  for (const c of channels) {
    const start = starts.get(c.name)!;
    const all = read.value.filter((e) => c.kinds.includes(e.kind) && e.at > start.since);
    const { slice, mapped } = sliceOf(c.name, vault, all, limit);
    const back = (rescued.get(c.name) ?? []).filter((r) => !slice.some((e) => e.id === r.event.id));
    const again = back.length ? mapEvents(c.name, vault, back.map((r) => r.event)) : { candidates: [], skipped: [] };
    const unkeyed = slice.filter((e) => !e.key).length;
    const notes = [
      start.note,
      unkeyed ? `${unkeyed} event(s) whose connector key could not be recovered, recorded by kernel id` : undefined,
    ].filter(Boolean);
    reports.push({
      channel: c.name,
      connector: c.connector,
      gather: c.gather,
      cursor: cursors.value.get(c.name) ?? null,
      since: start.since,
      read: slice.length + back.length,
      candidates: [...again.candidates, ...mapped.candidates],
      skipped: [...again.skipped, ...mapped.skipped],
      ...(slice.length < all.length ? { truncated: true } : {}),
      ...(notes.length ? { note: notes.join('; ') } : {}),
      ...(back.length ? { rescued: back.map((r) => r.fingerprint) } : {}),
    });
  }
  return { ok: true, reports, unknown };
}

/**
 * The longest run of the oldest events that maps to at most `limit` candidates,
 * cut only between two instants: the cursor is an instant, so everything up to
 * the cut is recorded and nothing after it, and a cut between two events of one
 * instant would leave the second behind a cursor that has already passed it. The
 * first instant is taken whatever it holds, so a pass always moves.
 *
 * Mapped rather than counted, because what costs is a candidate and a candidate
 * is a group — a branch's commits, a conversation's asks — so the slice is found
 * by mapping prefixes, a binary search's worth of them.
 */
function sliceOf(channel: string, vault: VaultRead, events: ConnectorEvent[], limit: number): { slice: ConnectorEvent[]; mapped: Mapped } {
  const whole = mapEvents(channel, vault, events);
  if (whole.candidates.length <= limit) return { slice: events, mapped: whole };
  const cuts: number[] = [];
  for (let i = 1; i <= events.length; i++) if (i === events.length || events[i]!.at !== events[i - 1]!.at) cuts.push(i);
  const fits = (n: number) => mapEvents(channel, vault, events.slice(0, n)).candidates.length <= limit;
  let lo = 0;
  let hi = cuts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(cuts[mid]!)) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const slice = events.slice(0, cuts[best]);
  return { slice, mapped: mapEvents(channel, vault, slice) };
}

interface Mapped {
  candidates: Candidate[];
  skipped: Skipped[];
}

/** One channel's events as candidates and skips, by what kind of thing they are. */
export function mapEvents(channel: string, ctx: VaultRead, events: ConnectorEvent[]): Mapped {
  const out: Mapped =
    channel === 'claude'
      ? mapClaude(ctx, events)
      : channel === 'git'
        ? mapGit(ctx, events)
        : channel === 'jira'
          ? mapJira(ctx, events)
          : channel === 'slack' || channel === 'gmail'
            ? mapConversations(channel, ctx, events)
            : { candidates: [], skipped: events.map((e) => skip(e, e.key ?? e.id, e.kind, 'no channel reads this kind')) };
  // Declined once is declined: the pass skips it with that reason rather than
  // dropping it silently, so a preview never reads quieter than it was.
  const kept: Candidate[] = [];
  for (const c of out.candidates) {
    if (ctx.suppressed.has(c.fingerprint)) out.skipped.push(skip(c.event!, c.fingerprint, c.title, 'suppressed earlier'));
    else if (c.evidence?.capturedAs?.length) {
      out.skipped.push(skip(c.event!, c.fingerprint, c.title, `already captured as ${c.evidence.capturedAs.join(', ')}`));
    } else kept.push(c);
  }
  return { candidates: kept, skipped: out.skipped };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

function skip(event: ConnectorEvent, fingerprint: string, title: string, why: string): Skipped {
  return { fingerprint, title, why, event };
}

/**
 * The newest event of each group, and the rest folded into it: a session that
 * moved twice between two passes, six commits on one branch, three messages in
 * one thread are one thing to judge, and the judge is shown all of it.
 */
function newestOf<T>(events: ConnectorEvent[], keyOf: (e: ConnectorEvent) => T): Map<T, ConnectorEvent[]> {
  const groups = new Map<T, ConnectorEvent[]>();
  for (const e of events) groups.set(keyOf(e), [...(groups.get(keyOf(e)) ?? []), e]);
  return groups;
}

// ------------------------------------------------------------------ claude

/**
 * Sessions with fewer real turns than this are noise — a one-shot question, a
 * `--resume` that was abandoned, an accidental launch.
 */
const MIN_TURNS = 3;

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);

/**
 * Whether a session's directory makes it this vault's work.
 *
 * A machine's `~/.claude` holds every session ever run on it — personal
 * projects, one-off questions, and the app's own headless runs, which live under
 * a vault's `.projector`. None of that is this vault's work. So a session counts
 * only inside a repo some project note declares or a workspace some note
 * recorded (`workspace:` links); the app's own sessions are named for what they
 * are. Deterministic, and widened by declaring a repo.
 */
export function placeOf(
  cwd: string | undefined,
  repos: string[],
  workspaces: string[],
): 'work' | 'app' | 'outside' | 'unknown' {
  if (!cwd) return 'unknown';
  const here = resolve(cwd);
  if (here.split(sep).includes('.projector')) return 'app';
  if (repos.some((r) => inside(here, r)) || workspaces.some((w) => inside(here, w))) return 'work';
  return 'outside';
}

function workspacesIn(ctx: VaultRead): string[] {
  const out: string[] = [];
  for (const raw of ctx.links.keys()) {
    const link = parseLink(raw);
    if (link.kind === 'workspace') out.push(resolve(link.ref.trim()));
  }
  return out;
}

/**
 * `claude/session`: one candidate per session, `claude:<uuid>` — the session's
 * identity, so a session already on a note is answered for however often it
 * moves. Its connector key carries the move (`@<last activity>`).
 */
function mapClaude(ctx: VaultRead, events: ConnectorEvent[]): Mapped {
  const repos = repoIndex(ctx).map((r) => r.path);
  const workspaces = workspacesIn(ctx);
  const out: Mapped = { candidates: [], skipped: [] };
  for (const group of newestOf(events, (e) => str(e.payload.session)).values()) {
    const e = group.at(-1)!;
    const p = e.payload;
    const uuid = str(p.session);
    const fingerprint = `claude:${uuid}`;
    const title = str(p.title) || `session ${uuid.slice(0, 8)}`;
    for (const older of group.slice(0, -1)) out.skipped.push(skip(older, fingerprint, title, 'folded into the session’s newer move'));

    const linked = ctx.links.get(fingerprint) ?? [];
    if (linked.length) {
      out.skipped.push(skip(e, fingerprint, title, `already linked from ${linked.join(', ')}`));
      continue;
    }
    const turns = Number(p.turns ?? 0);
    if (turns < MIN_TURNS) {
      out.skipped.push(skip(e, fingerprint, title, `${turns} turn(s) — below the threshold for work`));
      continue;
    }
    const cwd = str(p.project) || undefined;
    const place = placeOf(cwd, repos, workspaces);
    if (place !== 'work') {
      out.skipped.push(
        skip(
          e,
          fingerprint,
          title,
          place === 'app'
            ? 'the app’s own session, under a .projector directory'
            : place === 'unknown'
              ? 'no working directory recorded'
              : `${cwd} is outside every declared repo and recorded workspace`,
        ),
      );
      continue;
    }
    const branch = str(p.branch) || undefined;
    out.candidates.push({
      channel: 'claude',
      fingerprint,
      title,
      links: [fingerprint],
      when: e.at,
      detail: [cwd, branch].filter(Boolean).join(' @ '),
      fields: [
        { k: 'turns', v: String(turns) },
        { k: 'started', v: str(p.started) },
        { k: 'last', v: ago(e.at) },
        { k: 'cwd', v: cwd ?? '' },
        { k: 'branch', v: branch ?? '' },
      ].filter((f) => f.v),
      evidence: evidenceFor(ctx, { fingerprint, links: [fingerprint], cwd, branch, text: title }),
      event: e,
    });
  }
  return out;
}

// --------------------------------------------------------------------- git

/**
 * `git/commit`: the unit is a **branch, not a commit.** Six commits on one
 * branch are one piece of work, `git:<repo>@<branch>`, stable while the work
 * continues; the newest commit's event is the candidate and the others fold into
 * it. A commit on the base branch stands alone, `git:<repo>@<sha>`: commits land
 * there from unrelated work.
 */
function mapGit(ctx: VaultRead, events: ConnectorEvent[]): Mapped {
  const byName = new Map<string, string>();
  for (const r of repoIndex(ctx)) if (!byName.has(r.name)) byName.set(r.name, r.path);
  const slugs = new Map<string, string | null>();
  const bases = new Map<string, string>();
  const slugOf = (path: string) => (slugs.has(path) ? slugs.get(path)! : (slugs.set(path, originSlug(path)), slugs.get(path)!));
  const baseOf = (path: string) => bases.get(path) ?? (bases.set(path, localBaseName(path)), bases.get(path)!);

  const repoOf = (e: ConnectorEvent) => e.about.find((a) => a.startsWith('repo:'))?.slice(5) ?? '';
  const unit = (e: ConnectorEvent) => {
    const name = repoOf(e);
    const path = byName.get(name);
    const branch = str(e.payload.branch).replace(/^origin\//, '');
    const base = path ? baseOf(path) : null;
    const onBase = !branch || branch === 'HEAD' || (base ? branch === base : branch === 'main' || branch === 'master');
    return { name, path, branch, onBase, key: onBase ? `${name}@${str(e.payload.sha)}` : `${name}@${branch}` };
  };

  const out: Mapped = { candidates: [], skipped: [] };
  for (const [key, group] of newestOf(events, (e) => unit(e).key)) {
    const e = group.at(-1)!;
    const u = unit(e);
    const fingerprint = `git:${key}`;
    const subjects = group.map((g) => str(g.payload.subject));
    const title = subjects[0] || u.branch || str(e.payload.sha).slice(0, 8);
    for (const older of group.slice(0, -1)) out.skipped.push(skip(older, fingerprint, title, `folded into ${fingerprint}`));

    const slug = u.path ? slugOf(u.path) : null;
    const links = slug ? [u.onBase ? `gh:commit:${slug}@${str(e.payload.sha)}` : `gh:branch:${slug}@${u.branch}`] : [];
    const evidence = evidenceFor(ctx, {
      fingerprint,
      links,
      ...(u.path ? { cwd: u.path } : {}),
      ...(u.branch ? { branch: u.branch } : {}),
      text: [u.onBase ? '' : u.branch, ...subjects].join(' '),
    });
    const captured = evidence.capturedAs ?? [];
    const linked = evidence.linkedTo ?? [];
    if (captured.length || linked.length) {
      out.skipped.push(
        skip(e, fingerprint, title, captured.length ? `already captured as ${captured.join(', ')}` : `already linked from ${linked.join(', ')}`),
      );
      continue;
    }
    out.candidates.push({
      channel: 'git',
      fingerprint,
      title,
      links,
      when: e.at,
      detail: u.onBase
        ? `${u.name} @ ${u.branch || 'base'} — one commit on the base branch`
        : `${u.name} @ ${u.branch} — ${group.length} commit(s)`,
      fields: [
        { k: 'repo', v: u.name },
        { k: 'branch', v: u.branch },
        { k: 'commits', v: group.map((g) => `${str(g.payload.sha).slice(0, 8)} ${str(g.payload.subject)}`).join(' · ') },
      ].filter((f) => f.v),
      evidence,
      event: e,
    });
  }
  return out;
}

// -------------------------------------------------------------------- jira

/**
 * `jira/issue` and `jira/transition`: issues that moved and have something to do
 * with the owner. The connector writes an issue event only when its status or
 * assignee is new, so every one is a move.
 *
 * **An issue a note already tracks is an update**, offered as a candidate that
 * can only extend the tracking note — keyed per move, `jira:KEY@<updated>`, so
 * each move is its own offer and its own decline. One tracked only by a closed
 * note is skipped: finished work does not reopen because Jira ticked. A
 * transition folds into its issue's event when the pass read both; alone, it is
 * the move.
 */
function mapJira(ctx: VaultRead, events: ConnectorEvent[]): Mapped {
  const defs = loadFacets(paths(ctx.root).facets);
  const out: Mapped = { candidates: [], skipped: [] };
  for (const [key, group] of newestOf(events, (e) => str(e.payload.key))) {
    const issues = group.filter((e) => e.kind === 'jira/issue');
    const moves = group.filter((e) => e.kind === 'jira/transition');
    const e = issues.at(-1) ?? moves.at(-1)!;
    const p = e.payload;
    const base = `jira:${key}`;
    const movesText = moves.map((m) => `${str(m.payload.from)} → ${str(m.payload.to)} by ${str(m.payload.by) === 'kernel:owner' ? 'you' : str(m.payload.by)}`);
    const summary = str(p.summary);
    const title = issues.length ? summary || key : `${key}: ${movesText.at(-1) ?? 'moved'}`;
    for (const other of group) if (other !== e) out.skipped.push(skip(other, base, title, `folded into ${key}'s newest event`));

    const status = issues.length ? str(p.status) : str(p.to);
    const fields = [
      { k: 'key', v: key },
      { k: 'status', v: status },
      { k: 'assignee', v: str(p.assignee) },
      { k: 'updated', v: ago(str(p.updated) || e.at) },
      { k: 'epic', v: str(p.epic) },
      { k: 'url', v: str(p.url) },
      { k: 'moves', v: movesText.join(' · ') },
    ].filter((f) => f.v);
    const evidence = evidenceFor(ctx, { fingerprint: base, links: [base], text: `${key} ${summary}` });
    const tracking = [...new Set([...(evidence.linkedTo ?? []), ...(evidence.capturedAs ?? [])])];
    // A card still in the queue tracks nothing itself: it is a proposal, and a
    // proposal must not collect further proposals. One that extends a note
    // stands in for that note; one that extends nothing has captured the issue.
    const standsFor = tracking.flatMap((id) => {
      const n = ctx.notes.get(id);
      if (!n?.facets.intake?.length) return [id];
      const target = n.facets.extends?.[0] ? ctx.notes.get(n.facets.extends[0]) : undefined;
      return target && !target.facets.intake?.length ? [target.id] : [];
    });
    const tracked = [...new Set(standsFor)].filter((id) => !isClosed(ctx.notes.get(id), defs));
    const queued = tracking.filter((id) => ctx.notes.get(id)?.facets.intake?.length);
    const detail = [key, status, str(p.type)].filter(Boolean).join(' · ');

    if (tracked.length) {
      const matches: Match[] = tracked.map((id) => ({ id, title: ctx.notes.get(id)?.title ?? id, why: 'tracked' }));
      for (const m of evidence.matches ?? []) if (!matches.some((x) => x.id === m.id)) matches.push(m);
      out.candidates.push({
        channel: 'jira',
        fingerprint: `${base}@${str(p.updated) || e.at}`,
        title,
        links: [base],
        when: e.at,
        detail: `${detail} — tracked by ${tracked.join(', ')}`,
        fields: [...fields, { k: 'tracked_as', v: tracked.join(', ') }],
        evidence: { linkedTo: tracked, matches },
        event: e,
      });
      continue;
    }
    if (queued.length) {
      out.skipped.push(skip(e, base, `${key} ${summary}`.trim(), `already captured as ${queued.join(', ')}, still in the queue`));
      continue;
    }
    if (tracking.length) {
      out.skipped.push(skip(e, base, `${key} ${summary}`.trim(), `already on ${tracking.join(', ')}, which is closed`));
      continue;
    }
    out.candidates.push({ channel: 'jira', fingerprint: base, title, links: [base], when: e.at, detail, fields, evidence, event: e });
  }
  return out;
}

// ----------------------------------------------------------- conversations

function messageOf(kind: ConversationKind, e: ConnectorEvent): Message {
  const p = e.payload;
  if (kind === 'slack') {
    const mine = str(p.author) === 'kernel:owner';
    return {
      event: e.id,
      channel: str(p.channel),
      channelName: str(p.channel_name) || str(p.channel),
      ...(str(p.thread) ? { thread: str(p.thread) } : {}),
      id: str(p.ts),
      at: e.at,
      from: mine ? 'you' : str(p.author),
      mine,
      text: str(p.text),
      ...(str(p.permalink) ? { url: str(p.permalink) } : {}),
    };
  }
  const mine = str(p.from) === 'kernel:owner';
  return {
    event: e.id,
    channel: str(p.thread),
    channelName: str(p.subject) || str(p.thread),
    id: str(p.message) || e.at,
    at: e.at,
    from: mine ? 'you' : str(p.from),
    mine,
    text: [str(p.subject), str(p.snippet)].filter(Boolean).join(' — '),
    ...(str(p.url) ? { url: str(p.url) } : {}),
  };
}

/**
 * `slack/message` and `gmail/message`: the unit is the **conversation** — a DM,
 * a group DM or a thread; a Gmail thread — with something new from someone else.
 * The owner's own messages are not news to them; they are skipped, and shown to
 * the judge as part of the exchange, so "they asked, you answered" is a drop it
 * can see.
 *
 * One candidate per conversation: the first new ask of a discovery, keyed by
 * that message; the newest ask of a conversation an open note tracks, keyed by
 * it, so each new exchange is its own offer and its own decline. The other asks
 * fold into it. A tracked one names the notes it may extend, first among its
 * matches, and `classify` will let it do nothing else.
 */
function mapConversations(kind: ConversationKind, ctx: VaultRead, events: ConnectorEvent[]): Mapped {
  const byId = new Map(events.map((e) => [e.id, e]));
  let messages = events.map((e) => messageOf(kind, e));
  if (kind === 'slack') messages = withPermalinks(messages, ctx.links.keys());
  const known = knownFor(kind, ctx);
  const out: Mapped = { candidates: [], skipped: [] };
  const fpOf = (m: Message, tracked: boolean) =>
    kind === 'slack' ? `slack:${m.channel}/${m.id}` : tracked ? `gmail:${m.channel}@${m.id}` : `gmail:${m.channel}`;

  for (const conv of conversationsFrom(kind, messages)) {
    for (const m of conv.messages.filter((x) => x.mine)) {
      out.skipped.push(skip(byId.get(m.event)!, fpOf(m, true), conv.name, 'your own message'));
    }
    const asks = conv.asks.filter((m) => m.text.trim());
    for (const m of conv.asks.filter((x) => !x.text.trim())) {
      out.skipped.push(skip(byId.get(m.event)!, fpOf(m, true), conv.name, 'nothing said in words'));
    }
    if (!asks.length) continue;

    const tracked = trackedBy(conv, known);
    const anchor = tracked.length ? asks.at(-1)! : asks[0]!;
    const fingerprint = fpOf(anchor, tracked.length > 0);
    const title = (anchor.text || conv.name).replace(/\s+/g, ' ').slice(0, 300);
    for (const m of asks) if (m !== anchor) out.skipped.push(skip(byId.get(m.event)!, fpOf(m, true), title, `folded into ${fingerprint}`));

    const links = linkFor(kind, anchor.url ?? '');
    const mechanical = evidenceFor(ctx, { fingerprint, links, text: [conv.name, ...asks.map((m) => m.text)].join(' ') });
    const others = [...new Set(asks.map((m) => m.from))];
    const who = others.length > 2 ? `${others.slice(0, 2).join(', ')} and others` : others.join(' and ');
    const where =
      kind === 'gmail'
        ? `email “${conv.name.slice(0, 60)}”`
        : others.includes(conv.name) || (/^[DG]/.test(conv.channel) && others.length === 1)
          ? 'a DM'
          : conv.name;
    const lastBy = conv.last.mine ? 'you' : conv.last.from;
    const matches: Match[] = tracked.map((id) => ({ id, title: ctx.notes.get(id)?.title ?? id, why: 'tracked' }));
    for (const m of mechanical.matches ?? []) if (!matches.some((x) => x.id === m.id)) matches.push(m);

    out.candidates.push({
      channel: kind,
      fingerprint,
      title,
      links,
      when: anchor.at,
      detail:
        `${who} in ${where} — ${asks.length} new message(s), last word ${lastBy} ${ago(conv.last.at)}` +
        (tracked.length ? `; already on ${tracked.join(', ')}` : ''),
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
      event: byId.get(anchor.event)!,
    });
  }
  return out;
}

// ----------------------------------------------------------------- reading

/**
 * Which notes already carry each of these fingerprints or links.
 *
 * `pj add --fingerprint` refuses a duplicate anyway; this is what lets an
 * integration be honest before it gets that far.
 */
export function known(root: string, refs: string[]): { ref: string; cards: string[] }[] {
  const vault = readVault(root);
  return refs.map((ref) => ({
    ref,
    cards: [...new Set([...(vault.fingerprints.get(ref) ?? []), ...(vault.links.get(ref) ?? [])])],
  }));
}

/** Total candidates across a read, which is what "anything to look at" means. */
export function candidateCount(reports: ChannelReport[]): number {
  return reports.reduce((n, r) => n + r.candidates.length, 0);
}

function line(s: string, width: number): string {
  return s.length > width ? s.slice(0, width - 1) + '…' : s.padEnd(width);
}

/** `pj intake --dry-run`: what the next pass would judge, judged by nobody. */
export function renderPreview(p: Pending, opts: { verbose?: boolean } = {}): string {
  if (!p.ok) return `nothing read: ${p.reason}`;
  const L: string[] = [];
  for (const r of p.reports) {
    const from = r.cursor ? `since ${ago(r.cursor) || r.cursor}` : `nothing judged yet — reading from ${day(r.since)}`;
    L.push(`## ${r.channel}  (${from}; gathered by ${r.gather})`);
    if (r.note) L.push(`   ${r.note}`);
    for (const c of r.candidates) {
      const mark = c.evidence?.linkedTo?.length ? 'update ' : '';
      L.push(`   ${mark}${line(c.title, mark ? 59 : 66)}  ${c.fingerprint}`);
      if (c.detail) L.push(`      ${c.detail}`);
      const ev = c.evidence;
      if (ev?.matches?.length) L.push(`      may belong to: ${ev.matches.map((m) => `${m.id} (${m.why})`).join(', ')}`);
      if (opts.verbose && c.fields?.length) L.push(`      ${c.fields.map((f) => `${f.k}=${f.v}`).join('  ')}`);
    }
    if (!r.read) L.push('   nothing new');
    const tail: string[] = [];
    if (r.skipped.length) tail.push(`${r.skipped.length} skipped`);
    if (r.truncated) tail.push('more behind this slice');
    if (r.rescued?.length) tail.push(`${r.rescued.length} taken back, offered again`);
    if (tail.length) L.push(`   (${tail.join('; ')})`);
    if (opts.verbose) for (const sk of r.skipped) L.push(`      − ${line(sk.title, 60)}  ${sk.why}`);
    L.push('');
  }
  if (p.unknown.length) L.push(`unknown channel(s): ${p.unknown.join(', ')} — have ${channelNames().join(', ')}`);
  L.push(`${candidateCount(p.reports)} candidate(s). A preview: nothing is judged, filed or recorded — pj intake judges them`);
  return L.join('\n');
}

export interface ChannelStatus {
  channel: string;
  connector: string;
  gather: string;
  /** The newest connector event judged, or null when the channel never judged one. */
  cursor: string | null;
  defaultDays: number;
  /** Connector events waiting for the next pass. */
  waiting: number;
  /** Of those, the ones the next pass sends the judge. */
  candidates: number;
  note: string | null;
}

/** Where each channel got to, asked of the kernel: the cursor, and what waits behind it. */
export async function statusOf(root: string, run?: Runner): Promise<{ ok: true; channels: ChannelStatus[] } | { ok: false; reason: string }> {
  const p = await pending(root, { only: channelNames(), limit: 10_000, ...(run ? { run } : {}) });
  if (!p.ok) return p;
  return {
    ok: true,
    channels: p.reports.map((r) => ({
      channel: r.channel,
      connector: r.connector,
      gather: r.gather,
      cursor: r.cursor,
      defaultDays: CHANNELS.find((c) => c.name === r.channel)!.defaultDays,
      waiting: r.read,
      candidates: r.candidates.length,
      note: r.note ?? null,
    })),
  };
}

export function renderStatus(s: Awaited<ReturnType<typeof statusOf>>): string {
  if (!s.ok) return `intake has nothing to read: ${s.reason}`;
  const L = ['channel    judged up to                    waiting  to judge  gathered by'];
  for (const c of s.channels) {
    L.push(
      `${line(c.channel, 10)} ${line(c.cursor ? `${c.cursor} (${ago(c.cursor)})` : `— (${c.defaultDays}-day window)`, 31)} ` +
        `${String(c.waiting).padStart(7)}  ${String(c.candidates).padStart(8)}  ${c.gather}`,
    );
  }
  const notes = s.channels.filter((c) => c.note).map((c) => `${line(c.channel, 10)} ${c.note}`);
  if (notes.length) L.push('', ...notes);
  return L.join('\n');
}

