import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config.ts';
import { isRef, loadFacets } from '../schema/facets.ts';
import { reindex } from '../index/indexer.ts';
import { run } from '../sources/run.ts';
import { rescues, suppressions } from './db.ts';
import { settingsFor } from '../settings.ts';
import type { Facets, Note } from '../schema/types.ts';
import { addCost, costFromEnvelope } from './relay.ts';
import type { Candidate, Cost } from './types.ts';

/**
 * What a candidate is, and whether it deserves a note.
 *
 * One pass, two answers, and merging them is the design rather than a shortcut.
 * The model has to read the candidate to judge it; having read it, it can also
 * say what the note should be called, what it is about, and which axes it sits
 * on. Asking only *keep or drop* wasted the call and produced cards nobody wanted
 * — a commit subject for a title, a provenance string for a body, one facet.
 *
 * **This is the one place a model decides anything, and C8 does not move.** C8
 * governs *signals*: every count and badge the UI draws as fact is computed.
 * Whether a candidate deserves a note, and what to call it, were never signals —
 * they are judgements, made until now by whoever ran a sweep, which
 * `src/intake/types.ts` has said since the channels were written. What changes is
 * when and where the judgement runs, not who makes it.
 *
 * What the constraint does forbid is the residue leaking outward, and two rules
 * hold it in. A verdict gates a candidate and its reason is stored as prose on a
 * suppression — never a facet, never a badge, and there is no score, because the
 * queue is a queue and not a ranked list. And:
 *
 * **The model proposes, the vocabulary disposes.** Every facet name, every value
 * and every merge target is checked against the vault before anything is written.
 * An invented value is dropped; an invented target demotes the verdict to `keep`.
 * A model cannot widen a vault's vocabulary, cannot set `intake` or `extends`
 * itself, and cannot name a note that does not exist. So what reaches a file is
 * the model's *proposal expressed in the vault's own terms* — which is exactly
 * what `intake: unjudged` then means: nothing here has been confirmed by a human.
 *
 * **It fails closed.** If the classifier cannot be reached or cannot be parsed,
 * the run writes nothing and holds its cursor. An unjudged pile of your own
 * commits is the failure this exists to prevent, so arriving at it by accident
 * would be worse than an empty board and a line in the log.
 *
 * **A tracked candidate can only extend or drop.** `evidence.linkedTo` is the
 * mechanical fact that the vault already has a note for this — the same thread,
 * the same issue — and that fact outranks the verdict's spelling: `keep` on a
 * tracked candidate becomes `extend` onto the note that tracks it, because a
 * second note about the same work is the duplicate the tracking exists to
 * prevent. The model is shown the tracked note as it stands, so what it proposes
 * is a delta — the axes that should change, and what changed — which the fold
 * dialog then asks about, one row per axis.
 */

export type Decision = 'keep' | 'extend' | 'drop';

export interface Verdict {
  fingerprint: string;
  decision: Decision;
  /** Why, in the model's words. Stored on the suppression when dropped. */
  reason: string;
  /** A real title, not the raw commit subject or opening prompt. */
  title?: string;
  /** A sentence or three: what this is, and what is unfinished about it. */
  body?: string;
  /** Proposed axis values, already validated against the vocabulary. */
  facets?: Record<string, string[]>;
  /** For `extend`: the note this belongs to. Always one of the evidence matches. */
  target?: string;
  /**
   * Worth interrupting for, which is a different question from worth filing.
   *
   * A note is something you find when you look; an interruption is something you
   * cannot decline. So "deserves a note" is the wrong bar for it, and this is a
   * second, higher one rather than a re-reading of the first.
   */
  notify?: boolean;
}

