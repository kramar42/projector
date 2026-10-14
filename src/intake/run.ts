import { reindex } from '../index/indexer.ts';
import { ago } from '../sources/run.ts';
import { claudeChannel } from './claude.ts';
import {
  commitWatermark,
  recordPending,
  suppressedFingerprints,
  watermarkFor,
  watermarks,
} from './db.ts';
import { gitChannel } from './git.ts';
import { jiraChannel } from './jira.ts';
import { slackChannel } from './mcp.ts';
import { gmailChannel } from './gmail.ts';
import { channelEnabled } from '../settings.ts';
import { renderCost } from './relay.ts';
import type { Watermark } from './db.ts';
import type { Channel, ChannelReport, IntakeContext } from './types.ts';

/**
 * The sweep: every channel, from where it last got to.
 *
 * Two things are deliberately not here. It **writes no notes** — a tick
 * (`pollOnce`, behind both the timer and `pj intake`) files what it judged worth
 * a card — and it **does not advance any cursor**. A run that fetched is not a
 * run that was resolved, and a sweep abandoned halfway must not swallow what it
 * had already listed. The tick advances a channel once it is resolved;
 * `pj intake advance` promotes a `--dry-run` preview resolved by hand.
 */

export const CHANNELS: Channel[] = [
  claudeChannel,
  gitChannel,
  jiraChannel,
  slackChannel,
  gmailChannel,
];

export function channelNames(): string[] {
  return CHANNELS.map((c) => c.name);
}

export const DEFAULT_LIMIT = 25;

export type VaultRead = Pick<
  IntakeContext,
  'root' | 'db' | 'notes' | 'fingerprints' | 'links' | 'suppressed'
>;

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

export interface SweepOptions {
  /**
   * Channel names to run. Empty means the ones this vault has turned on.
   *
   * Naming a channel explicitly runs it whether or not the vault lists it: the
   * config says what a bare `pj intake` should bother with, and asking for one
   * by name is not a bare sweep. Otherwise `pj intake jira` would print nothing
   * and give no reason.
   */
  only?: string[];
  /** Overrides every channel's watermark and default window. */
  since?: Date;
  limit?: number;
}

export interface Sweep {
  reports: ChannelReport[];
  /** Channel names asked for that do not exist. */
  unknown: string[];
}

const daysAgo = (n: number, now = Date.now()) => new Date(now - n * 86_400_000);

/** Where one channel's run starts reading, and what it steps over to get there. */
export interface Start {
  since: Date;
  /** The cursor the channel is handed: the stored one, or the window's start when that was skipped to. */
  cursor: string | null;
  skip?: NonNullable<ChannelReport['skippedSpan']>;
}

/**
 * `--since` wins, then the watermark, then the channel's own window — and the
 * window also bounds the watermark.
 *
 * The fallback is what makes losing `.intake.db` a wider sweep rather than a
 * broken one. The bound is deliberate: **intake is for current asks.** A cursor
 * older than the window — held for weeks by a run that could not finish, or a
 * machine that was off — would otherwise be followed back a page a tick through
 * asks that have since been settled, or asked again in a newer message, which
 * the window still reads. So the run starts at the window instead, and the
 * channel is handed that start as its cursor too: everything a channel does
 * relative to its cursor (what counts as new, where a hold resumes, whether the
 * boundary moved) then works from where reading actually began. What it stepped
 * over is returned as `skip`, to be recorded rather than lost.
 *
 * A skip that only extends the last recorded one — the cursor still sits where
 * that skip left it, because nothing newer has arrived since — keeps the old
 * span's start and is marked `continued`: a quiet channel would otherwise
 * announce a fresh hour-long "gap" every tick, each of which the previous tick
 * had in fact read.
 */
export function startOf(
  channel: Pick<Channel, 'defaultDays'>,
  mark: Pick<Watermark, 'cursor' | 'skipped'> | null,
  since?: Date,
  now = Date.now(),
): Start {
  const window = daysAgo(channel.defaultDays, now);
  const cursor = mark?.cursor ?? null;
  if (since) return { since: Number.isFinite(since.getTime()) ? since : window, cursor };
  const at = cursor ? Date.parse(cursor) : NaN;
  // No cursor, or one that is not a date (a Slack ts typed in by hand): the
  // window, as it always was.
  if (!Number.isFinite(at)) return { since: window, cursor };
  if (at >= window.getTime()) return { since: new Date(at), cursor };

  const start = window.toISOString();
  const prior = mark?.skipped;
  const continued = !!prior && at <= Date.parse(prior.to);
  return {
    since: window,
    cursor: start,
    skip: {
      from: continued ? prior!.from : cursor!,
      to: start,
      days: channel.defaultDays,
      ...(continued ? { continued: true } : {}),
    },
  };
}

