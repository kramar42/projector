import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import {
  browse,
  forgetVault,
  initVault,
  isRegistered,
  listVaults,
  looksLikeVault,
  countCards,
  normalise,
  registerVault,
  suggestName,
  touchVault,
} from '../vault.ts';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { split } from '../schema/frontmatter.ts';
import { join, relative } from 'node:path';
import { paths } from '../config.ts';
import { loadFacets } from '../schema/facets.ts';
import { reindex } from '../index/indexer.ts';
import { cached, invalidate } from '../index/cache.ts';
import { kindOf, projectRecords, resolveProject, parentsOf } from '../index/project.ts';
import type { Facets, Rec } from '../schema/types.ts';
import { blockersOf, counts, unblocks } from '../index/queries.ts';
import { toDTO } from './dto.ts';
import { loadViews, viewFileFor, findView } from './views.ts';
import { memberEdges, projectRollups, runQuery } from '../index/query.ts';
import { parseSpec, specToFile, specToParams, type ViewSpec } from '../view/spec.ts';
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
  putFrontmatter,
  saveArrangement,
  saveView,
  deleteView,
  setEdges,
} from './mutate.ts';
import { watch } from 'chokidar';
import { clearEnrichment, enrichmentStats, readCached, refresh } from './enrich.ts';
import { SEED_FACETS, SEED_README, SEED_VIEWS } from './seed.ts';
import { streamSSE } from 'hono/streaming';
import type { Edge } from '../schema/types.ts';

const PORT = Number(process.env.COCKPIT_PORT ?? 8092);

/** Origins allowed to send a mutating request. A localhost server is still
 *  reachable from any page open in the browser, so an Origin that is present
 *  must be one of ours. A request with no Origin at all (curl) is unaffected. */
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, 'http://localhost:5176']);

/**
 * The vault a request is about.
 *
 * The browser names it with `X-Cockpit-Vault`, and it must already be
 * registered — the registry is what keeps this from being "read any directory
 * the page asks for". Registering happens through the vault endpoints, which is
 * where a path is checked and, if the user asked, initialised.
 */
class NoVault extends Error {}

function vaultOf(c: Context): string {
  const header = c.req.header('X-Cockpit-Vault');
  if (header) {
    const want = normalise(header);
    if (!isRegistered(want)) throw new NoVault(`vault not registered: ${want}`);
    if (!existsSync(want)) throw new NoVault(`vault directory is missing: ${want}`);
    ensureWatched(want);
    return want;
  }
  // No header: fall back only when the choice is unambiguous.
  const known = listVaults().filter((v) => v.exists);
  if (known.length === 1) {
    ensureWatched(known[0]!.path);
    return known[0]!.path;
  }
  throw new NoVault(known.length ? 'pick a vault' : 'no vault has been opened yet');
}

function build(root: string) {
  const p = paths(root);
  const facets = loadFacets(p.facets);
  const { db, records } = reindex(root);
  const views = loadViews(root);
  return { facets, db, records, views, p };
}

/**
 * Everything is read from the files, and re-read the moment any of them changes.
 * The memo is keyed on an exact stamp of those files rather than a TTL, so the
 * app still cannot disagree with what an agent just wrote — see `index/cache.ts`
 * for why P5 needs it at all. Disposing the superseded handle also closes a
 * `DatabaseSync` that P0–P4 leaked once per request.
 *
 * Callers must not `await` between this and their last read of what it returns.
 */
function load(root: string) {
  return cached(root, build, ({ db }) => db.close());
}

const app = new Hono();

app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin');
    if (origin && !ORIGINS.has(origin)) return c.json({ error: 'origin not allowed' }, 403);
  }
  await next();
});

/**
 * A request naming no usable vault is not a failure of the app; it means the
 * client has to choose one. 428 says exactly that, so the UI shows the picker
 * instead of an error. This has to be `onError` rather than a try around
 * `next()`: a synchronous throw inside a handler never reaches the middleware.
 */
app.onError((err, c) => {
  if (err instanceof NoVault) {
    return c.json({ error: err.message, needsVault: true }, 428);
  }
  return c.json({ error: err.message }, 500);
});

// ---------------------------------------------------------------- vaults
//
// A vault is a folder of cards, opened the way Obsidian opens one. Nothing here
// assumes a location or a directory name.

app.get('/api/vaults', (c) => c.json({ vaults: listVaults() }));

