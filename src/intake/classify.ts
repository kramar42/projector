import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config.ts';
import { run } from '../sources/run.ts';
import { settingsFor } from '../settings.ts';
import type { Candidate } from './types.ts';

/**
 * Deciding which candidates deserve a note.
 *
 * This is the one place in projector where a model decides anything, and it is
 * worth being precise about why that does not move C8. C8 governs *signals* —
 * every count and badge the UI draws as fact is computed. Whether a candidate is
 * worth filing was never one of those: it was a judgement, made by whoever ran a
 * sweep, and `src/intake/types.ts` has said so since the channels were written.
 * Moving it into the pipeline changes when and where that judgement runs, not who
 * makes it.
 *
 * What the constraint does forbid is the residue leaking outward. A verdict gates
 * a candidate and its reason is stored as prose on a suppression. It does not
 * become a facet, it is never drawn beside a computed badge, and there is no
 * score — the question here is binary because the queue is a queue and not a
 * ranked list. Adding an ordering later would mean deciding where it may be
 * rendered; not having one costs nothing today.
 *
 * **It fails closed.** If the classifier cannot be reached, the run materialises
 * nothing and holds its cursor rather than falling back to writing everything
 * down. An unjudged queue of your own commits is the failure this whole mechanism
 * exists to prevent, so arriving at it by accident would be worse than an empty
 * board and a line in the log.
 */

export interface Verdict {
  fingerprint: string;
  keep: boolean;
  /** Why, in the model's words. Stored on the suppression when `keep` is false. */
  reason: string;
}

/**
 * The judgement, as instructions.
 *
 * A vault overrides it with `.projector/classify.md` — same argument as project
 * instructions being configuration rather than prose: this is a policy about
 * *this* set of notes, and the person whose queue it is should be able to change
 * it without editing the app.
 *
 * The default encodes one rule above all others, because it is the one that
 * decides whether the queue is usable at all: **a person's own routine progress
 * is not news to them.** Every commit and every coding session on this machine is
 * a candidate, and they were all made deliberately by the person now being asked
 * to read about them.
 */
const DEFAULT_PROMPT = `You decide which candidates deserve a note in someone's personal work tracker.

The tracker exists to answer "what should I pick up next". A candidate earns a note only if reading it later would tell its owner something they would otherwise forget or miss.

KEEP a candidate when:
- someone else is asking for a decision, a reply, or a review
- it is work that has been started and is not finished, with nothing already tracking it
- it records a decision or a problem that will not be obvious from the code later

SUPPRESS a candidate when:
- it is the owner's own routine progress — their commits, their coding sessions, refactors, formatting, test runs. They did it on purpose and do not need telling
- it is mechanical noise: dependency bumps, generated files, merge commits, CI chatter
- something already tracked covers it, which the evidence will say

When genuinely torn, keep it: a note too many costs a glance, and a note too few costs the thing itself.

Each candidate may carry "evidence" — mechanical facts about the vault. "matches" means notes this may be more work on; a strong match usually means suppress, because the work is already tracked.

Reply with ONLY a JSON array, no prose and no code fences:
[{"fp": "<the candidate's fp, verbatim>", "keep": true|false, "reason": "<under 12 words>"}]

Return exactly one object per candidate.`;

function promptFor(root: string): string {
  const file = join(paths(root).config, 'classify.md');
  if (existsSync(file)) {
    const body = readFileSync(file, 'utf8').trim();
    if (body) return body;
  }
  return DEFAULT_PROMPT;
}

/** What the model is shown: enough to judge, and nothing it cannot use. */
function payloadFor(candidates: Candidate[]): string {
  return JSON.stringify(
    candidates.map((c) => ({
      fp: c.fingerprint,
      channel: c.channel,
      title: c.title.slice(0, 300),
      ...(c.detail ? { detail: c.detail.slice(0, 400) } : {}),
      ...(c.evidence?.matches?.length
        ? { matches: c.evidence.matches.map((m) => `${m.id} (${m.why})`) }
        : {}),
    })),
    null,
    0,
  );
}

/** Asks a model and returns its raw text, or null when it could not be reached. */
export type Ask = (system: string, user: string) => Promise<string | null>;

/**
 * The default transport: the Claude CLI, through the same read-only subprocess
 * runner everything else outside the vault goes through.
 *
 * Deliberately stripped. `--system-prompt` replaces the default one,
 * `--disallowedTools` drops the tool definitions, and `--strict-mcp-config` with
 * no config keeps a machine's MCP servers out of it. What is left is a
 * classification, not an agent, which is both the cheaper thing and the more
 * predictable one — a classifier that could read files would eventually do it.
 */
const NO_TOOLS =
  'Bash Read Write Edit Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit BashOutput KillShell SlashCommand Skill';

export function claudeAsk(command: string, model: string): Ask {
  return async (system, user) => {
    const res = await run(
      command,
      [
        '-p',
        user,
        '--system-prompt',
        system,
        '--model',
        model,
        '--strict-mcp-config',
        '--disallowedTools',
        NO_TOOLS,
        '--output-format',
        'json',
      ],
      { timeoutMs: 120_000 },
    );
    if (!res.ok) return null;
    try {
      const env = JSON.parse(res.stdout) as { result?: unknown; is_error?: boolean };
      if (env.is_error) return null;
      return typeof env.result === 'string' ? env.result : null;
    } catch {
      return null;
    }
  };
}

/**
 * Pull the JSON array out of a reply.
 *
 * Models fence JSON however the mood takes them, and a classifier that failed
 * because of three backticks would fail closed — holding the whole sweep over
 * punctuation. So the first balanced array in the text wins.
 */
function parseVerdicts(text: string): Verdict[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(raw)) return null;
    const out: Verdict[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const fp = typeof r.fp === 'string' ? r.fp : null;
      if (!fp) continue;
      out.push({
        fingerprint: fp,
        keep: r.keep !== false,
        reason: (typeof r.reason === 'string' ? r.reason : '').slice(0, 200) || 'no reason given',
      });
    }
    return out;
  } catch {
    return null;
  }
}

export interface Classified {
  keep: Candidate[];
  /** Candidates to record as declined, with the reason to record. */
  drop: { candidate: Candidate; reason: string }[];
}

/**
 * Judge a run's candidates in one call.
 *
 * One call rather than one per candidate, which is not only cheaper: a sweep's
 * candidates arrive together and are frequently *one thing* — an afternoon's
 * commits on a branch — and a model shown all of them can say so, where a model
 * shown each in isolation cannot.
 *
 * Returns null when the classifier could not be reached at all. A candidate the
 * model simply failed to mention is **kept**, which is the safe direction of the
 * two: the cost of keeping is a glance, and the cost of dropping is the item.
 */
export async function classify(
  root: string,
  candidates: Candidate[],
  ask: Ask = defaultAsk(root),
): Promise<Classified | null> {
  if (!candidates.length) return { keep: [], drop: [] };

  const text = await ask(promptFor(root), payloadFor(candidates));
  if (text === null) return null;
  const verdicts = parseVerdicts(text);
  if (!verdicts) return null;

  const byFp = new Map(verdicts.map((v) => [v.fingerprint, v]));
  const out: Classified = { keep: [], drop: [] };
  for (const c of candidates) {
    const v = byFp.get(c.fingerprint);
    if (v && !v.keep) out.drop.push({ candidate: c, reason: v.reason });
    else out.keep.push(c);
  }
  return out;
}

export function defaultAsk(root: string): Ask {
  const { classify: cfg } = settingsFor(root);
  return claudeAsk(cfg.command, cfg.model);
}
