import { loadFacets } from '../schema/facets.ts';
import { createNote } from '../server/mutate.ts';
import { paths } from '../config.ts';
import type { Candidate, ChannelReport } from './types.ts';

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
}

/**
 * Write every candidate in a report that is not already answered for.
 *
 * `createNote` short-circuits on a fingerprint the vault already holds — its own
 * or one absorbed by a merge — so running this twice over the same report creates
 * nothing the second time. That is what makes it safe on a timer: convergence is
 * a property of the write, not of the caller remembering what it did.
 */
export function materialise(root: string, report: ChannelReport): Materialised {
  const defs = loadFacets(paths(root).facets);
  // `source` is a vault's own axis, not a built-in, so a vault that never
  // declared it must not be handed one. `intake` is always safe: it is built in.
  const canTagSource = Boolean(defs.source) && (defs.source?.open || (defs.source?.values ?? []).includes(report.channel));

  const created: string[] = [];
  let skipped = 0;
  for (const c of report.candidates) {
    if (alreadyAnswered(c)) {
      skipped++;
      continue;
    }
    const res = createNote(root, {
      title: c.title,
      facets: {
        intake: ['unjudged'],
        ...(canTagSource ? { source: [report.channel] } : {}),
      },
      links: c.links,
      fingerprint: c.fingerprint,
      ...(c.detail ? { body: c.detail } : {}),
    });
    if (res.existed) skipped++;
    else created.push(res.id);
  }
  return { created, skipped };
}