export async function sweep(root: string, opts: SweepOptions = {}): Promise<Sweep> {
  const wanted = opts.only?.length
    ? opts.only
    : channelNames().filter((n) => channelEnabled(root, n));
  const unknown = wanted.filter((w) => !CHANNELS.some((c) => c.name === w));
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const reports: ChannelReport[] = [];
  const vault = readVault(root);

  for (const channel of CHANNELS) {
    if (!wanted.includes(channel.name)) continue;
    const start = startOf(channel, watermarkFor(root, channel.name), opts.since);

    const report = await collectSafely(channel, {
      ...vault,
      since: start.since,
      cursor: start.cursor,
      limit,
    });
    // A channel that could not be reached read nothing, so it stepped over
    // nothing either: its cursor stays, and the next run decides again.
    const skip = report.fetched ? start.skip : undefined;
    const resolved: ChannelReport = {
      ...withoutSuppressed(report, vault.suppressed),
      // The cursor may only move to a boundary with nothing unexamined behind
      // it. A truncated run has exactly that, so it keeps the old one and the
      // next sweep resumes from the same place — which, after a skip, is the
      // window's start: holding at the old cursor would undo the skip. A run
      // that found nothing newer moves there too, for the same reason.
      nextCursor: skip
        ? report.truncated
          ? start.cursor
          : (report.nextCursor ?? start.cursor)
        : report.truncated
          ? null
          : report.nextCursor,
      ...(skip ? { skippedSpan: skip } : {}),
    };
    reports.push(resolved);
    // Recorded, not advanced. `pj intake advance` promotes this — the skip with
    // the cursor — once the proposal is resolved; until then nothing reads it.
    recordPending(
      root,
      channel.name,
      resolved.nextCursor,
      seenIn(resolved),
      skip ? { from: skip.from, to: skip.to } : undefined,
    );
  }
  return { reports, unknown };
}

/**
 * One channel failing is that channel's news, not the sweep's.
 *
 * A thrown `collect` used to take the whole run with it: a lapsed Jira token
 * meant no git candidates either, and the reason surfaced as a stack trace rather
 * than against the channel that caused it. `fetched: false` with a `reason` is
 * the shape the report already had for "pj cannot reach this" — Slack and Gmail
 * report it every run — so a failure lands there instead of inventing a second
 * way to say the same thing.
 *
 * It matters more once a poller is running unattended, where nobody is reading a
 * stack trace and one expired credential would otherwise stop everything.
 */
async function collectSafely(channel: Channel, ctx: IntakeContext): Promise<ChannelReport> {
  try {
    return await channel.collect(ctx);
  } catch (e) {
    return {
      channel: channel.name,
      cursor: ctx.cursor,
      // Nothing was examined, so there is no boundary to move to. Holding the
      // cursor is what makes the next run pick the window back up.
      nextCursor: null,
      fetched: false,
      reason: e instanceof Error ? e.message : String(e),
      candidates: [],
      skipped: [],
    };
  }
}

/**
 * Move already-judged candidates out of the proposal and into the declined list.
 *
 * Central rather than per-channel: every channel would need the same three lines,
 * and a channel that forgot them would quietly re-offer work its reader has
 * already said no to — the failure this whole table exists to stop.
 *
 * They become `skipped` rather than disappearing, so `seenIn` still counts them
 * and `--verbose` still names them. A sweep that silently dropped a third of what
 * it fetched would read as a quiet channel, which is the one reading that must not
 * be available.
 */
function withoutSuppressed(r: ChannelReport, suppressed: Set<string>): ChannelReport {
  if (!suppressed.size) return r;
  const kept: ChannelReport['candidates'] = [];
  const declined = [...r.skipped];
  for (const c of r.candidates) {
    if (suppressed.has(c.fingerprint)) {
      declined.push({ fingerprint: c.fingerprint, title: c.title, why: 'suppressed earlier' });
    } else {
      kept.push(c);
    }
  }
  return { ...r, candidates: kept, skipped: declined };
}

/** What the run examined: everything it proposed, plus everything it declined. */
function seenIn(r: ChannelReport): number {
  return r.candidates.length + r.skipped.length;
}

export interface Advanced {
  channel: string;
  /** Null when the proposal was to hold — a truncated run, or a run that fetched nothing. */
  cursor: string | null;
  seen: number;
  captured: number;
  /** When the sweep that proposed this ran. */
  proposedAt: string;
}

