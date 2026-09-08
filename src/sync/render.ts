/**
 * One note as the markdown a reader outside the vault gets.
 *
 * A sync is a *projection*, exactly as a view is (C9) — the note stays the
 * source of truth (C1) and nothing here writes back. So this is deterministic
 * and total: the same note and the same set of companions always produce the same
 * bytes, which is not a nicety. It is the property the second direction rests on:
 * a difference between the folder and a fresh render is then either something you
 * changed or something the reader changed, never the renderer having a different
 * mood — and that is the only way an edit made on the far side can be told apart
 * and brought back.
 *
 * Which is also why nothing enriched appears. A cached Jira title is
 * machine-local and time-varying, so including it would make the same note render
 * differently on two machines and on two days, and every run would churn the
 * diff. A link travels as its ref and its href — which is all a fetcher was ever
 * adding to the ability to *follow* it (see `fallbackHref`).
 *
 * What is dropped is dropped because the reader cannot use it, not because it is
 * secret: `claude:` is a session on one machine, `workspace:` is a directory on
 * it. The one thing dropped for privacy is an `## Internal` section, and it is
 * the author's own marker rather than anything derived.
 */

import { bodyImages, hrefTarget, pathTarget, rewriteLinks } from '../schema/body.ts';
import { fallbackHref, fallbackLabel } from '../schema/links.ts';
import type { Link, Note } from '../schema/types.ts';

/**
 * The heading whose section never leaves the vault.
 *
 * A heading rather than a fence or a comment, for the reason `AGENTS.md` is a
 * file: prose made load-bearing by a regex is a trap, *unless* the marker is
 * something the author already sees and can read the meaning of. A reader of the
 * note sees a section titled Internal and knows why it is there; a reader of the
 * shared copy never receives it. The alternative — a note being all-or-nothing —
 * pushes the thinking out of the note, which is the one thing the vault must not
 * make people do.
 */
export const INTERNAL_HEADING = 'Internal';

/** What else is being shared, which is what decides how a reference travels. */
export interface Companions {
  /** The filename a shared note gets, or `null` when it is not being shared. */
  fileOf: (id: string) => string | null;
  /** Which note a resolved vault path names, or `null` for a path that is not one. */
  noteAt: (path: string) => string | null;
  /** Where a shared asset lands, or `null` when the file is not travelling. */
  assetAt: (path: string) => string | null;
  /**
   * Where a `doc:` ref points, whether or not anything is there.
   *
   * Passed in rather than computed here because a `doc:` ref is resolved against
   * the vault *root* — projector's own vocabulary, root-relative by design, where
   * a body href is relative to the file. `docPath` in `vault.ts` is the one
   * implementation of that rule and this module does not get a second.
   */
  docAt: (ref: string) => string | null;
  /** For a `jira:` ref's href. Configuration, not a fetch — so it is passed in. */
  jiraBase: string | null;
}

/**
 * Link kinds a reader outside the vault can actually follow.
 *
 * A whitelist, and deliberately not the complement of a drop-list: `LINK_KINDS`
 * will grow, and a kind added next year must default to staying home. The cost of
 * that default is a link nobody notices is missing; the cost of the other one is
 * a machine path in somebody else's repository.
 *
 * `doc:` is absent because it is not one thing — a doc ref is a note, an asset or
 * a file outside the vault, and each travels differently. `renderShared` decides
 * per ref instead.
 */
const SHAREABLE_KINDS = new Set(['jira', 'gh:pr', 'gh:branch', 'gh:commit', 'slack', 'url']);

/**
 * The body without its internal sections.
 *
 * A section is the heading and everything under it until a heading of the same
 * level or higher, so `## Internal` takes its own `###` subsections with it and
 * stops at the next `##`. Fenced code is skipped, because `## Internal` in a
 * markdown sample is a sample.
 */
