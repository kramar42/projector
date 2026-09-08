import { Marked } from 'marked';
import { headingOf, withoutHeading } from '../schema/frontmatter.ts';
import { hrefTarget } from '../schema/body.ts';
import { idFromPath } from '../schema/slug.ts';

/**
 * Our own instance rather than the module-level `marked`, because the checkbox
 * renderer is overridden below and `marked.use` would mutate a singleton the
 * whole process shares.
 */
const md = new Marked({
  gfm: true,
  async: false,
  renderer: {
    /**
     * Enabled, where GFM's default is `disabled`.
     *
     * A body checkbox toggles (`toggleTask`), so the control is real and says so.
     * It was rendered disabled-by-default for as long as nothing listened, which
     * was the honest state then and a false affordance the moment it stopped
     * being true.
     */
    checkbox({ checked }: { checked: boolean }): string {
      return `<input type="checkbox"${checked ? ' checked=""' : ''}> `;
    },
  },
});

/**
 * LLM-written bodies commonly acquire separator-only lines at the file edges.
 * They have no markdown meaning, but CodeMirror gives each one a visible row.
 * Keep interior whitespace untouched — it can be prose, a list, or a code block
 * — and remove only those accidental outer rows before editing or saving.
 */
export function withoutOuterBlankLines(body: string): string {
  return body
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '');
}

/**
 * A note body as HTML, safe to hand to `dangerouslySetInnerHTML`.
 *
 * The source is escaped **before** markdown runs, so raw HTML in a note — written
 * by hand or by an agent — is displayed rather than executed. Notes are local
 * files, but they are also the one thing here that an automated process writes,
 * which is exactly where not to trust markup.
 *
 * Here rather than inside the panel because the property it holds is a security
 * one, and a security property that only a component can reach is a security
 * property with no test.
 */
/**
 * Where a body's relative link goes in the *app*, given the vault-relative path
 * of the note holding it.
 *
 * A body reference is plain markdown, resolved relative to the file, so that a
 * reader outside this app — a shared folder, a git host, another editor —
 * follows it correctly. Inside the app there is no such file to follow: the
 * panel is a single route, and a bare `other.md` href would navigate the browser
 * out of it. So the href is rewritten to the query the app already deep-links
 * with, and both readers get the link that works for them from the one thing
 * written in the file (C11).
 *
 * The id comes from `idFromFile` rather than from a parsed frontmatter `id:`,
 * which is the one approximation here: a hand-written note whose `id:` disagrees
 * with its filename resolves to the id its path implies. That is the same trade
 * every derived id in the format already makes, and every write materialises the
 * id it was called by — so the two only disagree in a file the app has never
 * written, and the failure is a panel saying it cannot find that note.
 *
 * A path through `assets/` is a document rather than a note — the note walk
 * skips that folder — so it goes to the asset route instead, which is where an
 * image in the same body already goes.
 */
function appHref(href: string, file: string): string | null {
  // Rooted at `/` so `..` arithmetic works on a vault-relative path, then
  // unrooted again: the result is measured from the vault, like `file` is.
  const at = hrefTarget(href, `/${file}`);
  if (at === null) return null;
  const path = at.replace(/^\/+/, '');
  if (!path) return null;
  const segments = path.split('/');
  if (segments.includes('assets')) return `/api/asset/${path}`;
  return `${NOTE_QUERY}${encodeURIComponent(idFromPath(path))}`;
}

/** The query a body reference is rewritten to, so both ends spell it once. */
const NOTE_QUERY = '?note=';

/**
 * Which note a rewritten body reference names, or `null` if the href is not one.
 *
 * The other half of `appHref`, and exported because the panel has to intercept
 * the click: following the href directly would replace the whole query string
 * and drop the vault and the view with it. Two places therefore agree about the
 * shape of one href — which is why the shape is written once, here, rather than
 * spelled `?note=` in a component and in a renderer.
 */
export function noteHrefId(href: string): string | null {
  if (!href.startsWith(NOTE_QUERY)) return null;
  const id = decodeURIComponent(href.slice(NOTE_QUERY.length));
  return id || null;
}

export function renderBody(source: string, title?: string, file?: string): string {
  // A note with no `title:` is titled by its leading heading, and the panel has
  // already drawn that as the note's name. Rendering it again would print the
  // title twice — the file is not wrong and neither is the panel, they are the
  // same sentence read by two readers. Only an *exact* match is dropped: a body
  // whose first heading says something else is saying something else.
  const body = title !== undefined && headingOf(source) === title ? withoutHeading(source) : source;
  const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = md.parse(escaped, { gfm: true, async: false }) as string;
  // Relative asset paths resolve through the server's asset route.
  const withAssets = html.replace(/src="(assets\/[^"]+)"/g, 'src="/api/asset/$1"');
  // A body reference is only followable once it knows which note it was written
  // in, so a caller with no path in hand gets the markdown unchanged rather than
  // a guess.
  if (file === undefined) return withAssets;
  return withAssets.replace(/href="([^":]*)"/g, (whole, href: string) => {
    const next = appHref(href, file);
    return next === null ? whole : `href="${next}"`;
  });
}

/** A list item that is a task: `- [ ]`, `* [x]`, `1. [ ]`. */
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;
/** An opening or closing fence, at the indentation CommonMark still calls a fence. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The line of every task checkbox in a body, in the order they render.
 *
 * The whole reason this is not `body.split('\n').filter(isTask)`: a fenced code
 * block containing `- [ ] something` draws **no** checkbox, so a naive count goes
 * one out and the click flips a line inside a code sample. `client.test.ts` pins
 * the agreement between this list and the checkboxes the renderer actually emits,
 * which is the property the caller depends on and neither half can hold alone.
 *
 * Computed against the **raw** body, not the heading-stripped `source` the
 * renderer uses: the first non-blank line is what `withoutHeading` drops and a
 * heading is never a task, so the ordinals agree and the caller can hand us the
 * text it is about to write back.
 */
export function taskLines(body: string): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  body.split('\n').forEach((line, i) => {
    const f = FENCE.exec(line);
    if (f) {
      const mark = f[1]!;
      // A fence closes only on the same character, and only on a run at least as
      // long — so ```` inside a ``` block is text, not a close.
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      return;
    }
    if (fence === null && TASK.test(line)) out.push(i);
  });
  return out;
}

/**
 * The body with the `n`th checkbox flipped, or null when there is no such box.
 *
 * One character changes. Everything else about the line — the marker, the
 * indentation, the text, whatever trailing whitespace a formatter left — is the
 * author's and is not ours to normalise (C1: the file is the source of truth, and
 * a write that reformats it is a write that churns their diff).
 */
export function toggleTask(body: string, n: number): string | null {
  const at = taskLines(body)[n];
  if (at === undefined) return null;
  const lines = body.split('\n');
  lines[at] = lines[at]!.replace(TASK, (_, open: string, state: string, close: string) =>
    `${open}${state === ' ' ? 'x' : ' '}${close}`,
  );
  return lines.join('\n');
}