/**
 * Promote what the last sweep proposed.
 *
 * The counts and the cursor were both `pj`'s to begin with — the agent was
 * copying them out of one process and typing them into the next, and
 * the capture skill carried a paragraph explaining the hand-carry. `captured` is the
 * exception and stays a caller's argument: capture happens between the sweep and
 * this call, through `pj add` and `pj link`, and nothing attributes those back to
 * a channel.
 */
export function advance(
  root: string,
  opts: { channel?: string; captured?: number } = {},
): { moved: Advanced[]; withoutPending: string[] } {
  const marks = watermarks(root);
  const wanted = opts.channel ? marks.filter((w) => w.channel === opts.channel) : marks;
  const moved: Advanced[] = [];
  for (const w of wanted) {
    if (!w.pending) continue;
    const after = commitWatermark(root, w.channel, w.pending.cursor, {
      seen: w.pending.seen,
      captured: opts.captured ?? 0,
      ...(w.pending.skipped ? { skipped: w.pending.skipped } : {}),
    });
    moved.push({
      channel: w.channel,
      cursor: w.pending.cursor,
      seen: after.seen,
      captured: after.captured,
      proposedAt: w.pending.at,
    });
  }
  const names = opts.channel ? [opts.channel] : channelNames();
  return { moved, withoutPending: names.filter((n) => !moved.some((m) => m.channel === n)) };
}

export function renderAdvance(a: { moved: Advanced[]; withoutPending: string[] }): string {
  const L: string[] = [];
  for (const m of a.moved) {
    const when = ago(m.proposedAt) || 'just now';
    L.push(
      `${line(m.channel, 10)} ${m.cursor ? `cursor → ${m.cursor}` : 'cursor held (nothing new, or truncated)'}` +
        `  · seen ${m.seen}, captured ${m.captured}  (proposed ${when})`,
    );
  }
  if (a.withoutPending.length) {
    L.push(`no sweep to promote for: ${a.withoutPending.join(', ')}`);
  }
  return L.join('\n');
}

/**
 * Which notes already carry each of these fingerprints or links.
 *
 * The direct fetchers dedupe themselves, while an agent-fetched channel may not
 * be able to check. `pj add --fingerprint` refuses a duplicate anyway;
 * this is what lets a proposal be honest before it gets that far.
 */
export function known(root: string, refs: string[]): { ref: string; cards: string[] }[] {
  const vault = readVault(root);
  return refs.map((ref) => ({
    ref,
    cards: [...new Set([...(vault.fingerprints.get(ref) ?? []), ...(vault.links.get(ref) ?? [])])],
  }));
}

/** Total candidates across a sweep, which is what "anything to look at" means. */
export function candidateCount(s: Sweep): number {
  return s.reports.reduce((n, r) => n + r.candidates.length, 0);
}

function line(s: string, width: number): string {
  return s.length > width ? s.slice(0, width - 1) + '…' : s.padEnd(width);
}

export function renderSweep(s: Sweep, opts: { verbose?: boolean } = {}): string {
  const L: string[] = [];

  for (const r of s.reports) {
    // A cursor is opaque: `ago` reads the ISO ones, and a Slack ts prints as
    // itself rather than as an empty "since".
    const from = r.cursor ? `since ${ago(r.cursor) || r.cursor}` : 'no watermark — default window';
    L.push(`## ${r.channel}  (${from})`);
    if (r.skippedSpan) L.push(`   ${skippedLine(r.skippedSpan)}`);
    if (!r.fetched) L.push(`   not fetched by pj: ${r.reason ?? 'no reason given'}`);
    else if (r.reason) L.push(`   ${r.reason}`);

    for (const c of r.candidates) {
      const mark = c.evidence?.linkedTo?.length ? 'update ' : '';
      L.push(`   ${mark}${line(c.title, mark ? 59 : 66)}  ${c.fingerprint}`);
      if (c.detail) L.push(`      ${c.detail}`);
      const ev = c.evidence;
      if (ev?.matches?.length) {
        L.push(`      may belong to: ${ev.matches.map((m) => `${m.id} (${m.why})`).join(', ')}`);
      }
      if (opts.verbose && c.fields?.length) {
        L.push(`      ${c.fields.map((f) => `${f.k}=${f.v}`).join('  ')}`);
      }
    }
    if (!r.candidates.length && r.fetched) L.push('   nothing new');

    const tail: string[] = [];
    if (r.skipped.length) tail.push(`${r.skipped.length} skipped`);
    if (r.truncated) tail.push('truncated — cursor held, more behind it');
    if (r.nextCursor) tail.push(`cursor would move to ${r.nextCursor}`);
    if (r.cost) tail.push(`fetch ${renderCost(r.cost)}`);
    if (tail.length) L.push(`   (${tail.join('; ')})`);

    if (opts.verbose) {
      for (const sk of r.skipped) L.push(`      − ${line(sk.title, 60)}  ${sk.why}`);
    }
    L.push('');
  }

  if (s.unknown.length) {
    L.push(`unknown channel(s): ${s.unknown.join(', ')} — have ${channelNames().join(', ')}`);
  }
  L.push(
    `${candidateCount(s)} candidate(s). A preview: nothing is filed and no cursor has moved — ` +
      `pj intake files them into inbox/`,
  );
  return L.join('\n');
}

