import { loadFacets } from '../schema/facets.ts';
import { createNote, patchNote } from '../server/mutate.ts';
import { readAll } from '../index/indexer.ts';
import { paths } from '../config.ts';
import type { Verdict } from './classify.ts';
import type { Candidate } from './types.ts';

/**
 * Turning a candidate into a note nobody has judged yet.
 *
 * A sweep run by a person proposes and stops, because a person is right there to
 * say yes. A sweep run by a poller has nobody to ask, so it writes the candidate
 * down and lets the answer come later — which is the whole difference between the
 * two, and the reason the queue exists.
 *
 * What lands is an ordinary note in `inbox/`, unjudged by being there. Judging
 * it is `pj accept`, which files it; declining it is `pj decline`, which removes
 * the file and records the fingerprint. Nothing here decides which — this
 * function has no opinion about whether the candidate was worth writing down, and
 * that is deliberate: **the poller proposes at whatever rate the channels
 * produce.** Making the queue quiet is a judgment, and there is not one here yet.
 */

/**
 * A candidate the sweep already knows there is nothing to write for.
 *
 * `capturedAs` means a note already answers for this fingerprint: written before,
 * nothing to do. `linkedTo` means the vault tracks the thing this candidate is
 * news about — and news is written only as an extension of the note that tracks
 * it. Without a target, which is what a tracked candidate looks like when the
 * classifier is switched off, writing it would stand a second note beside the
 * first, which is the duplicate the tracking exists to prevent. Both are
 * mechanical facts about the vault rather than judgments, so acting on them
 * costs nothing and breaks no principle.
 */
export function alreadyAnswered(c: Candidate, v: Verdict): boolean {
  const e = c.evidence;
  if (e?.capturedAs?.length) return true;
  return Boolean(e?.linkedTo?.length && !v.target);
}

export interface Materialised {
  /** Notes created, by id. */
  created: string[];
  /** Candidates that were already in the vault, so nothing was written. */
  skipped: number;
  /** Notes created carrying `extends`, i.e. waiting to be merged into a target. */
  extending: number;
  /**
   * Of `extending`, those that are news about a note the vault already tracked —
   * the sync half — rather than a discovery that happened to match one.
   */
  updates: number;
  /**
   * The owner's own progress attached to the note it belongs to, with no card:
   * the branch or session's link and its fingerprint now on that note.
   */
  linked: { id: string; fingerprint: string }[];
  /** The ones the classifier judged worth interrupting for: `{id, title}`. */
  notify: { id: string; title: string }[];
}

/**
 * Write every kept candidate that is not already answered for.
 *
 * `createNote` short-circuits on a fingerprint the vault already holds — its own
 * or one absorbed by a merge — so running this twice over the same verdicts
 * creates nothing the second time. That is what makes it safe on a timer:
 * convergence is a property of the write, not of the caller remembering what it
 * did.
 *
 * **What lands is the classifier's proposal, in the vault's own terms.** Title,
 * body and facets are the model's; `intake: unjudged` is what says none of it has
 * been confirmed; `extends` is what says it wants folding into another note
 * rather than standing alone. Every value was validated against the vocabulary
 * before it got here — this function writes, it does not judge.
 */
/**
 * The body a card arrives with, led by why the classifier kept it.
 *
 * The reason was computed for every verdict and then thrown away for the ones
 * that were kept — `suppress` stored it on a decline and nothing stored it on a
 * keep. So the pile you are *not* looking at explained itself and the queue you
 * have to work through did not, which put the reconstruction cost on the
 * expensive direction: declining a card meant re-deriving the model's reasoning
 * from its description.
 *
 * A blockquote rather than a frontmatter field because it is prose about this
 * note, which is what a body is (C6) — and because it then survives every path
 * that already handles bodies: the panel renders it, the editor edits it, `pj`
 * prints it, and folding carries it across. A reserved key would have needed all
 * four taught about it.
 *
 * It is the model's words and it is yours to delete. Accepting the card makes the
 * whole body yours the way every other proposed value becomes yours, and a
 * `rejudge` rewrites it along with the rest — both already true of the body, so
 * the quote inherits the rule rather than needing one.
 */
export function judgedBody(v: Verdict, detail: string | undefined): string | undefined {
  const body = v.body ?? detail;
  if (!v.reason) return body;
  const quote = `> ${v.reason}`;
  return body ? `${quote}\n\n${body}` : quote;
}