const DEFAULT_PROMPT = `You triage candidates for someone's personal work tracker, and you do two jobs at once: decide whether each deserves a note, and if it does, write the note.

# Job one: does it deserve a note?

The tracker answers "what should I pick up next". A candidate earns a note only if reading it later tells its owner something they would otherwise forget or miss.

- "keep" — someone else is asking for a decision, a reply or a review; or it is unfinished work with nothing already tracking it; or it records a problem or decision that will not be obvious from the code later.
- "extend" — it is more of something already tracked. The candidate's "matches" name the notes it might belong to; pick one as "target". Use this whenever a match is clearly the same piece of work.
- "drop" — the owner's own routine progress: their commits, their coding sessions, refactors, formatting, test runs. They did it on purpose and do not need telling. Also mechanical noise: dependency bumps, generated files, merge commits, CI chatter.

A candidate whose context carries a "conversation" shows the whole exchange, oldest first, with the owner's own lines marked "you". Read it to the end before deciding. If the owner already answered and nothing is left open, drop it: the answer was the resolution. If the owner promised something ("will do", "I'll send it"), keep it and say what they owe. Greetings, thanks, acknowledgements, reactions and scheduling chatter are drop.

When genuinely torn between keep and drop, keep: a note too many costs a glance, a note too few costs the thing itself.

# Tracked items

A candidate carrying "tracked" is about something the tracker already has a note for, and "tracked" shows that note as it stands. It is not new work; it is news about tracked work. Decide only between:

- "extend" — the news changes what the note should say: the question was answered, the issue moved to done or blocked, a deadline appeared, somebody is now waiting, a new ask arrived on the same thread. "target" is the tracked note's id. In "facets" propose only the axes that should change, with their new value, and leave the rest out. "title" names the change and "body" says what changed, in one or two sentences.
- "drop" — nothing about the work changed: chatter, a comment that asks nothing, a field edit.

Never "keep" a tracked item. A second note about the same work is the mistake this exists to prevent.

# Job two: write the note

For "keep" and "extend", fill these in. This is most of the value — a card nobody can read is not worth having.

- "title" — what a person would call this in conversation. Not a commit subject, not a raw prompt, not a file path. No ticket key prefix, no "feat(x):". Under 70 characters, no trailing full stop.
- "body" — one to three sentences: what this is, where it got to, and what is unresolved. Say what the raw material actually tells you and nothing you cannot see. No headings, no bullet lists, no restating the title.
- "facets" — the axes below, with values from their own vocabulary. Only axes you have real grounds for; guessing every axis is worse than leaving one out. An axis marked single takes one value.

Never reproduce a secret. When the raw material contains a token, an API key, a password or a private key, the note says what the credential is for and that the value was withheld — the value itself appears in no title and no body. A note about a credential is about rotating or replacing it, never a place to keep it.

# Job three: does it need to interrupt?

Set "notify": true only for something the owner would want to be told about now rather than find later — someone blocked on them, a deadline inside a day or two, a production problem, a direct question that has been waiting. This is a *higher* bar than deserving a note, and most things that deserve a note do not clear it. Default to false; a notification nobody wanted is how people turn notifications off.

# Output

ONLY a JSON array, no prose and no code fences. One object per candidate, every "fp" verbatim:

[{"fp":"…","decision":"keep"|"extend"|"drop","reason":"<under 12 words>","title":"…","body":"…","facets":{"axis":["value"]},"target":"<note id, extend only>","notify":false}]`;

/**
 * The judgements already made, as examples.
 *
 * Three kinds, and they are not equal. A **rescue** is a decline somebody took
 * back, which is the only signal that says the judgement was wrong in the
 * expensive direction — so it leads, and it is the one the instruction points at.
 * A **decline** confirms the reader agreed. A **kept** note shows what surviving
 * looks like in this vault's own words.
 *
 * **A discarded note is not a decline of the offer that produced it**, so the
 * declines here are `wasJudged: false` — offers turned down, whoever turned them
 * down. Deleting a note you accepted and worked on says the work is finished
 * with; taught as a no, it reads as *you should not have shown me this*, and what
 * a model learns from it is to withhold the kind of thing you keep for a month
 * and then let go. Both still suppress. See `was_judged` in `db.ts`.
 *
 * Two mistakes not inherited from the tool this idea came from. The order is
 * fixed rather than shuffled, so the prompt is the same prompt run to run and a
 * zero temperature buys what it is supposed to. And nothing is stamped with a
 * synthetic score, because a score teaches a model buckets it will then reach for.
 */
