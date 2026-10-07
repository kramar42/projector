/**
 * References a note body carries, read out of the markdown itself.
 *
 * The body is free-form (C6) and this does not change that: nothing here
 * constrains what a body may contain, it only *reads* the links already in it.
 * Which is the point — a mention is not a facet. A facet names its relation and
 * is therefore filterable, groupable, blocking and layout-bearing (C4); a link in
 * a sentence names nothing, so it stays prose and is derived on demand (C11)
 * rather than being copied into frontmatter where it would need maintaining in
 * two places and would disagree in one of them.
 *
 * It exists because the references in a body used to be maintained by nobody. A
 * body said `[some-note]` — a convention with no parser behind it, so it rendered
 * as literal brackets, `check` could not see it, and `rename` and `delete` swept
 * facet values and `doc:` links straight past it. This module is the seam that
 * makes a body reference a reference: `validate` reports one, `rename` and
 * `delete` rewrite one, the panel draws what mentions a note, and the exporter
 * decides per link whether the reader it is syncing to can follow it.
 *
 * Everything here is pure and path-shaped — no filesystem, no index — because
 * every caller already holds the notes and each wants a different verdict about
 * the same link.
 */

/** One markdown link in a body, with where it sits so it can be rewritten. */
export interface BodyLink {
  /** The link text as written, brackets excluded. */
  text: string;
  /** The href as written, parentheses excluded. */
  href: string;
  /** Character offset of the whole `[text](href)` construct. */
  at: number;
  /** Its length, so `at + length` is the character after it. */
  length: number;
}

/** A bare `[slug]` or `[[slug]]` — the conventions that predate this module. */
export interface BareRef {
  /** What was between the brackets. */
  text: string;
  at: number;
  length: number;
}

/**
 * The regions of a body that are prose, in order.
 *
 * Every scan below runs over these rather than over the whole string, and it is
 * not a nicety: bodies carry code samples, and a fenced block containing
 * `[text](file.md)` is a sample of a link rather than a link. `taskLines` in
 * `view/markdown.ts` solves the same problem line-wise for checkboxes; this one
 * has to be character-wise, because an inline code span is not a line.
 *
 * A run spans as many consecutive prose lines as there are, rather than one span
 * per line, because both markdown constructs this reads may wrap: a link's text
 * is allowed to contain a newline, and so is a code span. Splitting per line
 * would silently stop seeing a link the moment a formatter wrapped it, which is
 * the kind of gap that only shows up in the one note it happens to.
 */
function prose(body: string): { at: number; text: string }[] {
  const runs: { at: number; text: string }[] = [];
  const lines = body.split('\n');
  let offset = 0;
  let fence: string | null = null;
  let run: { at: number; lines: string[] } | null = null;
  const close = () => {
    if (run) runs.push({ at: run.at, text: run.lines.join('\n') });
    run = null;
  };
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const mark = f[1]!;
      // A fence closes only on the same character and a run at least as long, so
      // ```` inside a ``` block is content.
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      close();
      offset += line.length + 1;
      continue;
    }
    // An indented code block is four spaces at the start of a line, or a tab —
    // the rule CommonMark applies.
    if (fence !== null || /^(?: {4}|\t)/.test(line)) close();
    else if (run) run.lines.push(line);
    else run = { at: offset, lines: [line] };
    offset += line.length + 1;
  }
  close();
  // A code span may wrap, so it is removed from the assembled run rather than
  // from each line.
  return runs.flatMap((r) => outsideCode(r.text).map((s) => ({ at: r.at + s.at, text: s.text })));
}

/** One prose run split around its inline code spans. */
function outsideCode(text: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  let i = 0;
  let plain = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let ticks = 0;
    while (text[i + ticks] === '`') ticks++;
    const end = text.indexOf('`'.repeat(ticks), i + ticks);
    // An unclosed run of backticks is not a code span — what follows is prose
    // that happens to contain a backtick.
    if (end === -1) {
      i += ticks;
      continue;
    }
    if (i > plain) out.push({ at: plain, text: text.slice(plain, i) });
    i = end + ticks;
    plain = i;
  }
  if (plain < text.length) out.push({ at: plain, text: text.slice(plain) });
  return out;
}

