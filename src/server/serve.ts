import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dataDir, paths } from '../config.ts';
import { loadFacets } from '../schema/facets.ts';
import { reindex } from '../index/indexer.ts';
import { resolveProject, parentsOf } from '../index/project.ts';
import { blockersOf, counts, groupBy, listRecords, unblocks, type Row } from '../index/queries.ts';
import { toDTO } from './dto.ts';
import { loadViews, type BoardView, type CanvasView } from './views.ts';
import {
  Conflict,
  Invalid,
  bulkDelete,
  bulkFacet,
  bulkParent,
  createCard,
  deleteCard,
  fileFor,
  mtimeOf,
  patchCard,
  saveAsset,
  saveCanvas,
  setEdges,
} from './mutate.ts';
import { watch } from 'chokidar';
import { streamSSE } from 'hono/streaming';
import type { Edge } from '../schema/types.ts';

const PORT = Number(process.env.COCKPIT_PORT ?? 8092);
const root = dataDir();
const p = paths(root);

/** Origins allowed to send a mutating request. A localhost server is still
 *  reachable from any page open in the browser, so an Origin that is present
 *  must be one of ours. A request with no Origin at all (curl) is unaffected. */
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, 'http://localhost:5176']);

/**
 * Everything is read from the files on each request. At this scale a full
 * reindex is milliseconds, and it means the app can never disagree with what an
 * agent just wrote — no cache to invalidate, no staleness to reason about.
 */
function load() {
  const facets = loadFacets(p.facets);
  const { db, records } = reindex(root);
  const views = loadViews(p.boards, p.canvases);
  return { facets, db, records, views };
}

const app = new Hono();

app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin');
    if (origin && !ORIGINS.has(origin)) return c.json({ error: 'origin not allowed' }, 403);
  }
  await next();
});

app.get('/api/meta', (c) => {
  const { facets, db, views } = load();
  return c.json({
    dataDir: root,
    facets,
    counts: counts(db),
    views: views.map((v) => ({ kind: v.kind, name: v.name, title: v.title })),
  });
});

app.get('/api/board/:name', (c) => {
  const { facets, db, records, views } = load();
  const view = views.find((v) => v.kind === 'board' && v.name === c.req.param('name')) as
    | BoardView
    | undefined;
  if (!view) return c.json({ error: 'no such board' }, 404);

  // `blockedBy: none` is computed, not stored — the deterministic half of C8.
  const wantsUnblocked = view.filter?.blockedBy === 'none';
  const facetFilter = Object.fromEntries(
    Object.entries(view.filter ?? {}).filter(([k, v]) => k !== 'blockedBy' && Array.isArray(v)),
  ) as Record<string, string[]>;

  let rows = listRecords(db, { filter: facetFilter, includeNodes: false });
  if (wantsUnblocked) rows = rows.filter((r) => blockersOf(db, r.id).every((b) => b.done));

  const groups = groupBy(db, rows, view.groupBy, facets);
  const shown = view.uncategorised === 'hide' ? groups.filter((g) => g.value !== '(none)') : groups;

  const dto = (row: Row) => {
    const rec = records.get(row.id)!;
    return toDTO(rec, records, {
      childCount: countChildren(records, row.id),
      blockedBy: blockersOf(db, row.id),
      unblocks: unblocks(db, row.id).map((u) => u.id),
    });
  };

  return c.json({
    view,
    groups: shown.map((g) => ({ value: g.value, cards: g.rows.map(dto) })),
    total: rows.length,
    placements: shown.reduce((n, g) => n + g.rows.length, 0),
  });
});

