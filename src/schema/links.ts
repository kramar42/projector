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

/**
 * Where a link opens, from the ref alone.
 *
 * The sibling of `fallbackLabel`, and it exists for the same reason: a link's
 * *identity* must not depend on a fetcher. It did — the panel made a label
 * clickable only when enrichment supplied a `url`, so a Slack permalink, which
 * needs no fetcher and never gets one, rendered as dead text with the full URL
 * repeated underneath it. The URL was in the ref the whole time.
 *
 * Six of the eight kinds resolve here, and none of them ever needed a network
 * call to do it — a fetcher adds a title, a status and a diff size, never the
 * ability to click. The two that return `null` are the two that genuinely have
 * nowhere on the web to go:
 *
 * - `claude` is a session on this machine. It has an app deep link and a
 *   `--resume` command, which is what its fetcher supplies.
 * - `doc` is a file in the vault, not a URL at all.
 *
 * `jiraBase` is configuration rather than a fetch (`PROJECTOR_JIRA_URL`), so it
 * is passed in and this stays pure. Without it a Jira ref has no href, which is
 * honest: there is no host to point at.
 */
export function fallbackHref(link: Link, jiraBase?: string | null): string | null {
  switch (link.kind) {
    // The ref *is* the URL. Slack needs no special case beyond this: its refs
    // are ordinary permalinks, and opening one in a browser is what hands it to
    // the Slack app. Synthesising a `slack://` deep link would need a team id
    // the permalink does not carry.
    case 'slack':
    case 'url':
      return /^https?:\/\//.test(link.ref) ? link.ref : null;

    case 'jira':
      return jiraBase ? `${jiraBase.replace(/\/+$/, '')}/browse/${link.ref}` : null;

    case 'gh:pr': {
      const m = link.ref.match(/^([^#]+)#(\d+)$/);
      return m ? `https://github.com/${m[1]}/pull/${m[2]}` : null;
    }
    case 'gh:branch':
    case 'gh:commit': {
      const at = link.ref.lastIndexOf('@');
      if (at <= 0 || at === link.ref.length - 1) return null;
      const repo = link.ref.slice(0, at);
      const rev = link.ref.slice(at + 1);
      return `https://github.com/${repo}/${link.kind === 'gh:commit' ? 'commit' : 'tree'}/${rev}`;
    }

    case 'claude':
    case 'doc':
      return null;

    default:
      // An unknown prefix is still information (see `parseLink`), and if what
      // follows happens to be a URL it is still a place to go.
      return /^https?:\/\//.test(link.ref) ? link.ref : null;
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
