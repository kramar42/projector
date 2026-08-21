import { marked } from 'marked';

/**
 * A card body as HTML, safe to hand to `dangerouslySetInnerHTML`.
 *
 * The source is escaped **before** markdown runs, so raw HTML in a card — written
 * by hand or by an agent — is displayed rather than executed. Cards are local
 * files, but they are also the one thing here that an automated process writes,
 * which is exactly where not to trust markup.
 *
 * Here rather than inside the panel because the property it holds is a security
 * one, and a security property that only a component can reach is a security
 * property with no test.
 */
export function renderBody(md: string): string {
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = marked.parse(escaped, { gfm: true, async: false });
  // Relative asset paths resolve through the server's asset route.
  return html.replace(/src="(assets\/[^"]+)"/g, 'src="/api/asset/$1"');
}
