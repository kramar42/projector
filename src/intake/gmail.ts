import { evidenceFor } from './match.ts';
import { gmailMcpChannel } from './mcp.ts';
import { run } from '../sources/run.ts';
import { settingsFor } from '../settings.ts';
import type { Candidate, Channel, ChannelReport, IntakeContext } from './types.ts';

/**
 * Gmail: through gogcli when a vault chose that, through the MCP relay otherwise.
 *
 * gogcli owns OAuth and emits JSON. Projector invokes it with both of its
 * runtime write guards, then gives the factual thread records to the same local
 * classifier as every other channel. It is the deterministic transport — but it
 * needs a Google OAuth client registered for the account, which is a real cost
 * for one read-only search a day, and a vault that has already named Gmail MCP
 * tools has said how it wants this fetched. So `gmail.transport` decides, and
 * its default follows the tools: named means `mcp`, unnamed means `gog`.
 * Neither is tried as a fallback for the other any more; a transport that fails
 * says so, rather than a second one quietly answering in its place.
 */

interface GogMessage {
  subject?: unknown;
  from?: unknown;
  date?: unknown;
  snippet?: unknown;
  body?: unknown;
}

interface GogThread extends GogMessage {
  id?: unknown;
  threadId?: unknown;
  messages?: unknown;
}

export interface GmailThread {
  id: string;
  title: string;
  detail: string;
  when?: string;
}

const text = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v.trim() : '').slice(0, max);

const iso = (v: unknown): string | undefined => {
  const raw = text(v, 100);
  const at = Date.parse(raw);
  return raw && Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};

/** Normalize gog's envelope while tolerating its older bare-array output. */
export function parseGogSearch(stdout: string): GmailThread[] | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { threads?: unknown }).threads)
        ? (parsed as { threads: unknown[] }).threads
        : null;
    if (!rows) return null;

    const out: GmailThread[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const thread = raw as GogThread;
      const messages = Array.isArray(thread.messages)
        ? thread.messages.filter((m): m is GogMessage => Boolean(m) && typeof m === 'object')
        : [];
      const last = messages.at(-1);
      const id = text(thread.id, 200) || text(thread.threadId, 200);
      if (!id) continue;
      const subject = text(thread.subject, 300) || text(last?.subject, 300) || id;
      const from = text(thread.from, 200) || text(last?.from, 200);
      const snippet =
        text(thread.snippet, 500) ||
        text(last?.snippet, 500) ||
        text(last?.body, 500).replace(/\s+/g, ' ');
      const when = iso(thread.date) ?? iso(last?.date);
      out.push({
        id,
        title: subject,
        detail: [from, snippet].filter(Boolean).join(' — ').slice(0, 600),
        ...(when ? { when } : {}),
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** Exported so the read-only boundary is pinned without invoking Gmail in tests. */
export function gogSearchArgs(ctx: IntakeContext, account: string | null): string[] {
  const after = Math.floor(ctx.since.getTime() / 1000);
  return [
    '--readonly',
    '--gmail-no-send',
    '--no-input',
    '--json',
    ...(account ? ['--account', account] : []),
    'gmail',
    'search',
    `in:inbox after:${after}`,
    // Search is newest-first. Fetch the whole bounded time window, then sort it
    // locally; taking only the first page could move a cursor past older mail.
    '--all',
  ];
}

function held(ctx: IntakeContext, reason: string): ChannelReport {
  return {
    channel: 'gmail',
    cursor: ctx.cursor,
    nextCursor: null,
    fetched: false,
    reason,
    candidates: [],
    skipped: [],
  };
}

export const gmailChannel: Channel = {
  name: 'gmail',
  defaultDays: 14,
  async collect(ctx): Promise<ChannelReport> {
    const cfg = settingsFor(ctx.root);
    if (cfg.gmail.transport === 'mcp') return gmailMcpChannel.collect(ctx);
    const result = await run(cfg.gmail.command, gogSearchArgs(ctx, cfg.gmail.account), {
      timeoutMs: 120_000,
    });
    if (!result.ok) {
      return held(
        ctx,
        `gog could not read Gmail: ${result.stderr.slice(0, 200) || 'install and authorize gogcli'}` +
          (cfg.mcp.gmail.length ? ' — or set gmail.transport: mcp to use the named MCP tools instead' : ''),
      );
    }

    const threads = parseGogSearch(result.stdout);
    if (!threads) return held(ctx, "gog's Gmail answer could not be read");

    // `gog gmail url` is a local formatter. Batch it so the search still makes
    // one Google API request, and keep the no-link fallback honest if it fails.
    const urlResult = threads.length
      ? await run(
          cfg.gmail.command,
          [
            '--readonly',
            '--gmail-no-send',
            '--no-input',
            '--plain',
            ...(cfg.gmail.account ? ['--account', cfg.gmail.account] : []),
            'gmail',
            'url',
            ...threads.map((t) => t.id),
          ],
          { timeoutMs: 15_000 },
        )
      : null;
    const urls = (urlResult?.ok ? urlResult.stdout : '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^https:\/\/mail\.google\.com\//.test(line));
    const urlById = new Map(threads.map((thread, index) => [thread.id, urls[index]]));

    const candidates: Candidate[] = [];
    let newest = ctx.cursor;
    for (const thread of threads
      .slice()
      .sort((a, b) => (a.when ?? '').localeCompare(b.when ?? ''))) {
      const fingerprint = `gmail:${thread.id}`;
      const url = urlById.get(thread.id);
      const links = url ? [url] : [];
      if (ctx.fingerprints.has(fingerprint) || links.some((link) => ctx.links.has(link))) continue;
      if (thread.when && (!newest || thread.when > newest)) newest = thread.when;
      candidates.push({
        channel: 'gmail',
        fingerprint,
        title: thread.title,
        links,
        ...(thread.when ? { when: thread.when } : {}),
        ...(thread.detail ? { detail: thread.detail } : {}),
        evidence: evidenceFor(ctx, {
          fingerprint,
          links,
          text: [thread.title, thread.detail].filter(Boolean).join(' — '),
        }),
      });
    }

    return {
      channel: 'gmail',
      cursor: ctx.cursor,
      nextCursor: newest === ctx.cursor ? null : newest,
      fetched: true,
      candidates,
      skipped: [],
    };
  },
};