app.get('/api/canvas/:name', (c) => {
  const { db, records, views } = load();
  const view = views.find((v) => v.kind === 'canvas' && v.name === c.req.param('name')) as
    | CanvasView
    | undefined;
  if (!view) return c.json({ error: 'no such canvas' }, 404);

  const include = view.include ?? {};
  let ids = new Set<string>();

  if (include.under) {
    // Everything at any depth beneath a record, plus the record itself.
    for (const rec of records.values()) {
      if (rec.id === include.under || isBeneath(records, rec.id, include.under)) ids.add(rec.id);
    }
  } else if (include.filter) {
    for (const row of listRecords(db, { filter: include.filter, includeNodes: true })) ids.add(row.id);
  } else {
    for (const id of records.keys()) ids.add(id);
  }
  for (const id of include.explicit ?? []) if (records.has(id)) ids.add(id);

  // Pull in every ancestor of an included record. A filtered canvas selects
  // cards, but their parents give the tree its shape — without them each edge
  // points outside the set and the graph renders as scattered orphans.
  if (include.ancestors !== false) {
    for (const id of [...ids]) {
      let frontier = [id];
      const seen = new Set<string>([id]);
      while (frontier.length) {
        const next: string[] = [];
        for (const cur of frontier) {
          for (const pid of parentsOf(records.get(cur)!)) {
            if (!records.has(pid) || seen.has(pid)) continue;
            seen.add(pid);
            ids.add(pid);
            next.push(pid);
          }
        }
        frontier = next;
      }
    }
  }

  const show = new Set(view.edges?.show ?? ['parent', 'blocks']);
  const nodes = [...ids]
    .map((id) => records.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((rec) =>
      toDTO(rec, records, {
        childCount: countChildren(records, rec.id),
        blockedBy: blockersOf(db, rec.id),
        unblocks: unblocks(db, rec.id).map((u) => u.id),
      }),
    );

  const edges: { src: string; dst: string; type: string }[] = [];
  for (const id of ids) {
    const rec = records.get(id);
    if (!rec) continue;
    for (const e of rec.edges) {
      if (!show.has(e.type) || !ids.has(e.to)) continue;
      edges.push({ src: id, dst: e.to, type: e.type });
    }
  }

  return c.json({ view, nodes, edges, stored: view.nodes ?? {} });
});

app.get('/api/card/:id', (c) => {
  const { db, records } = load();
  const rec = records.get(c.req.param('id'));
  if (!rec) return c.json({ error: 'no such card' }, 404);
  const project = resolveProject(rec.id, records, root);
  return c.json({
    card: toDTO(rec, records, {
      childCount: countChildren(records, rec.id),
      blockedBy: blockersOf(db, rec.id),
      unblocks: unblocks(db, rec.id).map((u) => u.id),
    }),
    file: relative(root, rec.file),
    // The client sends this back on a write; a mismatch means an agent or an
    // editor changed the file meanwhile, and the write is refused (409).
    mtime: mtimeOf(rec.file),
    parents: parentsOf(rec)
      .map((id) => records.get(id))
      .filter((r) => r)
      .map((r) => ({ id: r!.id, title: r!.title })),
    children: [...records.values()]
      .filter((r) => parentsOf(r).includes(rec.id))
      .map((r) => ({ id: r.id, title: r.title, kind: r.kind })),
    project,
  });
});

function countChildren(records: Map<string, ReturnType<typeof Object>>, id: string): number {
  let n = 0;
  for (const rec of (records as Map<string, { edges: { type: string; to: string }[] }>).values()) {
    if (rec.edges.some((e) => e.type === 'parent' && e.to === id)) n++;
  }
  return n;
}

function isBeneath(
  records: Map<string, { edges: { type: string; to: string }[] }>,
  id: string,
  ancestor: string,
): boolean {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const rec = records.get(cur);
    if (!rec) continue;
    for (const e of rec.edges) {
      if (e.type !== 'parent') continue;
      if (e.to === ancestor) return true;
      stack.push(e.to);
    }
  }
  return false;
}

// ---------------------------------------------------------------- writes
//
// Every mutating route lives here and does nothing but delegate to mutate.ts.
// There is still no path to any external system: these write card files, canvas
// files and assets under the data directory, and nothing else.

function fail(c: Context, err: unknown) {
  if (err instanceof Conflict) {
    return c.json({ error: 'file changed on disk', mtime: err.mtime, conflict: true }, 409);
  }
  if (err instanceof Invalid) return c.json({ error: (err as Error).message }, 400);
  return c.json({ error: (err as Error).message }, 500);
}

app.patch('/api/card/:id', async (c) => {
  try {
    const body = (await c.req.json()) as Parameters<typeof patchCard>[2];
    const res = patchCard(root, c.req.param('id'), body);
    bump();
    return c.json(res);
  } catch (err) {
    return fail(c, err);
  }
});

app.post('/api/card', async (c) => {
  try {
    const body = (await c.req.json()) as Parameters<typeof createCard>[1];
    const res = createCard(root, body);
    bump();
    return c.json(res, 201);
  } catch (err) {
    return fail(c, err);
  }
});