function calibrationFor(root: string, notes: Map<string, Note>): string {
  const back = rescues(root, 8);
  const no = suppressions(root, { limit: 8, wasJudged: false }).rows;
  const yes = [...notes.values()]
    .filter((n) => n.source_fingerprint && !n.facets.intake?.length)
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
    .slice(0, 8);

  if (!back.length && !no.length && !yes.length) return '';

  const L: string[] = ['', '# What this reader has actually decided', ''];
  if (back.length) {
    L.push(
      'These were declined and the reader **took the decline back**. Getting one of',
      'these wrong costs them the item, so weigh them above everything below: if a',
      'candidate resembles one of these, keep it even when the wording looks routine.',
      '',
    );
    for (const r of back) L.push(`  RESCUED  ${(r.title ?? r.fingerprint).slice(0, 90)}  (had been declined: ${r.reason})`);
    L.push('');
  }
  if (no.length) {
    L.push('Declined, and left declined:', '');
    for (const s of no) L.push(`  NO   ${(s.title ?? s.fingerprint).slice(0, 90)}  (${s.reason})`);
    L.push('');
  }
  if (yes.length) {
    L.push('Kept, and judged — this is what a note in this vault reads like:', '');
    for (const n of yes) L.push(`  YES  ${n.title.slice(0, 90)}`);
    L.push('');
  }
  return L.join('\n');
}

function promptFor(root: string): string {
  const file = join(paths(root).config, 'classify.md');
  if (existsSync(file)) {
    const body = readFileSync(file, 'utf8').trim();
    if (body) return body;
  }
  return DEFAULT_PROMPT;
}

/**
 * The axes a model may propose, rendered for a prompt.
 *
 * `intake` and `extends` are withheld — they are the app's bookkeeping and a
 * model setting either would be writing the pipeline's own state. Reference axes
 * other than `project` are withheld too: their values are note ids, and inviting
 * a model to invent relationships between notes it has only seen the titles of is
 * a different feature with a different failure mode.
 */
const NOT_THE_MODEL_S = new Set(['intake', 'extends']);

function offerableAxes(defs: Facets): string[] {
  return Object.keys(defs).filter(
    (name) => !NOT_THE_MODEL_S.has(name) && (!isRef(defs[name]!) || name === 'project'),
  );
}

function vocabularyFor(root: string): {
  text: string;
  defs: Facets;
  projects: Set<string>;
  notes: Map<string, Note>;
} {
  const defs = loadFacets(paths(root).facets);
  const { notes } = reindex(root);

  const projects = new Set<string>();
  // A note carrying a `project:` block is a project — the same rule the `type`
  // computed axis applies.
  for (const rec of notes.values()) if (rec.project) projects.add(rec.id);

  /** Every value the vault is currently using, per axis. */
  const inUse = new Map<string, Set<string>>();
  for (const rec of notes.values()) {
    for (const [name, values] of Object.entries(rec.facets)) {
      const set = inUse.get(name) ?? new Set<string>();
      for (const v of values) set.add(v);
      inUse.set(name, set);
    }
  }

  const lines: string[] = ['# Axes'];
  for (const name of offerableAxes(defs)) {
    const def = defs[name]!;
    if (name === 'project') {
      // Its vocabulary is the vault, so it is listed rather than declared.
      const list = [...projects].map((id) => `${id} (${notes.get(id)?.title ?? ''})`).join(', ');
      lines.push(`- project (single value; one of): ${list || '(no project notes yet)'}`);
      continue;
    }
    /**
     * Declared values, plus the ones notes are actually carrying.
     *
     * An open axis often declares none — `domain: {values: [], open: true}` is
     * the seeded shape — so a model shown only the declaration has nothing to
     * reuse and mints a word every time. That is how a vault ends up with
     * `webhooks`, `webhook` and `eventing` meaning one thing. Showing what is in
     * use, and asking for it by preference, keeps an open axis open without
     * letting a queue of unjudged cards sprawl the vocabulary.
     */
    const known = [...new Set([...(def.values ?? []), ...(inUse.get(name) ?? [])])];
    /**
     * A typed axis says what its values *are*, not which ones exist.
     *
     * `due` declares no vocabulary — the whole of a date is its vocabulary — so
     * listing what other notes happen to carry tells a model nothing about the
     * shape it should write, and it will offer "Friday" or a full timestamp. This
     * is the same reason a label axis lists its values: say what would be
     * accepted, in the terms the axis actually accepts.
     */
    if (def.type === 'date' || def.type === 'number') {
      lines.push(
        `- ${name} (single value; ${def.type === 'date' ? 'a date, YYYY-MM-DD' : 'a number'})`,
      );
      continue;
    }
    const shown = known.length ? known.join(', ') : '(nothing yet)';
    lines.push(
      `- ${name}${def.single ? ' (single value)' : ''}: ${shown}` +
        (def.open ? ' — prefer one of these; invent a new value only if none fits' : ''),
    );
  }
  return { text: lines.join('\n'), defs, projects, notes };
}