app.get('/api/vaults/browse', (c) => {
  try {
    return c.json(browse(c.req.query('path') ?? ''));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Inspect a path before committing to it, so the picker can say what will happen. */
app.get('/api/vaults/inspect', (c) => {
  const given = c.req.query('path') ?? '';
  if (!given.trim()) return c.json({ error: 'path is required' }, 400);
  const path = normalise(given);
  const exists = existsSync(path);
  return c.json({
    path,
    exists,
    isVault: exists && looksLikeVault(path),
    cards: exists && looksLikeVault(path) ? countCards(path) : 0,
    empty: exists ? readdirSync(path).filter((f) => !f.startsWith('.')).length === 0 : true,
    suggestedName: suggestName(path),
    registered: isRegistered(path),
  });
});

/** Open a folder as a vault, creating the skeleton when asked. */
app.post('/api/vaults', async (c) => {
  try {
    const body = (await c.req.json()) as { path?: string; name?: string; create?: boolean };
    if (!body.path?.trim()) return c.json({ error: 'path is required' }, 400);
    const path = normalise(body.path);

    if (!looksLikeVault(path)) {
      if (!body.create) {
        return c.json(
          {
            error: existsSync(path)
              ? `${path} is not a vault — pass create to set one up there`
              : `${path} does not exist — pass create to make it a vault`,
            needsCreate: true,
            path,
          },
          409,
        );
      }
      initVault(path, SEED_FACETS, SEED_README, SEED_VIEWS);
    }
    const entry = registerVault(path, body.name);
    ensureWatched(entry.path);
    return c.json({ vault: entry }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Forget a vault. The folder is left exactly as it is. */
app.delete('/api/vaults', async (c) => {
  try {
    const body = (await c.req.json()) as { path?: string };
    if (!body.path?.trim()) return c.json({ error: 'path is required' }, 400);
    const removed = forgetVault(body.path);
    return c.json({ forgotten: removed });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get('/api/meta', (c) => {
  const root = vaultOf(c);
  touchVault(root);
  const { facets, db, views, records } = load(root);
  return c.json({
    vault: root,
    vaultName: listVaults().find((v) => v.path === root)?.name ?? root,
    facets: withDynamicValues(facets, records),
    counts: counts(db),
    enrichment: enrichmentStats(root),
    views: views.map((v) => ({ name: v.name, title: v.title, shape: v.shape })),
  });
});

/**
 * A request's view: the saved one it names, with every other parameter overriding.
 *
 * Merged at the *parameter* level rather than the object level, so an override is
 * a plain string swap and `f.status=` can mean "no status filter" over a saved
 * view that had one. Shared with the save route, so *save current as…* stores
 * exactly what is on screen rather than a second interpretation of it.
 */
function resolveSpec(root: string, url: string): ViewSpec | { error: string } {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const saved = params.view ? findView(root, params.view) : undefined;
  if (params.view && !saved) return { error: `no view "${params.view}"` };

  const spec: ViewSpec = parseSpec(saved ? { ...specToParams(saved), ...params } : params);
  spec.name = saved?.name;
  spec.title = saved?.title;
  // Arrangement is never a query parameter: it comes from the file or nowhere.
  spec.nodes = saved?.nodes;
  spec.order = saved?.order;
  return spec;
}

/**
 * The one read endpoint (C9).
 *
 * A saved view named in `view=` supplies the defaults; every other parameter
 * overrides it, which is exactly what the sidebar does as you touch a control.
 * So a saved view and an ad-hoc query are the same request, and there is one
 * engine behind both — P1's two endpoints had drifted into two, which is how
 * four of the eight board keys came to be declared and never read.
 */
app.get('/api/query', (c) => {
  const root = vaultOf(c);
  const { facets, db, records, views } = load(root);

  const spec = resolveSpec(root, c.req.url);
  if ('error' in spec) return c.json({ error: spec.error }, 404);

  const res = runQuery(db, records, facets, spec.query);

  const shown = [...res.ids, ...res.context];
  const cards: Record<string, ReturnType<typeof toDTO>> = {};
  for (const id of shown) {
    const rec = records.get(id);
    if (!rec) continue;
    cards[id] = toDTO(rec, records, {
      childCount: countChildren(records, id),
      blockedBy: blockersOf(db, id),
      unblocks: unblocks(db, id).map((u) => u.id),
    });
  }

  return c.json({
    spec,
    // Keyed by id, because a card in three columns is one card. P1 embedded the
    // whole card per group and shipped it three times.
    cards,
    ids: res.ids,
    context: res.context,
    groups: res.groups,
    axis: res.axis,
    lanes: res.lanes,
    counts: res.counts,
    total: res.total,
    universe: res.universe,
    placements: res.placements,
    edges: edgesAmong(records, new Set(shown), spec.edges),
    // Only a table asks for these, but they are cheap and deriving them here
    // keeps every number on screen deterministic (C8).
    rollups: projectRollups(records, new Date().toISOString().slice(0, 10)),
    views: views.map((v) => ({ name: v.name, title: v.title, shape: v.shape })),
  });
});

/**
 * Edges of the requested types with both ends on screen. `member-of` is derived
 * from the `project` facet here and nowhere else, so nothing has to be stored for
 * the project hierarchy to be drawable (C9).
 */
function edgesAmong(
  records: Map<string, Rec>,
  ids: Set<string>,
  show: string[],
): { src: string; dst: string; type: string }[] {
  const want = new Set(show);
  const out: { src: string; dst: string; type: string }[] = [];
  for (const id of ids) {
    const rec = records.get(id);
    if (!rec) continue;
    for (const e of rec.edges) {
      if (!want.has(e.type) || !ids.has(e.to)) continue;
      out.push({ src: id, dst: e.to, type: e.type });
    }
  }
  if (want.has('member-of')) {
    for (const e of memberEdges(records)) {
      if (ids.has(e.src) && ids.has(e.dst)) out.push({ ...e, type: 'member-of' });
    }
  }
  return out;
}

app.get('/api/card/:id', (c) => {
  const root = vaultOf(c);
  const { db, records } = load(root);
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
      .map((r) => ({ id: r.id, title: r.title, kind: kindOf(r) })),
    project,
  });
});

/**
 * Fill in the values of any facet that sources its vocabulary from the data.
 *
 * `project` offers every record carrying a `project:` block, so a project just
 * created is immediately offerable rather than only once something uses it. This
 * is vocabulary only — the facet is stored and written like any other.
 */
function withDynamicValues(facets: Facets, records: Map<string, Rec>): Facets {
  const out: Facets = {};
  for (const [name, def] of Object.entries(facets)) {
    if (def.valuesFrom !== 'project-records') {
      out[name] = def;
      continue;
    }
    const keys = [...projectRecords(records).keys()].sort();
    out[name] = { ...def, values: [...new Set([...def.values, ...keys])] };
  }
  return out;
}

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
  const root = vaultOf(c);
  try {
    const body = (await c.req.json()) as Parameters<typeof patchCard>[2];
    const res = patchCard(root, c.req.param('id'), body);
    bump(root);
    return c.json(res);
  } catch (err) {
    return fail(c, err);
  }
});

app.post('/api/card', async (c) => {
  const root = vaultOf(c);
  try {
    const body = (await c.req.json()) as Parameters<typeof createCard>[1];
    const res = createCard(root, body);
    bump(root);
    return c.json(res, 201);
  } catch (err) {
    return fail(c, err);
  }
});

app.delete('/api/card/:id', (c) => {
  const root = vaultOf(c);
  try {
    const res = deleteCard(root, c.req.param('id'));
    bump(root);
    return c.json(res);
  } catch (err) {
    return fail(c, err);
  }
});

app.put('/api/card/:id/edges', async (c) => {
  const root = vaultOf(c);
  try {
    const body = (await c.req.json()) as { edges: Edge[]; baseMtime?: number };
    const res = setEdges(root, c.req.param('id'), body.edges ?? [], body.baseMtime);
    bump(root);
    return c.json(res);
  } catch (err) {
    return fail(c, err);
  }
});

app.post('/api/bulk', async (c) => {
  const root = vaultOf(c);
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
    bump(root);
    return c.json(res as object);
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * Arrangement for a saved view: node positions, card order within a column.
 *
 * Both merge rather than replace — the client sends only what it currently
 * renders, and from P5 that is a filtered subset.
 */
app.patch('/api/view/:name/arrangement', async (c) => {
  const root = vaultOf(c);
  try {
    const body = (await c.req.json()) as {
      nodes?: Record<string, { x?: number; y?: number }>;
      order?: Record<string, string[]>;
    };
    saveArrangement(root, c.req.param('name'), { nodes: body.nodes, order: body.order });
    bump(root);
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * *Save current as…*, and updating a saved view in place — the same call.
 *
 * The query travels in the URL, exactly as it does for a read, so what gets
 * written is what was on screen. Arrangement already in the file is preserved:
 * saving a changed query over a name keeps its positions rather than discarding
 * them.
 */
app.put('/api/view/:name', async (c) => {
  const root = vaultOf(c);
  try {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    const spec = resolveSpec(root, c.req.url);
    if ('error' in spec) return c.json({ error: spec.error }, 404);
    const name = c.req.param('name');
    const res = saveView(root, name, specToFile(spec, body.title?.trim() || spec.title || name));
    bump(root);
    return c.json(res, 201);
  } catch (err) {
    return fail(c, err);
  }
});

app.delete('/api/view/:name', (c) => {
  const root = vaultOf(c);
  try {
    deleteView(root, c.req.param('name'));
    bump(root);
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * Raw frontmatter, so the app can never express less than the file.
 *
 * The UI will never model every key — repos, branch templates, whatever comes
 * next — and the file is the source of truth, so there has to be a way to edit
 * it directly. The write validates first and refuses rather than
 * saving something the indexer would then reject.
 */
app.get('/api/card/:id/frontmatter', (c) => {
  const root = vaultOf(c);
  try {
    const file = fileFor(root, c.req.param('id'));
    const { yaml } = split(readFileSync(file, 'utf8'));
    return c.json({ yaml: yaml ?? '', mtime: mtimeOf(file) });
  } catch (err) {
    return fail(c, err);
  }
});

app.put('/api/card/:id/frontmatter', async (c) => {
  const root = vaultOf(c);
  try {
    const body = (await c.req.json()) as { yaml: string; baseMtime?: number };
    const res = putFrontmatter(root, c.req.param('id'), body.yaml ?? '', body.baseMtime);
    bump(root);
    return c.json(res);
  } catch (err) {
    return fail(c, err);
  }
});

app.post('/api/card/:id/asset', async (c) => {
  const root = vaultOf(c);
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
  const root = vaultOf(c);
  const p = paths(root);
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

// ---------------------------------------------------------------- enrichment
//
// Strictly additive. A view never waits on it: the endpoint answers from cache,
// schedules whatever is missing or stale, and signals when that lands. If every
// fetcher failed, cards would render exactly as they did before P3.

app.post('/api/enrich', async (c) => {
  const root = vaultOf(c);
  try {
    const body = (await c.req.json()) as { refs?: unknown; force?: boolean };
    if (body.refs !== undefined && !Array.isArray(body.refs)) {
      return c.json({ error: 'refs must be an array of link strings' }, 400);
    }
    const refs = (body.refs ?? []).filter((r): r is string => typeof r === 'string' && !!r);
    if (!refs.length) return c.json({ items: [] });
    const opts = { dataRoot: root, onRefreshed: () => bumpEnriched(root) };
    // Read first so the answer is immediate, then kick off the work.
    const items = readCached(root, refs);
    refresh(opts, refs, body.force === true);
    return c.json({ items });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post('/api/enrich/clear', async (c) => {
  const root = vaultOf(c);
  try {
    const body = (await c.req.json().catch(() => ({}))) as { refs?: unknown };
    if (body.refs !== undefined && !Array.isArray(body.refs)) {
      return c.json({ error: 'refs must be an array of link strings' }, 400);
    }
    const n = clearEnrichment(root, body.refs as string[] | undefined);
    bumpEnriched(root);
    return c.json({ cleared: n });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ---------------------------------------------------------------- live updates
//
// The point of the watcher is C3: a Claude session editing a card file must show
// up in the open app without a manual refresh.

let revision = 0;
type Send = (event: 'change' | 'enriched', rev: number, vault: string) => void;
const listeners = new Set<Send>();

function bump(vault: string) {
  // Our own writes do not wait to be noticed: a rename inside the same
  // millisecond as the previous one would leave the stamp unchanged.
  invalidate(vault);
  revision++;
  for (const fn of [...listeners]) fn('change', revision, vault);
}

/**
 * Enrichment gets its own signal. A chip resolving should refresh the chips, not
 * make the board rebuild itself — and it must never look like a file changed.
 */
function bumpEnriched(vault: string) {
  revision++;
  for (const fn of [...listeners]) fn('enriched', revision, vault);
}

/**
 * Watch a vault the first time it is used, not every registered one — a vault
 * that is merely known should not cost an open file handle. The event carries
 * which vault changed so a client looking at another one ignores it.
 */
const watched = new Map<string, ReturnType<typeof watch>>();

function ensureWatched(root: string): void {
  if (watched.has(root)) return;
  const p = paths(root);
  const w = watch([p.cards, p.views, p.facets], {
    ignoreInitial: true,
    ignored: (path: string) =>
      path.includes('.tmp-') || path.endsWith('.index.db') || path.endsWith('.enrich.db'),
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
  }).on('all', () => bump(root));
  watched.set(root, w);
}

app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    let alive = true;
    const send: Send = (event, rev, vault) => {
      void stream.writeSSE({ event, data: JSON.stringify({ rev, vault }) });
    };
    listeners.add(send);
    await stream.writeSSE({ event: 'hello', data: JSON.stringify({ rev: revision }) });
    stream.onAbort(() => {
      alive = false;
      listeners.delete(send);
    });
    // Hold the connection open; a heartbeat keeps intermediaries from closing it.
    while (alive) {
      await stream.sleep(25000);
      if (alive) await stream.writeSSE({ event: 'ping', data: JSON.stringify({ rev: revision }) });
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
  const known = listVaults();
  if (!known.length) console.log('vaults   none yet — the app will ask for a folder');
  for (const v of known) {
    console.log(`vault    ${v.name}  ${v.path}${v.exists ? '' : ' (missing)'}`);
  }
  if (!existsSync(dist)) console.log(`ui       not built — run \`pnpm dev:web\` for the dev server`);
});