/** The line that opens a card's excerpt, so a `rejudge` can tell it from the model's half. */
export const SOURCE_EXCERPT = 'Said in the source, newest last:';

/**
 * The last few lines of the conversation the judge read, as they were said.
 *
 * A card used to carry only the judge's account of a message, so reading the
 * queue was reading a summary of something you could not see without clicking
 * away. The transcript is already in hand — it is what the judge was shown,
 * with credential shapes redacted on the way in — so the tail of it goes on the
 * card. Three lines, each cut short: enough to recognise the exchange, not a
 * copy of the thread. A fence, so nothing in it is read as a link, and a fence
 * a message itself contains is defused rather than allowed to close it.
 */
export function sourceExcerpt(c: Candidate, lines = 3): string | undefined {
  const said = c.fields?.find((f) => f.k === 'conversation')?.v;
  if (!said) return undefined;
  const tail = said
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('('))
    .slice(-lines)
    .map((l) => l.replace(/`{3,}/g, "'''").slice(0, 240));
  return tail.length ? `${SOURCE_EXCERPT}\n\n\`\`\`text\n${tail.join('\n')}\n\`\`\`` : undefined;
}

/** What a card's body is: the judgment, then what was actually said. */
const cardBody = (v: Verdict, c: Candidate): string | undefined =>
  [judgedBody(v, c.detail), sourceExcerpt(c)].filter(Boolean).join('\n\n') || undefined;

export function materialise(
  root: string,
  channel: string,
  kept: { candidate: Candidate; verdict: Verdict }[],
): Materialised {
  const defs = loadFacets(paths(root).facets);
  // `source` is a vault's own axis, not a built-in, so a vault that never
  // declared it must not be handed one. `intake` and `extends` are always safe:
  // both are built in.
  const canTagSource =
    Boolean(defs.source) && (defs.source?.open || (defs.source?.values ?? []).includes(channel));

  const out: Materialised = { created: [], skipped: 0, extending: 0, updates: 0, linked: [], notify: [] };
  let notes: Map<string, { links: { raw: string }[] }> | null = null;
  /**
   * The links each note has after this run's attachments so far. The notes are
   * read once, so two candidates linked onto one note in one run — a project's
   * ten sessions — would otherwise each write the note's links as they were
   * before the run, and every attachment but the last would be lost.
   */
  const attached = new Map<string, string[]>();
  for (const { candidate: c, verdict: v } of kept) {
    if (alreadyAnswered(c, v)) {
      out.skipped++;
      continue;
    }
    /**
     * A link, not a card. The candidate's link joins the note's and its
     * fingerprint is absorbed there, so the next sweep finds the branch answered
     * for. `patchNote` refuses a fingerprint another note already holds, which is
     * the convergence `createNote` has: a second run attaches nothing twice.
     */
    if (v.decision === 'link' && v.target) {
      notes ??= readAll(paths(root).notes).notes;
      const target = notes.get(v.target);
      if (!target) {
        out.skipped++;
        continue;
      }
      try {
        const links = [...new Set([...(attached.get(v.target) ?? target.links.map((l) => l.raw)), ...c.links])];
        patchNote(root, v.target, { links, absorb: { values: [c.fingerprint], mode: 'add' } });
        attached.set(v.target, links);
        out.linked.push({ id: v.target, fingerprint: c.fingerprint });
      } catch {
        out.skipped++;
      }
      continue;
    }
    const res = createNote(root, {
      // The model's title when it wrote one, and the raw material only as a
      // fallback — a commit subject or an opening prompt is what made these
      // cards unreadable in the first place.
      title: v.title ?? c.title,
      facets: {
        ...v.facets,
        ...(v.target ? { extends: [v.target] } : {}),
        ...(canTagSource ? { source: [channel] } : {}),
      },
      links: c.links,
      fingerprint: c.fingerprint,
      inbox: true,
      ...(cardBody(v, c) ? { body: cardBody(v, c)! } : {}),
    });
    if (res.existed) out.skipped++;
    else {
      out.created.push(res.id);
      if (v.target) out.extending++;
      if (v.target && c.evidence?.linkedTo?.length) out.updates++;
      // Only a note that was actually written. Interrupting somebody about
      // something that turned out to be a duplicate is the fastest way to have
      // notifications turned off.
      if (v.notify) out.notify.push({ id: res.id, title: v.title ?? c.title });
    }
  }
  return out;
}
