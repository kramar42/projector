import { fromPayload, type IndexResult } from '../index/indexer.ts';

/**
 * Ask a live server for the vault's current stamp, and hydrate from the
 * persisted payload if it matches.
 *
 * Every `pj` is a fresh process, and computing the stamp itself means walking
 * the vault — cheap at note scale, the whole cost at workspace scale. A running
 * server is already watching the vault, so it can vouch for the persisted
 * index without anyone walking anything. The trust is exactly the watcher's:
 * between filesystem events the server assumes nothing changed, which is the
 * same assumption every open board already lives on. The CLI still verifies
 * the payload was built from the stamp the server named, `pj reindex` remains
 * exact, and anything at all wrong — no server, wrong vault, no payload,
 * stamp mismatch — falls back to the local walk without a message.
 *
 * `PROJECTOR_NO_DELEGATE=1` turns this off; `PROJECTOR_PORT` names the server.
 */
export async function delegatedIndex(root: string): Promise<IndexResult | null> {
  if (process.env.PROJECTOR_NO_DELEGATE) return null;
  const port = Number(process.env.PROJECTOR_PORT ?? 8092);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 250);
    const res = await fetch(`http://127.0.0.1:${port}/api/cli/stamp`, {
      headers: { 'X-Projector-Vault': root },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const { stamp } = (await res.json()) as { stamp?: string };
    if (!stamp) return null;
    return fromPayload(root, stamp);
  } catch {
    return null;
  }
}