/**
 * The note a tracked candidate is news about, as the model needs to see it: what
 * it is called, which axes it sits on, and the head of its body. Two at most —
 * a conversation on two open notes is rare and a third would be padding.
 */
function trackedFor(ids: string[], notes: Map<string, Note>) {
  return ids.slice(0, 2).map((id) => {
    const n = notes.get(id);
    return n
      ? { id, title: n.title, facets: n.facets, body: n.body.trim().slice(0, 500) }
      : { id };
  });
}

/** What the model is shown: every scrap the channel gathered, and nothing else. */
function payloadFor(candidates: Candidate[], notes: Map<string, Note>): string {
  return JSON.stringify(
    candidates.map((c) => ({
      fp: c.fingerprint,
      channel: c.channel,
      raw_title: c.title.slice(0, 300),
      ...(c.detail ? { detail: c.detail.slice(0, 400) } : {}),
      // `fields` is where the channels put what they actually learned — repo,
      // branch, cwd, turn count, session state, every commit subject, the whole
      // exchange of a conversation. It was being thrown away, and it is most of
      // what makes a readable body possible.
      ...(c.fields?.length ? { context: c.fields.map((f) => `${f.k}: ${f.v}`) } : {}),
      ...(c.when ? { when: c.when } : {}),
      ...(c.evidence?.linkedTo?.length ? { tracked: trackedFor(c.evidence.linkedTo, notes) } : {}),
      ...(c.evidence?.matches?.length
        ? { matches: c.evidence.matches.map((m) => `${m.id} — ${m.title} (matched by ${m.why})`) }
        : {}),
    })),
    null,
    0,
  );
}

/**
 * What a model answered, and what answering cost when the transport can say.
 *
 * A bare string is still accepted, because every test and every vault-side fake
 * answers with one, and a fake that has to invent a cost is a fake that lies.
 */
export type AskReply = string | { text: string; cost?: Cost };

/** Asks a model and returns its raw text, or null when it could not be reached. */
export type Ask = (system: string, user: string) => Promise<AskReply | null>;

const NO_TOOLS =
  'Bash Read Write Edit Glob Grep WebFetch WebSearch Task TodoWrite NotebookEdit BashOutput KillShell SlashCommand Skill';

/**
 * The compatibility transport: the Claude CLI, through the same read-only
 * subprocess runner everything else outside the vault goes through.
 *
 * Deliberately stripped. `--system-prompt` replaces the default one,
 * `--disallowedTools` drops the tool definitions, and `--strict-mcp-config` with
 * no config keeps a machine's MCP servers out. What is left is a classification
 * rather than an agent, which is both cheaper and more predictable — a classifier
 * able to read files would eventually read them.
 */
