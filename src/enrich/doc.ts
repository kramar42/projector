import { existsSync, readFileSync, statSync } from 'node:fs';
import { ago, firstLine } from './run.ts';
import { unavailable, type Enrichment, type Fetcher } from './types.ts';
import { resolvePath } from '../config.ts';

/**
 * Local markdown documents — the design docs that are the real artifacts of the
 * domain-owner work with no Jira ticket. Filesystem only.
 */
export function docFetcher(dataRoot: string): Fetcher {
  return {
    // Cheap enough to re-read whenever asked; mtime does the real caching.
    ttl: 30,
    async fetch(ref) {
      const path = resolvePath(ref, dataRoot);
      if (!existsSync(path)) return unavailable(`no file at ${ref}`);
      const st = statSync(path);
      if (st.isDirectory()) return unavailable(`${ref} is a directory`);

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
      } satisfies Enrichment;
    },
  };
}
