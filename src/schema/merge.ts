import { isRef } from './facets.ts';
import type { Facets, Note, ProjectBlock } from './types.ts';

/**
 * Collapsing several notes into one.
 *
 * The composition and nothing else: what the surviving note says, given what it
 * said and what the notes folded into it said. Pure, so every rule below is
 * asserted directly rather than through a vault — `mergeNotes` in
 * `server/mutate.ts` is what applies it, repoints the references that named the
 * absorbed notes, and removes their files.
 *
 * **The asymmetry is the design.** Merging says "these were one thing all along",
 * and the thing they were is the one you picked, so the target keeps its own
 * classification entire: priority, status, energy, every label it carries. What
 * the others contribute is only what cannot be re-derived from the survivor —
 * their prose, their links, their references, and the fingerprints of wherever
 * they were captured from. A rule that combined labels would have to decide
 * between two `status` values, and there is no answer to that which is not a
 * guess about which note you meant.
 */
export interface Merged {
  /** The whole facet map, ready to write. */
  facets: Record<string, string[]>;
  /** Raw link refs, the target's first. */
  links: string[];
  body: string;
  /** Fingerprints the survivor now answers for. See `Note.absorbed_fingerprints`. */
  absorbed: string[];
  /** Present only when the target had no `project:` block and a source did. */
  project?: ProjectBlock;
}

export function merged(target: Note, sources: readonly Note[], facets: Facets): Merged {
  /**
   * The ids that stop existing separately — the sources, and the target itself.
   *
   * A reference naming any of them names the result, and a reference on the
   * result naming the result is the note pointing at itself, which `checkFacets`
   * refuses outright. So they are dropped rather than rewritten. This is not an
   * edge case: "merge this into its parent" reaches it every time.
   */
  const collapsing = new Set([target.id, ...sources.map((s) => s.id)]);

  const out: Record<string, string[]> = { ...target.facets };
  for (const [name, def] of Object.entries(facets)) {
    if (!isRef(def)) continue;
    const held = out[name] ?? [];
    const brought = sources.flatMap((s) => s.facets[name] ?? []);
    if (!held.length && !brought.length) continue;
    // The target's values lead, which is what decides the single-valued case
    // below: an axis that holds one value keeps the survivor's, and adopts a
    // source's only where the survivor had none. Merging a note into one with no
    // container should leave the result where the absorbed note was, not nowhere.
    const values = [...new Set([...held, ...brought])].filter((v) => !collapsing.has(v));
    const kept = def.single ? values.slice(0, 1) : values;
    if (kept.length) out[name] = kept;
    else delete out[name];
  }

  const links = [...new Set([target, ...sources].flatMap((n) => n.links.map((l) => l.raw)))];

  const absorbed = [
    ...new Set(
      sources
        .flatMap((s) => [s.source_fingerprint, ...(s.absorbed_fingerprints ?? [])])
        .concat(target.absorbed_fingerprints ?? [])
        .filter((f): f is string => Boolean(f)),
    ),
  ].filter((f) => f !== target.source_fingerprint);

  return {
    facets: out,
    links,
    body: composed(target, sources),
    absorbed,
    // Adopted rather than combined. A project note absorbed into a plain one
    // takes every membership with it — `mergeNotes` repoints them — and a
    // survivor with no config of its own would leave that whole portfolio
    // inheriting nothing. Merging two notes that both carry config keeps the
    // survivor's, on the same rule as every other axis.
    ...(target.project ? {} : { project: sources.find((s) => s.project)?.project }),
  };
}

/**
 * The merged body: the survivor's prose, then one `##` section per absorbed note,
 * titled with its title.
 *
 * A note with an empty body still gets its heading. Most notes in a real vault
 * are a title and nothing else, and the heading is then the entire record that
 * the note was folded in here — dropping it would make the merge silent.
 *
 * This is the one place a write reformats what it did not have to: the survivor's
 * own body is trimmed rather than kept byte-identical, because the sections have
 * to be joined by something and "whatever whitespace the file happened to end
 * with" is not a rule anybody can predict. Every other write in this codebase
 * leaves the body alone; this one is rewriting it on purpose.
 */
function composed(target: Note, sources: readonly Note[]): string {
  const blocks: string[] = [];
  const own = target.body.trim();
  if (own) blocks.push(own);
  for (const s of sources) {
    const text = demoted(reassigned(s.body, s.id, target.id)).trim();
    blocks.push(text ? `## ${s.title}\n\n${text}` : `## ${s.title}`);
  }
  return `\n${blocks.join('\n\n')}\n`;
}

/**
 * Asset references pointed at the absorbed note's folder; the files move with the
 * body, so the paths move with them.
 *
 * Paths are vault-relative (`assets/<id>/<hash>.png`, resolved by the server's
 * asset route), so an unrewritten path would keep working right up until the
 * absorbed note's folder was removed — which is exactly what `mergeNotes` does
 * after moving the files. The rewrite and the move are one decision in two
 * places; neither is correct alone.
 */
function reassigned(body: string, from: string, to: string): string {
  if (from === to) return body;
  return body.split(`assets/${from}/`).join(`assets/${to}/`);
}

/**
 * Every heading pushed one level deeper, so an absorbed note's own headings sit
 * *under* the section that names it rather than beside it. `######` has nowhere
 * to go and stays.
 *
 * Fenced blocks are skipped. A `# comment` in a shell snippet is not a heading,
 * and demoting it would silently edit code — the vault has no fenced blocks today
 * and every note in it is one paste away from having one.
 */
export function demoted(body: string): string {
  let fence: string | null = null;
  return body
    .split('\n')
    .map((line) => {
      const opening = /^\s*(`{3,}|~{3,})/.exec(line);
      if (opening) {
        const marker = opening[1]![0]!;
        if (fence === null) fence = marker;
        else if (marker === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      // A space or end of line is what makes it a heading rather than a `#tag`.
      return /^#{1,5}(\s|$)/.test(line) ? `#${line}` : line;
    })
    .join('\n');
}