/**
 * An inline markdown link: `[text](href)`, with the text allowed to carry its own
 * brackets one level deep so `[the [card] spec](x.md)` is one link.
 *
 * Images are excluded by the caller looking at the character before the match,
 * which is cheaper and clearer than encoding `(?<!!)` here.
 */
const LINK = /\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/g;

/** Every inline markdown link in the body's prose, in document order. */
export function bodyLinks(body: string): BodyLink[] {
  return scan(body, false);
}

/**
 * Every inline image, in document order.
 *
 * Separate from `bodyLinks` because an image is not a reference — it is content
 * the body *displays*, so a reader who cannot resolve it sees a hole rather than
 * a missing pointer. Which is why the publisher carries an image's file whether
 * or not anything linked it, and why a check about broken references should not
 * be reading this list.
 */
export function bodyImages(body: string): BodyLink[] {
  return scan(body, true);
}

function scan(body: string, images: boolean): BodyLink[] {
  const out: BodyLink[] = [];
  for (const span of prose(body)) {
    for (const m of span.text.matchAll(LINK)) {
      const at = span.at + m.index;
      const bang = m.index > 0 && span.text[m.index - 1] === '!';
      if (bang !== images) continue;
      out.push({ text: m[1]!, href: m[2]!, at: images ? at - 1 : at, length: m[0].length + (images ? 1 : 0) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A bare `[slug]` that is not part of a link, an image, a task box or a
 * reference definition.
 *
 * Reported rather than resolved, because a bare bracket is ambiguous *by
 * construction* and always will be: a vault's prose contains `[api]`, `[int]` and
 * `[ext]` as legend markers, which are not references to anything and never were.
 * So this answers "which brackets are there", and the caller — which knows the
 * note ids — decides which of them are a mistake. That division is the whole
 * reason the check can be precise: after the convention is gone, a bare bracket
 * matters only when it happens to name a note.
 */
export function bareRefs(body: string): BareRef[] {
  const out: BareRef[] = [];
  for (const span of prose(body)) {
    for (const m of span.text.matchAll(/\[([^\[\]\n]*)\]/g)) {
      let at = m.index;
      let length = m[0].length;
      const before = span.text[at - 1];
      const after = span.text.slice(at + length);
      if (before === '!') continue;
      // `[[slug]]` is the wiki-link spelling of the same convention, and it is
      // *one* reference rather than a bracket inside a bracket. Reported whole,
      // because a caller that fixed only the inner half would leave `[[Title](x.md)]`
      // behind — which is exactly what a migration did before this said so.
      // The text before the bracket on *its own* line, which two of the guards
      // below need: a prose run spans many lines.
      const line = span.text.slice(0, at).split('\n').pop()!;
      const wiki = before === '[' && after.startsWith(']');
      if (wiki) {
        at -= 1;
        length += 2;
      } else {
        // `[text](href)` and `[text][label]` are links; `[label]: url` is a
        // definition. All three are markdown doing its job — and a reference link
        // is two brackets, so the *second* one is recognised by what precedes it.
        if (before === ']') continue;
        if (/^[([]/.test(after)) continue;
        // `[label]: url` is a definition — but only where markdown says one can
        // be, which is the start of a line. Anywhere else the colon belongs to
        // the sentence: `Relation to [some-note]: the checklist items…` is prose
        // holding a reference, and reading it as a definition is how that
        // reference went unreported in a real vault.
        if (/^:\s/.test(after) && /^ {0,3}$/.test(line)) continue;
      }
      // A task checkbox is `- [ ]` or `- [x]`, which is a control and not a ref.
      // Measured from the start of its own line, like the definition guard above.
      if (/^\s*(?:[-*+]|\d+[.)])\s*$/.test(line) && /^[ xX]?$/.test(m[1]!)) continue;
      out.push({ text: m[1]!, at: span.at + at, length });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The body with every link rewritten by `f`.
 *
 * One primitive for three writes, which is why it takes a function rather than a
 * from/to pair: a rename repoints an href, a delete unwraps the link to its own
 * text, and a sync does either depending on whether the reader it is writing for
 * can reach the target. Returning the href unchanged is the fourth case and
 * costs nothing.
 *
 * `null` unwraps — the text survives as prose, because the sentence around a
 * deleted link still has to read. Right-to-left so the offsets stay valid.
 */
export function rewriteLinks(body: string, f: (link: BodyLink) => string | null): string {
  let out = body;
  for (const link of bodyLinks(body).reverse()) {
    const next = f(link);
    if (next === link.href) continue;
    const replacement = next === null ? link.text : `[${link.text}](${next})`;
    out = out.slice(0, link.at) + replacement + out.slice(link.at + link.length);
  }
  return out;
}

/**
 * Where an href points, relative to the note holding it, or `null` when it does
 * not point inside the vault at all.
 *
 * Relative to the *note file* rather than to the vault root, which is the one
 * decision in this module with consequences. A `doc:` ref is root-relative
 * because it is projector's own vocabulary and projector knows where the root is.
 * A body link is plain markdown, and plain markdown is what a shared folder, a
 * git host and any other editor will resolve — all of which resolve relative to
 * the file. Making the two agree would mean picking one reader to be wrong for.
 *
 * The caller matches the result against the notes it holds, because "is there a
 * note there" is a question about the index and this is a question about a path.
 * Fragments and query strings are dropped — a link to a heading inside a note is
 * a link to the note.
 */
export function hrefTarget(href: string, fromFile: string): string | null {
  const at = pathTarget(href, fromFile);
  // Only markdown can be a note, and this is the note-shaped question: a caller
  // asking it wants to know which note a reference names. `pathTarget` is the one
  // to ask about a file.
  return at !== null && at.endsWith('.md') ? at : null;
}

/**
 * Where a relative href points, whatever kind of file is there.
 *
 * `hrefTarget` for anything that is not a note — an image, a spreadsheet, a
 * transcript. Same arithmetic, without the verdict about markdown, which is the
 * same split `resolveDoc` and `docPath` already make one layer out.
 */
export function pathTarget(href: string, fromFile: string): string | null {
  const raw = href.trim();
  if (!raw) return null;
  // A scheme, a protocol-relative URL, a bare fragment or a mail address is not a
  // path into the vault.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('#')) return null;
  const path = raw.split(/[#?]/)[0]!;
  if (!path) return null;
  return normalise(`${dirOf(fromFile)}/${decodeURI(path)}`);
}

/**
 * The href one note writes to reach another: the inverse of `hrefTarget`, and
 * beside it for that reason.
 *
 * Relative to the file, like everything else here, which is why this needs to
 * know nothing about a vault — only about two paths.
 */
export function hrefBetween(fromFile: string, toFile: string): string {
  const from = segments(dirOf(fromFile));
  const to = segments(toFile);
  let same = 0;
  while (same < from.length && same < to.length && from[same] === to[same]) same++;
  return [...Array(from.length - same).fill('..'), ...to.slice(same)].join('/');
}

/**
 * The path arithmetic, done here rather than by `node:path`.
 *
 * Not a preference: this module is imported by the panel, and the browser bundle
 * has no `node:path` — a shim silently supplied `undefined` where `dirname` was
 * expected, so the app booted to a blank page. `schema/slug.ts` is import-free
 * for the same reason, and that is the rule for anything under `schema/` the web
 * reaches. What is needed is small and POSIX, which is what a vault path is.
 */
function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s && s !== '.');
}

/** `.` and `..` collapsed away, with absoluteness preserved. */
function normalise(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of segments(path)) {
    if (segment !== '..') out.push(segment);
    // Above the root of an absolute path there is nothing, which is where
    // `resolve` stops too; a relative path keeps the `..` it cannot resolve.
    else if (out.length && out[out.length - 1] !== '..') out.pop();
    else if (!absolute) out.push('..');
  }
  return (absolute ? '/' : '') + out.join('/');
}
