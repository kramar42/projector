import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { dataDir, paths } from '../config.ts';
import { loadFacets } from '../schema/facets.ts';
import { reindex } from '../index/indexer.ts';
import { resolveProject, parentsOf } from '../index/project.ts';
import { blockersOf, counts, groupBy, listRecords, unblocks, type Row } from '../index/queries.ts';
import { toDTO } from './dto.ts';
import { loadViews, type BoardView, type CanvasView } from './views.ts';

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
