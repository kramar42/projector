/** The small part of `EventSource` the shared browser event hub needs. */
export interface EventStream {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}
/**
 * Multiplex all live readers over one server event stream.
 *
 * An EventSource is a permanent HTTP request. Opening one in every `useLive`
 * instance worked with a panel and failed in a spread: enough pinned pages use
 * every HTTP/1 connection the browser permits for an origin, so the note fetches
 * wait behind requests that intentionally never finish. The hub spends one
 * connection regardless of how many notes are mounted and closes it when the
 * last listener leaves.
 *
 * The opener is injected because connection ownership is the behavior worth a
 * browser-free regression test; parsing an event remains each subscriber's job.
 */
export function createEventHub(open: () => EventStream): {
  subscribe: (type: string, listener: (event: MessageEvent<string>) => void) => () => void;
} {
  let stream: EventStream | null = null;
  const listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  const wired = new Set<string>();

  const ensure = (): EventStream => {
    stream ??= open();
    return stream;
  };

  return {
    subscribe(type, listener) {
      let group = listeners.get(type);
      if (!group) {
        group = new Set();
        listeners.set(type, group);
      }
      group.add(listener);

      const source = ensure();
      if (!wired.has(type)) {
        wired.add(type);
        source.addEventListener(type, (event) => {
          for (const current of [...(listeners.get(type) ?? [])]) current(event);
        });
      }

      let on = true;
      return () => {
        if (!on) return;
        on = false;
        const current = listeners.get(type);
        current?.delete(listener);
        if (current?.size === 0) listeners.delete(type);
        if (listeners.size) return;
        stream?.close();
        stream = null;
        wired.clear();
      };
    },
  };
}
