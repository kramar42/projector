import { marked } from 'marked';
import { headingOf, withoutHeading } from '../schema/frontmatter.ts';

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
export function renderBody(md: string, title?: string): string {
  // A note with no `title:` is titled by its leading heading, and the panel has
  // already drawn that as the note's name. Rendering it again would print the
  // title twice — the file is not wrong and neither is the panel, they are the
  // same sentence read by two readers. Only an *exact* match is dropped: a body
  // whose first heading says something else is saying something else.
  const source = title !== undefined && headingOf(md) === title ? withoutHeading(md) : md;
  const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = marked.parse(escaped, { gfm: true, async: false });
  // Relative asset paths resolve through the server's asset route.
  return html.replace(/src="(assets\/[^"]+)"/g, 'src="/api/asset/$1"');
}