export function claudeAsk(command: string, model: string, timeoutMs = 180_000): Ask {
  return async (system, user) => {
    const started = Date.now();
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
      { timeoutMs },
    );
    if (!res.ok) return null;
    try {
      const env = JSON.parse(res.stdout) as Record<string, unknown>;
      if (env.is_error) return null;
      return typeof env.result === 'string'
        ? { text: env.result, cost: costFromEnvelope(env, Date.now() - started) }
        : null;
    } catch {
      return null;
    }
  };
}

/**
 * The local transport: Ollama's native chat endpoint with JSON mode enabled.
 *
 * The application still validates every verdict itself. JSON mode only makes
 * the transport deterministic about syntax; it does not grant the model any
 * authority over facets or merge targets, and there are no tools to call.
 */
export function ollamaAsk(url: string, model: string, timeoutMs = 180_000): Ask {
  return async (system, user) => {
    const started = Date.now();
    try {
      const response = await fetch(`${url.replace(/\/+$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
          think: false,
          format: 'json',
          keep_alive: '10m',
          options: { temperature: 0, num_ctx: 16_384 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const env = (await response.json()) as {
        message?: { content?: unknown };
        prompt_eval_count?: unknown;
        eval_count?: unknown;
        total_duration?: unknown;
      };
      if (typeof env.message?.content !== 'string') return null;
      // Ollama reports its own wall time in nanoseconds and its token counts by
      // name; the fallback clock covers a build that reports neither.
      const cost: Cost = {
        ms: typeof env.total_duration === 'number' ? Math.round(env.total_duration / 1e6) : Date.now() - started,
      };
      if (typeof env.prompt_eval_count === 'number') cost.inputTokens = env.prompt_eval_count;
      if (typeof env.eval_count === 'number') cost.outputTokens = env.eval_count;
      return { text: env.message.content, cost };
    } catch {
      return null;
    }
  };
}

/**
 * Pull the JSON array out of a reply.
 *
 * Models fence JSON however the mood takes them, and failing closed over three
 * backticks would hold a whole sweep on punctuation. So the first balanced array
 * in the text wins.
 */
function rawVerdicts(text: string): Record<string, unknown>[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object');
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : undefined;
};

/**
 * Keep only what the vault would actually accept.
 *
 * An unknown axis, a value a closed axis never declared, a second value on a
 * single one — each is dropped on its own rather than failing the card, because a
 * card with two good facets and one invented one is still worth having and a
 * refused write is not.
 */
function validFacets(proposed: unknown, defs: Facets, projects: Set<string>): Record<string, string[]> {
  if (!proposed || typeof proposed !== 'object') return {};
  const allowed = new Set(offerableAxes(defs));
  const out: Record<string, string[]> = {};
  for (const [name, raw] of Object.entries(proposed as Record<string, unknown>)) {
    if (!allowed.has(name)) continue;
    const def = defs[name]!;
    const values = (Array.isArray(raw) ? raw : [raw])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .filter((v) =>
        // `project` names a note, so the vault is its vocabulary; every other
        // axis is open or declares its values.
        name === 'project' ? projects.has(v) : def.open || (def.values ?? []).includes(v),
      );
    const kept = def.single ? values.slice(0, 1) : values;
    if (kept.length) out[name] = kept;
  }
  return out;
}

export interface Classified {
  keep: { candidate: Candidate; verdict: Verdict }[];
  drop: { candidate: Candidate; reason: string }[];
  /** What the call cost, when the transport said. */
  cost?: Cost;
}

/**
 * Judge and describe a run's candidates, a batch at a time.
 *
 * One call per batch rather than one per candidate, which is not only cheaper: a
 * sweep's candidates arrive together and are frequently *one thing* — an
 * afternoon's commits on a branch — and a model shown all of them can say so,
 * where a model shown each in isolation cannot. It used to be one call per
 * channel, and a local model generating at six tokens a second cannot answer for
 * eighteen conversations inside any timeout a tick can afford — so a channel's
 * candidates are split into batches of `classify.batch`, judged in order, and
 * the verdicts merged. Cost is summed across the calls.
 *
 * Returns null when the classifier could not be reached for any batch: the tick
 * holds, and the batches already answered are not written, because a half-judged
 * channel would advance its cursor past candidates nobody judged. A candidate the
 * model failed to mention is **kept**, which is the safe direction of the two:
 * keeping costs a glance, dropping costs the item.
 */
export async function classify(
  root: string,
  candidates: Candidate[],
  ask: Ask = defaultAsk(root),
  batch = settingsFor(root).classify.batch,
): Promise<Classified | null> {
  if (!candidates.length) return { keep: [], drop: [] };

  const { text: vocab, defs, projects, notes } = vocabularyFor(root);
  const system = `${promptFor(root)}\n\n${vocab}\n${calibrationFor(root, notes)}`;
  const size = Math.max(1, Math.floor(batch));
  const out: Classified = { keep: [], drop: [] };
  for (let at = 0; at < candidates.length; at += size) {
    const slice = candidates.slice(at, at + size);
    const judged = await classifyBatch(slice, system, notes, defs, projects, ask);
    if (!judged) return null;
    out.keep.push(...judged.keep);
    out.drop.push(...judged.drop);
    const cost = addCost(out.cost, judged.cost);
    if (cost) out.cost = cost;
  }
  return out;
}

async function classifyBatch(
  candidates: Candidate[],
  system: string,
  notes: Map<string, Note>,
  defs: Facets,
  projects: Set<string>,
  ask: Ask,
): Promise<Classified | null> {
  const reply = await ask(system, payloadFor(candidates, notes));
  if (reply === null) return null;
  const text = typeof reply === 'string' ? reply : reply.text;
  const cost = typeof reply === 'string' ? undefined : reply.cost;
  const raw = rawVerdicts(text);
  if (!raw) return null;

  const byFp = new Map<string, Record<string, unknown>>();
  for (const r of raw) {
    const fp = typeof r.fp === 'string' ? r.fp : null;
    if (fp) byFp.set(fp, r);
  }

  const out: Classified = { keep: [], drop: [], ...(cost ? { cost } : {}) };
  for (const c of candidates) {
    const r = byFp.get(c.fingerprint);
    const reason = str(r?.reason, 200) ?? 'no reason given';
    const decision = r?.decision;

    if (decision === 'drop') {
      out.drop.push({ candidate: c, reason });
      continue;
    }

    // A target must be one of the mechanical matches. That is what stops a model
    // inventing a note id, and it costs nothing real: `matches` is computed from
    // the vault, so anything outside it was never a candidate for merging.
    const matched = new Set((c.evidence?.matches ?? []).map((m) => m.id));
    const named = str(r?.target, 200);
    const tracked = c.evidence?.linkedTo ?? [];
    // A tracked candidate lands on what tracks it whatever the verdict said —
    // the model's own choice among those notes when it made one, the first of
    // them otherwise. Anything else may only extend a match it actually named.
    const target =
      decision === 'extend' && named && matched.has(named)
        ? named
        : tracked.length
          ? named && tracked.includes(named)
            ? named
            : tracked[0]!
          : null;

    out.keep.push({
      candidate: c,
      verdict: {
        fingerprint: c.fingerprint,
        decision: target ? 'extend' : 'keep',
        reason,
        ...(str(r?.title, 200) ? { title: str(r?.title, 200)! } : {}),
        ...(str(r?.body, 2000) ? { body: str(r?.body, 2000)! } : {}),
        facets: validFacets(r?.facets, defs, projects),
        ...(target ? { target } : {}),
        ...(r?.notify === true ? { notify: true } : {}),
      },
    });
  }
  return out;
}

export function defaultAsk(root: string): Ask {
  const { classify: cfg } = settingsFor(root);
  const timeoutMs = cfg.timeoutSeconds * 1000;
  return cfg.provider === 'ollama'
    ? ollamaAsk(cfg.url, cfg.model, timeoutMs)
    : claudeAsk(cfg.command, cfg.model, timeoutMs);
}
