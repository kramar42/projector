import { reindex } from '../index/indexer.ts';
import { ago } from '../sources/run.ts';
import { claudeChannel } from './claude.ts';
import { commitWatermark, watermarkFor, watermarks } from './db.ts';
import { gitChannel } from './git.ts';
import { jiraChannel } from './jira.ts';
import { gmailChannel, slackChannel } from './mcp.ts';
import type { Channel, ChannelReport, IntakeContext } from './types.ts';

/**
 * The sweep: every channel, from where it last got to.
 *
 * Two things are deliberately not here. It **writes no cards** — `ck add` and
 * `ck link` do that, after a human has agreed — and it **does not advance any
 * cursor**. A run that fetched is not a run that was resolved, and a sweep
 * abandoned halfway must not swallow what it had already listed. `ck intake
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

type VaultRead = Pick<IntakeContext, 'root' | 'db' | 'records' | 'fingerprints' | 'links'>;

/**
 * The vault, read once for all channels.
 *
 * The index rebuild is ~37ms and every channel wants the same three things out of
 * it — which fingerprints exist, which links exist, and the full-text index — so
 * paying for it per channel would be paying three times for one answer.
 */
function readVault(root: string): VaultRead {
  const { db, records } = reindex(root);
  const fingerprints = new Map<string, string[]>();
  const links = new Map<string, string[]>();

  for (const rec of records.values()) {
    if (rec.source_fingerprint) {
      fingerprints.set(rec.source_fingerprint, [...(fingerprints.get(rec.source_fingerprint) ?? []), rec.id]);
    }
    for (const l of rec.links) {
      links.set(l.raw, [...(links.get(l.raw) ?? []), rec.id]);
    }
  }
  return { root, db, records, fingerprints, links };
}

export interface SweepOptions {
  /** Channel names to run. Empty means all of them. */
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
  const wanted = opts.only?.length ? opts.only : channelNames();
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

    const report = await channel.collect({ ...vault, since: usable, cursor: mark?.cursor ?? null, limit });
    reports.push({
      ...report,
      // The cursor may only move to a boundary with nothing unexamined behind
      // it. A truncated run has exactly that, so it keeps the old one and the
      // next sweep resumes from the same place.
      nextCursor: report.truncated ? null : report.nextCursor,
    });
  }
  return { reports, unknown };
}

/**
 * Which cards already carry each of these fingerprints or links.
 *
 * The fetched channels dedupe themselves, but Slack and Gmail are fetched by an
 * agent through MCP — so without this the one channel pair that cannot check
 * would be the one guessing. `ck add --fingerprint` refuses a duplicate anyway;
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
    if (!r.fetched) L.push(`   not fetched by ck: ${r.note ?? 'no reason given'}`);
    else if (r.note) L.push(`   ${r.note}`);

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
      `create what is worth a card, then: ck intake commit --channel <c> --cursor <v>`,
  );
  return L.join('\n');
}

export function renderStatus(root: string): string {
  const marks = new Map(watermarks(root).map((w) => [w.channel, w]));
  const L: string[] = ['channel    cursor                          last run          seen  captured'];
  for (const c of CHANNELS) {
    const w = marks.get(c.name);
    L.push(
      `${line(c.name, 10)} ${line(w?.cursor ?? `— (default ${c.defaultDays}d window)`, 31)} ` +
        `${line(w ? ago(w.ranAt) : 'never', 17)} ${String(w?.seen ?? 0).padStart(4)}  ${String(w?.captured ?? 0).padStart(8)}`,
    );
  }
  return L.join('\n');
}

export { commitWatermark, watermarkFor, watermarks };