export function withoutInternal(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let dropping: number | null = null;
  for (const line of body.split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const mark = f[1]!;
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      if (dropping === null) out.push(line);
      continue;
    }
    const heading = fence === null ? /^(#{1,6})\s+(.*?)\s*$/.exec(line) : null;
    if (heading) {
      const level = heading[1]!.length;
      if (dropping !== null && level <= dropping) dropping = null;
      if (dropping === null && heading[2]!.toLowerCase() === INTERNAL_HEADING.toLowerCase()) {
        dropping = level;
        continue;
      }
    }
    if (dropping === null) out.push(line);
  }
  return out.join('\n');
}

/**
 * Every reference in the body, pointed at where its target landed — or unwrapped.
 *
 * Three outcomes, and the middle one is the one worth stating: a link to a note
 * that exists but is *not* being shared becomes its own text. Leaving the
 * markup would hand the reader a link they cannot open, and leaving a bare
 * `[some-note]` would be worse — it looks like a mistake rather than a
 * deliberate boundary. The sentence survives; the pointer does not.
 */
function withLinksResolved(body: string, file: string, companions: Companions): string {
  return rewriteLinks(body, (link) => {
    const at = hrefTarget(link.href, file);
    // Not a path into the vault at all — an ordinary URL, an anchor. Untouched.
    if (at === null) return link.href;
    const named = companions.noteAt(at);
    if (named !== null) return companions.fileOf(named);
    return companions.assetAt(at);
  });
}

/**
 * Every image pointed at where its file landed.
 *
 * An image is content rather than a reference, so it is never unwrapped: a
 * sentence reads without a link and a document does not read with a hole in the
 * middle of it. One that cannot travel is left exactly as written — already
 * broken in the vault, and no worse here — rather than being silently deleted
 * from somebody's document.
 */
function withImagesResolved(body: string, file: string, companions: Companions): string {
  let out = body;
  for (const image of bodyImages(body).reverse()) {
    const at = pathTarget(image.href, file);
    const to = at === null ? null : companions.assetAt(at);
    if (to === null || to === image.href) continue;
    out = out.slice(0, image.at) + `![${image.text}](${to})` + out.slice(image.at + image.length);
  }
  return out;
}

/** One line per link a reader can follow, or nothing at all. */
function linkLines(links: readonly Link[], companions: Companions): string[] {
  const out: string[] = [];
  for (const link of links) {
    if (link.kind === 'doc') {
      // A doc ref is whatever is at the end of the path. A note travels as a
      // relative link, an asset as its shared path, and anything else — a
      // file in another repository — cannot travel at all.
      const at = companions.docAt(link.ref);
      if (at === null) continue;
      const named = companions.noteAt(at);
      const to = named !== null ? companions.fileOf(named) : companions.assetAt(at);
      if (to === null) continue;
      out.push(`- [${to.split('/').pop()}](${to})`);
      continue;
    }
    if (!SHAREABLE_KINDS.has(link.kind)) continue;
    const href = fallbackHref(link, companions.jiraBase);
    const label = fallbackLabel(link);
    out.push(href ? `- [${label}](${href})` : `- ${label}`);
  }
  return out;
}

/**
 * The note as shared: a title, the body, and the links worth following.
 *
 * The title becomes an `# H1` because it lives in the frontmatter, which does not
 * travel — so without this the reader gets a document with no name. Nothing else
 * from the frontmatter comes: a status, a priority and an energy level are how
 * *this* vault decides what to do next, and to anybody else they are a note.
 */
export function renderShared(note: Note, companions: Companions): string {
  const stripped = withoutInternal(note.body);
  const body = withImagesResolved(
    withLinksResolved(stripped, note.file, companions),
    note.file,
    companions,
  ).trim();
  const links = linkLines(note.links, companions);
  const out = [`# ${note.title}`, ''];
  if (body) out.push(body, '');
  if (links.length) out.push('## Links', '', ...links, '');
  return out.join('\n');
}
