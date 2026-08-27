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
import { gmailChannel, slackChannel } from './mcp.ts';
import { channelEnabled } from '../settings.ts';
import type { Channel, ChannelReport, IntakeContext } from './types.ts';

/**
 * The sweep: every channel, from where it last got to.
 *
 * Two things are deliberately not here. It **writes no notes** — `pj add` and
 * `pj link` do that, after a human has agreed — and it **does not advance any
 * cursor**. A run that fetched is not a run that was resolved, and a sweep
 * abandoned halfway must not swallow what it had already listed. `pj intake
 * commit` is the separate, explicit step.
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

type VaultRead = Pick<
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
function readVault(root: string): VaultRead {
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

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

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
    const mark = watermarkFor(root, channel.name);
    // `--since` wins, then the watermark, then the channel's own window. The
    // fallback is what makes losing `.intake.db` a wider sweep rather than a
    // broken one.
    const since = opts.since ?? (mark?.cursor ? new Date(mark.cursor) : daysAgo(channel.defaultDays));
    const usable = Number.isFinite(since.getTime()) ? since : daysAgo(channel.defaultDays);

    const report = await collectSafely(channel, {
      ...vault,
      since: usable,
      cursor: mark?.cursor ?? null,
      limit,
    });
    const resolved: ChannelReport = {
      ...withoutSuppressed(report, vault.suppressed),
      // The cursor may only move to a boundary with nothing unexamined behind
      // it. A truncated run has exactly that, so it keeps the old one and the
      // next sweep resumes from the same place.
      nextCursor: report.truncated ? null : report.nextCursor,
    };
    reports.push(resolved);
    // Recorded, not advanced. `pj intake commit --advance` promotes this once the
    // proposal is resolved; until then nothing reads it.
    recordPending(root, channel.name, resolved.nextCursor, seenIn(resolved));
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
 * `pj-capture` carried a paragraph explaining the hand-carry. `captured` is the
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
 * The fetched channels dedupe themselves, but Slack and Gmail are fetched by an
 * agent through MCP — so without this the one channel pair that cannot check
 * would be the one guessing. `pj add --fingerprint` refuses a duplicate anyway;
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
    if (!r.fetched) L.push(`   not fetched by pj: ${r.reason ?? 'no reason given'}`);
    else if (r.reason) L.push(`   ${r.reason}`);

    for (const c of r.candidates) {
      L.push(`   ${line(c.title, 66)}  ${c.fingerprint}`);
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
    `${candidateCount(s)} candidate(s). Nothing is captured and no cursor has moved — ` +
      `create what is worth a note, then: pj intake commit --advance [--captured n]`,
  );
  return L.join('\n');
}

export interface ChannelStatus {
  channel: string;
  /** Null when the channel has never been committed, and the window applies instead. */
  cursor: string | null;
  defaultDays: number;
  ranAt: string | null;
  seen: number;
  captured: number;
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
      ranAt: w?.ranAt ?? null,
      seen: w?.seen ?? 0,
      captured: w?.captured ?? 0,
    };
  });
}

export function renderStatus(root: string): string {
  const L: string[] = ['channel    cursor                          last run          seen  captured'];
  for (const s of statusOf(root)) {
    L.push(
      `${line(s.channel, 10)} ${line(s.cursor ?? `— (default ${s.defaultDays}d window)`, 31)} ` +
        `${line(s.ranAt ? ago(s.ranAt) : 'never', 17)} ${String(s.seen).padStart(4)}  ${String(s.captured).padStart(8)}`,
    );
  }
  return L.join('\n');
}

export { commitWatermark, watermarkFor, watermarks };