app.delete('/api/card/:id', (c) => {
  try {
    const res = deleteCard(root, c.req.param('id'));
    bump();
    return c.json(res);
  } catch (err) {
    return fail(c, err);
  }
});

app.put('/api/card/:id/edges', async (c) => {
  try {
    const body = (await c.req.json()) as { edges: Edge[]; baseMtime?: number };
    const res = setEdges(root, c.req.param('id'), body.edges ?? [], body.baseMtime);
    bump();
    return c.json(res);
  } catch (err) {
    return fail(c, err);
  }
});

app.post('/api/bulk', async (c) => {
  try {
    const b = (await c.req.json()) as {
      ids: string[];
      op: 'facet' | 'parent' | 'delete';
      facet?: string;
      values?: string[];
      mode?: 'set' | 'add' | 'remove';
      parent?: string | null;
    };
    const ids = b.ids ?? [];
    let res: unknown;
    if (b.op === 'facet') res = bulkFacet(root, ids, b.facet!, b.values ?? [], b.mode ?? 'set');
    else if (b.op === 'parent') res = bulkParent(root, ids, b.parent ?? null);
    else if (b.op === 'delete') res = bulkDelete(root, ids);
    else throw new Invalid(`unknown bulk op "${String(b.op)}"`);
    bump();
    return c.json(res as object);
  } catch (err) {
    return fail(c, err);
  }
});

app.patch('/api/canvas/:name', async (c) => {
  try {
    const body = (await c.req.json()) as {
      nodes: Record<string, { x?: number; y?: number; size?: string }>;
    };
    saveCanvas(root, c.req.param('name'), body.nodes ?? {});
    bump();
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

app.post('/api/card/:id/asset', async (c) => {
  try {
    const id = c.req.param('id');
    fileFor(root, id); // 400s cleanly when the card does not exist
    const mime = c.req.header('Content-Type') ?? '';
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (!bytes.length) throw new Invalid('empty upload');
    const res = saveAsset(root, id, mime.split(';')[0]!.trim(), bytes);
    return c.json(res, 201);
  } catch (err) {
    return fail(c, err);
  }
});

// Pasted images are referenced from a card body, so the body renderer needs them.
app.get('/api/asset/*', (c) => {
  const rel = c.req.path.replace('/api/asset/', '');
  // Confine to the assets tree: a card body is authored content, and a `..` in
  // an image path must not be able to read outside the data directory.
  const file = join(p.assets, rel.replace(/^assets\//, ''));
  if (!file.startsWith(p.assets) || !existsSync(file)) return c.json({ error: 'not found' }, 404);
  const ext = file.split('.').pop() ?? '';
  const type =
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[
      ext
    ] ?? 'application/octet-stream';
  return new Response(readFileSync(file), { headers: { 'Content-Type': type } });
});

// ---------------------------------------------------------------- live updates
//
// The point of the watcher is C3: a Claude session editing a card file must show
// up in the open app without a manual refresh.

let revision = 0;
const listeners = new Set<(rev: number) => void>();

function bump() {
  revision++;
  for (const fn of [...listeners]) fn(revision);
}

watch([p.cards, p.views, p.facets], {
  ignoreInitial: true,
  ignored: (path: string) => path.includes('.tmp-') || path.endsWith('.index.db'),
  awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
}).on('all', () => bump());

app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    let alive = true;
    const send = (rev: number) => {
      void stream.writeSSE({ event: 'change', data: String(rev) });
    };
    listeners.add(send);
    await stream.writeSSE({ event: 'hello', data: String(revision) });
    stream.onAbort(() => {
      alive = false;
      listeners.delete(send);
    });
    // Hold the connection open; a heartbeat keeps intermediaries from closing it.
    while (alive) {
      await stream.sleep(25000);
      if (alive) await stream.writeSSE({ event: 'ping', data: String(revision) });
    }
  }),
);

// Built UI, when present. Single-port production mode.
const dist = new URL('../../dist/', import.meta.url).pathname;
if (existsSync(dist)) {
  app.use('/assets/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, (info) => {
  console.log(`cockpit  http://127.0.0.1:${info.port}`);
  console.log(`data     ${root}`);
  if (!existsSync(dist)) console.log(`ui       not built — run \`pnpm dev:web\` for the dev server`);
});
