import { readFileSync, statSync } from 'node:fs';
import { ago, firstLine } from '../sources/run.ts';
import { unavailable, type Enrichment, type Fetcher } from './types.ts';
import { resolveDoc } from '../vault.ts';

/**
 * How to open a file that is not a web page.
 *
 * `file://` is the obvious answer and the wrong one: a browser will not navigate
 * to it from an http page, and where it does anything at all it downloads a copy
 * — which is not opening the document, it is making a second one.
 *
 * So the same shape `claude:` uses. A **deep link** where the machine has an app
 * registered for one, and a **command** where it does not. The difference is that
 * no scheme means "open this file with whatever owns it": `vscode://`, `cursor://`
 * and `obsidian://` each name one editor, so guessing would be picking the user's
 * editor for them. `PROJECTOR_DOC_URL` lets them say — configuration, exactly as
 * `PROJECTOR_JIRA_URL` names the Jira host — and until they do, the command is
 * the answer that always works.
 *
 *   PROJECTOR_DOC_URL='cursor://file{path}'
 *   PROJECTOR_DOC_URL='vscode://file{path}'
 *   PROJECTOR_DOC_URL='obsidian://open?path={path}'
 */
function openers(abs: string): { action?: { label: string; href: string }; command?: string } {
  // `open` is macOS's own "hand this to whatever owns it", which is the only
  // thing here that needs no configuration and no assumption about an editor.
  const template = process.env.PROJECTOR_DOC_URL?.trim();
  // A click beats a paste, and offering both would spend a line on the worse of
  // the two — the same either/or `claude:` already applies.
  if (template?.includes('{path}'))
    return { action: { label: 'open in editor', href: template.replace('{path}', encodeURI(abs)) } };
  return { command: `open ${abs.includes(' ') ? JSON.stringify(abs) : abs}` };
}

/**
 * Local markdown documents — the design docs that are the real artifacts of the
 * domain-owner work with no Jira ticket. Filesystem only.
 */
export function docFetcher(dataRoot: string): Fetcher {
  return {
    // Cheap enough to re-read whenever asked; mtime does the real caching.
    ttl: 30,
    async fetch(ref) {
      const { path, tried } = resolveDoc(ref, dataRoot);
      if (!path) {
        // Name what was tried: a relative doc ref resolves against the vault, so
        // a doc outside it needs `../`, and saying so beats "not found".
        return unavailable(`no file at ${ref} — looked in ${tried.join(', ')}`);
      }
      const st = statSync(path);

      const head = readFileSync(path, 'utf8').slice(0, 4000);
      const h1 = head.match(/^#\s+(.+)$/m)?.[1]?.trim();
      const firstProse = head
        .split(/\n\s*\n/)
        .map((b) => b.trim())
        .find((b) => b && !/^(#|>|\||```|<!--|\s*[-*]\s)/.test(b));

      return {
        label: ref.split('/').pop() ?? ref,
        title: h1 ?? firstLine(firstProse ?? '', 120),
        fields: [
          { k: 'size', v: `${Math.max(1, Math.round(st.size / 1024))} KB` },
          { k: 'modified', v: ago(st.mtime.toISOString()) },
          { k: 'lines', v: String(head.split('\n').length >= 200 ? '200+' : head.split('\n').length) },
        ],
        ...openers(path),
      } satisfies Enrichment;
    },
  };
}
