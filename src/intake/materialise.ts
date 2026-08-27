import { loadFacets } from '../schema/facets.ts';
import { createNote } from '../server/mutate.ts';
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
 * What lands is an ordinary note carrying `intake: unjudged`. Judging it is
 * removing that value; declining it is deleting the file and recording the
 * fingerprint with `pj intake suppress`. Nothing here decides which — this
 * function has no opinion about whether the candidate was worth writing down, and
 * that is deliberate: **the poller proposes at whatever rate the channels
 * produce.** Making the queue quiet is a judgement, and there is not one here yet.
 */

/** A candidate the sweep already knows there is nothing to do about. */
function alreadyAnswered(c: Candidate): boolean {
  const e = c.evidence;
  // `linkedTo` means a note already carries this exact link and `capturedAs`
  // means one already answers for this fingerprint. Both are mechanical facts
  // about the vault rather than judgements, so acting on them costs nothing and
  // breaks no principle — unlike deciding that a candidate does not matter.
  return Boolean(e?.linkedTo?.length || e?.capturedAs?.length);
}

export interface Materialised {
  /** Notes created, by id. */
  created: string[];
  /** Candidates that were already in the vault, so nothing was written. */
  skipped: number;
  /** Notes created carrying `extends`, i.e. waiting to be merged into a target. */
  extending: number;
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

  const out: Materialised = { created: [], skipped: 0, extending: 0, notify: [] };
  for (const { candidate: c, verdict: v } of kept) {
    if (alreadyAnswered(c)) {
      out.skipped++;
      continue;
    }
    const res = createNote(root, {
      // The model's title when it wrote one, and the raw material only as a
      // fallback — a commit subject or an opening prompt is what made these
      // cards unreadable in the first place.
      title: v.title ?? c.title,
      facets: {
        ...v.facets,
        intake: ['unjudged'],
        ...(v.target ? { extends: [v.target] } : {}),
        ...(canTagSource ? { source: [channel] } : {}),
      },
      links: c.links,
      fingerprint: c.fingerprint,
      ...(v.body ?? c.detail ? { body: v.body ?? c.detail } : {}),
    });
    if (res.existed) out.skipped++;
    else {
      out.created.push(res.id);
      if (v.target) out.extending++;
      // Only a note that was actually written. Interrupting somebody about
      // something that turned out to be a duplicate is the fastest way to have
      // notifications turned off.
      if (v.notify) out.notify.push({ id: res.id, title: v.title ?? c.title });
    }
  }
  return out;
}