/**
 * A skipped span as one phrase, shared by the tick's channel line, the preview
 * and `pj intake status`, so all three say it the same way. Day-granular: the
 * span is weeks or days, and the exact second is in `--json`.
 */
export function skippedLine(s: { from: string; to: string; days?: number }): string {
  const day = (v: string) => (Number.isFinite(Date.parse(v)) ? new Date(v).toISOString().slice(0, 10) : v);
  return `skipped ${day(s.from)} → ${day(s.to)}: older than the ${s.days ?? '?'}-day window`;
}

export interface ChannelStatus {
  channel: string;
  /** Null when the channel has never been committed, and the window applies instead. */
  cursor: string | null;
  defaultDays: number;
  ranAt: string | null;
  seen: number;
  captured: number;
  /**
   * True when the cursor is older than the channel's window, so the next run
   * reads from the window's start and records the span it steps over. False
   * while the cursor still sits where the last skip left it: that span only
   * grows, and `skipped` already says so.
   */
  stale: boolean;
  /** The last span a run stepped over rather than read, and when; null when none ever was. */
  skipped: { from: string; to: string; at: string } | null;
}

/**
 * Where each channel got to.
 *
 * Separate from `renderStatus` because a skill reads this to find the cursor it
 * must fetch from, and it was reading it out of a padded table: `--json` was
 * accepted on `pj intake status` and silently ignored, so an agent scraped
 * fixed-width columns for a value it needed exactly right.
 */
export function statusOf(root: string): ChannelStatus[] {
  const marks = new Map(watermarks(root).map((w) => [w.channel, w]));
  return CHANNELS.map((c) => {
    const w = marks.get(c.name);
    return {
      channel: c.name,
      cursor: w?.cursor ?? null,
      defaultDays: c.defaultDays,
      // Empty when only a preview has touched the channel: never run.
      ranAt: w?.ranAt || null,
      seen: w?.seen ?? 0,
      captured: w?.captured ?? 0,
      // Derived on every read rather than stored (C11): it is the same test
      // `sweep` makes, against the same clock. A skip that would only extend the
      // recorded one is not a new gap, so it is not news here either.
      stale: (() => {
        const skip = startOf(c, w ?? null).skip;
        return !!skip && !skip.continued;
      })(),
      skipped: w?.skipped ?? null,
    };
  });
}

export function renderStatus(root: string): string {
  const all = statusOf(root);
  const L: string[] = ['channel    cursor                          last run          seen  captured'];
  for (const s of all) {
    L.push(
      `${line(s.channel, 10)} ${line(s.cursor ?? `— (default ${s.defaultDays}d window)`, 31)} ` +
        `${line(s.ranAt ? ago(s.ranAt) : 'never', 17)} ${String(s.seen).padStart(4)}  ${String(s.captured).padStart(8)}`,
    );
  }
  // Under the table rather than in it: a column for a rare event would be a
  // column of dashes, and the sentence needs the room.
  const notes: string[] = [];
  for (const s of all) {
    if (s.stale) {
      const from = daysAgo(s.defaultDays).toISOString().slice(0, 10);
      notes.push(
        `${line(s.channel, 10)} cursor older than the ${s.defaultDays}-day window — ` +
          `the next tick reads from ${from} and records the span it skips`,
      );
    }
    if (s.skipped) {
      notes.push(`${line(s.channel, 10)} ${skippedLine({ ...s.skipped, days: s.defaultDays })} (${ago(s.skipped.at) || 'just now'})`);
    }
  }
  if (notes.length) L.push('', ...notes);
  return L.join('\n');
}

export { commitWatermark, watermarkFor, watermarks };
