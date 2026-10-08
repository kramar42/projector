import {
  EMBED_PARAM,
  NOTE_PARAM,
  SEL_PARAM,
  apiSearch,
  isQueryParam,
  paramsOf,
  selectionOf,
} from './query.ts';

/**
 * The app inside someone else's frame.
 *
 * A host page can show projector in an `<iframe>` as one of three halves:
 * `?embed=view` (the shape alone), `?embed=sidebar` (the sidebar alone) or
 * `?embed=note` (the note panel alone, showing `?note=`). The halves talk
 * through the host: every change to the URL is posted up as a message, and the
 * host may post a navigation down. That is the whole protocol, and it is C9
 * read from outside — the URL is the view, so a host that holds the URL holds
 * the view, and several frames holding the *same* URL are the same view drawn
 * several ways. Nothing here knows what the host is.
 *
 * `?vault=`, `?embed=`, `?pins=` and the calendar page never travel: they say
 * how *this* window is looking. What goes up is the query (`apiSearch`), the
 * selection, and the open note; what comes down replaces exactly those and
 * nothing else. The open note travels because in an embedded shape a click on
 * a card must *not* slide the panel over the shape — the panel is its own
 * frame — so the shape reports which note was opened and the host puts it
 * where the panel is.
 */
export type Embed = 'view' | 'sidebar' | 'note';

export function embedOf(search: string): Embed | null {
  const v = paramsOf(search).get(EMBED_PARAM);
  return v === 'view' || v === 'sidebar' || v === 'note' ? v : null;
}

/** Posted up: the query half of the URL (no leading `?`), the selected ids, the open note. */
export interface EmbedQuery {
  projector: 'query';
  search: string;
  sel: string[];
  note: string | null;
}

/** Posted down: a query, a selection and/or an open note. Any may be omitted; `null` closes. */
export interface EmbedNavigate {
  projector: 'navigate';
  search?: string;
  sel?: string[];
  note?: string | null;
}

export function postEmbedQuery(search: string): void {
  if (typeof window === 'undefined' || !embedOf(search) || window.parent === window) return;
  const message: EmbedQuery = {
    projector: 'query',
    search: apiSearch(search).replace(/^\?/, ''),
    sel: [...selectionOf(search)],
    note: paramsOf(search).get(NOTE_PARAM),
  };
  // `*`: the host's origin is whatever it is — a blob: document, a workspace on
  // another port — and this message holds a query string, not a secret.
  window.parent.postMessage(message, '*');
}

/**
 * Posted up: a link with nowhere on the web to go, offered to the host.
 *
 * A `bb:` thread, a `claude:` session or a `workspace:` directory has no href,
 * and outside a frame the row shows a command to copy. Inside one, the host may
 * own the thing — bb knows its threads — so the click is handed up as the link's
 * kind and ref. The host decides; one that does not know the kind ignores it,
 * which is the same as the click not existing.
 */
export interface EmbedOpen {
  projector: 'open';
  kind: string;
  ref: string;
}

export function postEmbedOpen(kind: string, ref: string): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  const message: EmbedOpen = { projector: 'open', kind, ref };
  // `*` for the reason above: a link ref, not a secret.
  window.parent.postMessage(message, '*');
}

/** Our search with the query params replaced by the message's and the selection set from it. */
export function mergeEmbedNavigate(search: string, msg: EmbedNavigate): string {
  const params = paramsOf(search);
  if (msg.search !== undefined) {
    for (const key of [...params.keys()]) if (isQueryParam(key)) params.delete(key);
    for (const [key, value] of new URLSearchParams(msg.search.replace(/^\?/, '')))
      if (isQueryParam(key)) params.set(key, value);
  }
  if (msg.sel !== undefined) {
    if (msg.sel.length) params.set(SEL_PARAM, msg.sel.join(','));
    else params.delete(SEL_PARAM);
  }
  if (msg.note !== undefined) {
    if (msg.note) params.set(NOTE_PARAM, msg.note);
    else params.delete(NOTE_PARAM);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function onEmbedNavigate(handler: (msg: EmbedNavigate) => void): () => void {
  const listener = (ev: MessageEvent) => {
    const d = ev.data as Partial<EmbedNavigate> | null;
    if (!d || d.projector !== 'navigate') return;
    handler({ projector: 'navigate', search: d.search, sel: d.sel, note: d.note });
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
