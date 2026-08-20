import type { Link } from './types.ts';

/**
 * Link kinds the resolver understands. Everything here is read-only by
 * construction (C2): a kind is a way to *display* a remote thing, never to
 * write one.
 *
 * A kind earns its place by being *resolvable* — either something fetches it
 * (see `src/enrich/registry.ts`) or it opens somewhere the app knows about.
 * A kind that only ever renders its own text is a `url` with extra vocabulary,
 * which is why `cal`, `grafana` and `trello` are gone: the first two never had
 * a fetcher, and `trello` was import provenance, which is the `source` facet's
 * job.
 */
export const LINK_KINDS = [
  'jira',
  'gh:pr',
  'gh:branch',
  'gh:commit',
  'claude',
  'doc',
  'slack',
  'url',
] as const;

export type LinkKind = (typeof LINK_KINDS)[number];

const PREFIXED = ['gh:pr', 'gh:branch', 'gh:commit', 'jira', 'claude', 'doc', 'slack'];

/**
 * Parse a link string into kind and ref. A bare URL becomes kind `url`.
 * An unrecognised prefix yields kind `''`, which `check` reports as a warning
 * rather than dropping — an unknown link is still information.
 */
export function parseLink(raw: string): Link {
  const s = raw.trim();
  for (const kind of PREFIXED) {
    if (s.startsWith(kind + ':')) return { kind, ref: s.slice(kind.length + 1), raw: s };
  }
  if (/^https?:\/\//.test(s)) return { kind: 'url', ref: s, raw: s };
  return { kind: '', ref: s, raw: s };
}

export function isKnownKind(kind: string): boolean {
  return (LINK_KINDS as readonly string[]).includes(kind);
}

/** A stable human label used before a fetcher has cached anything (P3). */
export function fallbackLabel(link: Link): string {
  switch (link.kind) {
    case 'jira':
      return link.ref;
    case 'gh:pr':
      return link.ref.replace(/^.*\//, '') + ' (PR)';
    case 'gh:branch':
    case 'gh:commit':
      return link.ref.split('@').pop() ?? link.ref;
    case 'claude':
      return 'session ' + link.ref.slice(-6);
    case 'doc':
      return link.ref.split('/').pop() ?? link.ref;
    case 'slack':
    case 'url':
      return shortUrl(link.ref);
    default:
      return link.ref;
  }
}

/** host + last meaningful segment. A full URL is a reference, not a label. */
function shortUrl(ref: string): string {
  try {
    const u = new URL(ref);
    const host = u.hostname.replace(/^www\./, '');
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? `${host}/${seg.slice(0, 14)}` : host;
  } catch {
    return ref;
  }
}
