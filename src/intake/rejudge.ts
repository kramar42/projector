import { readAll } from '../index/indexer.ts';
import { classify, type Ask } from './classify.ts';
import { judgedBody, SOURCE_EXCERPT } from './materialise.ts';
import { patchNote } from '../server/mutate.ts';
import { paths } from '../config.ts';
import type { Candidate } from './types.ts';

/**
 * Running the pass again over cards nobody has judged yet.
 *
 * The pass writes a card once, on the way in, so a vault holding cards from an
 * earlier or thinner version of it keeps them — and deleting one to force a
 * re-sweep records the decline, so it does not come back either. This is the way
 * out of both, and the way to benefit from a changed `classify.md` without
 * emptying the queue by hand.
 *
 * **What it may touch is already stored, and that was not obvious.** This is the
 * only operation in the pipeline that overwrites a note rather than creating one,
 * so it needs a rule — and the rule looked at first like it needed a way to tell a
 * value the model proposed from one a person accepted. It does not: accepting is
 * what makes a value yours, typed or clicked, and `intake: unjudged` is exactly
 * the note-level record of whether that has happened. So this touches notes still
 * carrying the axis, and nothing else, and no new provenance is needed anywhere.
 *
 * The residue is worth stating rather than solving: a note you corrected but did
 * not judge is still a proposal by its own flag, so this would overwrite the
 * correction. That is what leaving the axis on means, and this is a command run
 * deliberately rather than something that happens to anyone.
 *
 * **It never deletes.** A verdict of `drop` is reported and not applied, because
 * the asymmetry that governs everything else here governs this too — and the
 * damage is worse in this direction than at intake, the card having a body
 * somebody may have written on by now. Declining one is `pj rm`, which records it.
 */

export interface Rejudged {
  /** Notes whose title, body or facets changed. */
  changed: { id: string; title: string }[];
  /** Looked at and left exactly as they were. */
  same: number;
  /**
   * Notes the pass would no longer keep, named rather than removed. Deleting one
   * is a separate, deliberate act.
   */
  wouldDrop: { id: string; title: string; reason: string }[];
  /** Set when the classifier could not be reached; nothing was written. */
  held?: string;
}

const same = (a: string[] = [], b: string[] = []): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export async function rejudge(
  root: string,
  opts: { limit?: number; ask?: Ask } = {},
): Promise<Rejudged> {
  const out: Rejudged = { changed: [], same: 0, wouldDrop: [] };
  const { notes } = readAll(paths(root).notes);

  const pending = [...notes.values()]
    .filter((n) => n.facets.intake?.length)
    .slice(0, opts.limit ?? 50);
  if (!pending.length) return out;

  /**
   * The note, put back into the shape a channel would have handed over.
   *
   * The raw material a channel gathered is gone — a sweep keeps no copy — so what
   * this can offer is the card as it stands. Which is the right input anyway: the
   * question is whether *this card*, as written, is worth keeping and correctly
   * described.
   */
  const candidates: Candidate[] = pending.map((n) => {
    // A card that extends a note is news about that note, and the contract has
    // to know it: without the target as tracking evidence a `change` on it
    // looks untargeted and is dropped for naming nothing it changes — which is
    // how a promise with a due date was named stale on the first rejudge.
    const target = n.facets.extends?.[0];
    const tracked = target && notes.has(target) ? [target] : [];
    return {
      // Not read off whatever axis this vault records provenance on: which axis
      // that is, is the vault's business (C4), and the channel is only context
      // for the prompt here. The card is the input, not where it came from.
      channel: 'vault',
      fingerprint: n.source_fingerprint ?? `note:${n.id}`,
      title: n.title,
      links: n.links.map((l) => l.raw),
      ...(n.body.trim() ? { detail: n.body.trim().slice(0, 800) } : {}),
      ...(tracked.length
        ? {
            evidence: {
              linkedTo: tracked,
              matches: tracked.map((id) => ({ id, title: notes.get(id)?.title ?? id, why: 'tracked' })),
            },
          }
        : {}),
    };
  });

  const judged = await classify(root, candidates, opts.ask);
  if (!judged) {
    // Held, on the same reasoning a tick holds: a pass that cannot judge must not
    // fall back to writing something, and here "something" would be an overwrite.
    out.held = 'the classifier could not be reached';
    return out;
  }

  const byFingerprint = new Map(pending.map((n, i) => [candidates[i]!.fingerprint, n]));

  for (const d of judged.drop) {
    const note = byFingerprint.get(d.candidate.fingerprint);
    if (note) out.wouldDrop.push({ id: note.id, title: note.title, reason: d.reason });
  }
  // No verdict twice over is left exactly as it is: this pass rewrites on a
  // judgement and there was none.
  out.same += judged.unjudged.length;

  for (const { candidate, verdict } of judged.keep) {
    const note = byFingerprint.get(candidate.fingerprint);
    if (!note) continue;
    // A card the pass would now merely *link* is a card it would not keep: the
    // branch belongs on the note, not in the queue. Named, like a drop.
    if (verdict.decision === 'link') {
      out.wouldDrop.push({ id: note.id, title: note.title, reason: verdict.reason });
      continue;
    }

    /**
     * `intake` and `extends` are carried forward rather than re-proposed. The
     * card is still unjudged — that is why it was eligible — and the model is not
     * shown either axis, so it has no opinion to apply.
     */
    const facets: Record<string, string[]> = {
      ...verdict.facets,
      intake: note.facets.intake!,
      ...(verdict.target
        ? { extends: [verdict.target] }
        : note.facets.extends
          ? { extends: note.facets.extends }
          : {}),
    };

    const title = verdict.title ?? note.title;
    /**
     * The model's body is bare prose; the note's is the file's own bytes.
     *
     * `patchNote` writes a body verbatim on purpose — the panel's editor read it
     * with its leading blank line and hands the same back — so a bare string
     * arrives welded to the closing `---`. `createNote` normalises for exactly
     * this reason and this is the same job on the other write path, which is why
     * only the model's half is touched: normalising the note's own body would
     * add a line every time the pass agreed with it.
     */
    const judged = verdict.body ? judgedBody(verdict, undefined) : undefined;
    // What was said in the source is not the model's half, so a rewrite keeps it.
    const at = note.body.indexOf(SOURCE_EXCERPT);
    const said = at >= 0 ? note.body.slice(at).trim() : '';
    const body = judged ? `\n${[judged.trim(), said].filter(Boolean).join('\n\n')}\n` : note.body;
    const facetsMoved = Object.keys({ ...facets, ...note.facets }).some(
      (k) => !same(facets[k], note.facets[k]),
    );
    if (title === note.title && body.trim() === note.body.trim() && !facetsMoved) {
      out.same++;
      continue;
    }

    // No base mtime: nothing read this note into a form somebody is editing, and
    // the write-path table already records this path as unguarded.
    patchNote(root, note.id, { title, body, facets });
    out.changed.push({ id: note.id, title });
  }
  return out;
}
