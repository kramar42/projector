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
  countNotes,
  normalise,
  registerVault,
  suggestName,
  touchVault,
} from '../vault.ts';
import { jiraConfig } from '../sources/jira.ts';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { split } from '../schema/frontmatter.ts';
import { idFromFile, loadNote } from '../schema/note.ts';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfigured, paths } from '../config.ts';
import { loadFacets } from '../schema/facets.ts';
import type { Facets, Note } from '../schema/types.ts';
import { reindex, readAll } from '../index/indexer.ts';
import { computedReader } from '../index/query.ts';
import { cached, invalidate } from '../index/cache.ts';
import { resolveProject, isProject } from '../index/project.ts';
import { blockedBy, isClosed, unblocks } from '../index/blocking.ts';
import { isRef } from '../schema/facets.ts';
import { loadViews, findView } from './views.ts';
import { meta } from './meta.ts';
import type { DragMode } from '../view/dropOutcome.ts';
import { parseSpec, specToFile, specToParams, withSavedOnly, type ViewSpec } from '../view/spec.ts';
import { queryPayload } from '../view/payload.ts';
import { inboundCounts } from '../index/refs.ts';
import { toDTO } from '../view/dto.ts';
import {
  Conflict,
  Invalid,
  bulkDelete,
  bulkFacet,
  bulkMove,
  mergeNotes,
  createNote,
  foldInto,
  deleteNote,
  fileFor,
  mtimeOf,
  patchNote,
  saveAsset,
  putFrontmatter,
  saveArrangement,
  saveView,
  deleteView,
} from './mutate.ts';
import { noteContext } from '../agent/context.ts';
import { NotWorkable, plannedBriefing, planWork, startWork } from '../agent/work.ts';
import { watch } from 'chokidar';
import { clearEnrichment, readCached, refresh } from './enrich.ts';
import { info, logTo } from './log.ts';
import { SEED_FACETS, SEED_VIEWS } from './seed.ts';
import { streamSSE } from 'hono/streaming';
import { startPolling } from './poll.ts';
import { foldRows } from '../schema/fold.ts';
import { suppressions, unsuppress } from '../intake/db.ts';

const PORT = Number(process.env.PROJECTOR_PORT ?? 8092);

/** Origins allowed to send a mutating request. A localhost server is still
 *  reachable from any page open in the browser, so an Origin that is present
 *  must be one of ours. A request with no Origin at all (curl) is unaffected. */
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, 'http://localhost:5176']);

/**
 * The vault a request is about.
 *
 * The browser names it with `X-Projector-Vault`, and it must already be
 * registered — the registry is what keeps this from being "read any directory
 * the page asks for". Registering happens through the vault endpoints, which is
 * where a path is checked and, if the user asked, initialised.
 */
class NoVault extends Error {}

function vaultOf(c: Context): string {
  const header = c.req.header('X-Projector-Vault');
  if (header) {
    const want = normalise(header);
    if (!isRegistered(want)) throw new NoVault(`vault not registered: ${want}`);
    if (!existsSync(want)) throw new NoVault(`vault directory is missing: ${want}`);
    ensureWatched(want);
    ensurePolling(want);
    return want;
  }
  // No header: fall back only when the choice is unambiguous.
  const known = listVaults().filter((v) => v.exists);
  if (known.length === 1) {
    ensureWatched(known[0]!.path);
    ensurePolling(known[0]!.path);
    return known[0]!.path;
  }
  throw new NoVault(known.length ? 'pick a vault' : 'no vault has been opened yet');
}

function build(root: string) {
  const p = paths(root);
  const facets = loadFacets(p.facets);
  const { db, notes } = reindex(root);
  const views = loadViews(root);
  return { facets, db, notes, views, p };
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
// A vault is a folder of notes, opened the way Obsidian opens one. Nothing here
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
    configured: exists && isConfigured(path),
    cards: exists && looksLikeVault(path) ? countNotes(path) : 0,
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

    // Anything without a `.projector/` has to be set up, and that includes a
    // folder of markdown — the notes are already there, but the vocabulary and
    // the views are not, and a vault with no board opens onto nothing. `create`
    // is still required for all of them: writing into somebody's notes folder is
    // a decision they make, not one an inspection makes for them.
    if (!isConfigured(path)) {
      if (!body.create) {
        return c.json(
          {
            error: !existsSync(path)
              ? `${path} does not exist — pass create to make it a vault`
              : looksLikeVault(path)
                ? `${path} holds markdown but has no .projector/ — pass create to set one up`
                : `${path} is not a vault — pass create to set one up there`,
            needsCreate: true,
            path,
          },
          409,
        );
      }
      initVault(path, SEED_FACETS, SEED_VIEWS);
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
  const { facets, db, views } = load(root);
  return c.json(meta(root, { facets, db, views }));
});

/**
 * A request's view: the saved one it names, with every other parameter overriding.
 *
 * Merged at the *parameter* level rather than the object level, so an override is
 * a plain string swap and `f.status=` can mean "no status filter" over a saved
 * view that had one. Shared with the save route, so *save current as…* stores
 * exactly what is on screen rather than a second interpretation of it.
 */
function resolveSpec(
  root: string,
  url: string,
): { spec: ViewSpec; saved: ViewSpec | null } | { error: string } {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const saved = params.view ? findView(root, params.view) : undefined;
  if (params.view && !saved) return { error: `no view "${params.view}"` };

  // Arrangement and composition are never query parameters: they come from the
  // file or nowhere, which is what `withSavedOnly` carries across.
  const spec: ViewSpec = withSavedOnly(
    parseSpec(saved ? { ...specToParams(saved), ...params } : params),
    saved,
  );
  // The saved view travels too: a control that changes a view has to know what it
  // is overriding, and only this function has both halves in hand.
  return { spec, saved: saved ?? null };
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
/**
 * The CLI's delegation handshake: the stamp the persisted index was built
 * from, vouched for by a server that is watching the vault. Between watcher
 * events (and our own writes, which clear it through `bump`) the remembered
 * answer is returned without touching the filesystem — that trust window is
 * the watcher's own, the one every open board already lives on. The CLI
 * verifies the payload against this stamp before using it, and falls back to
 * its exact local walk on any disagreement.
 */
app.get('/api/cli/stamp', (c) => {
  const root = vaultOf(c);
  // A vault whose watcher died (EMFILE on a workspace-sized tree) has nobody
  // to clear cliFresh, so its word would go stale silently. Refuse instead:
  // the CLI's fallback is exact.
  if (unwatchable.has(root)) return c.json({ error: 'vault is not watchable' }, 503);
  let stamp = cliFresh.get(root);
  if (!stamp) {
    const { db } = load(root);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'stamp'").get() as
      | { value: string }
      | undefined;
    if (row) {
      stamp = row.value;
    } else {
      // A database from before the stamp row: the payload still carries it.
      const payload = db.prepare("SELECT value FROM meta WHERE key = 'payload'").get() as
        | { value: string }
        | undefined;
      if (!payload) return c.json({ error: 'no persisted index' }, 503);
      stamp = (JSON.parse(payload.value) as { stamp: string }).stamp;
    }
    cliFresh.set(root, stamp);
  }
  return c.json({ stamp });
});

app.get('/api/query', (c) => {
  const root = vaultOf(c);
  const { facets, db, notes, views } = load(root);

  const resolved = resolveSpec(root, c.req.url);
  if ('error' in resolved) return c.json({ error: resolved.error }, 404);

  return c.json(
    queryPayload(
      { facets, db, notes, views, jiraBase: jiraConfig(root)?.url ?? null },
      resolved.spec,
      resolved.saved,
    ),
  );
});


app.get('/api/note/:id', (c) => {
  const root = vaultOf(c);
  const { notes, facets } = load(root);
  const rec = notes.get(c.req.param('id'));
  if (!rec) return c.json({ error: 'no such note' }, 404);
  const project = resolveProject(rec.id, notes, root);
  // One walk, shared by this note's own mark and by every reference it names.
  const inbound = inboundCounts(notes, facets);
  return c.json({
    note: toDTO(rec, {
      facets,
      jiraBase: jiraConfig(root)?.url ?? null,
      // The panel edits `facets` and never `computed`, but a DTO that reports no
      // computed values at all is a DTO that lies about this card — and it is the
      // same card the board just drew.
      computed: computedReader(notes, facets, new Date().toISOString().slice(0, 10))(rec),
      refCount: inbound.get(rec.id) ?? 0,
      blockedBy: blockedBy(rec.id, notes, facets),
      unblocks: unblocks(rec.id, notes, facets),
    }),
    file: relative(root, rec.file),
    // The client sends this back on a write; a mismatch means an agent or an
    // editor changed the file meanwhile, and the write is refused (409).
    mtime: mtimeOf(rec.file),
    // The raw frontmatter, from this same read. It used to have a route of its
    // own, which meant the panel held two copies of one file with two mtimes:
    // the chips refreshed on every write and the raw pane never did, so saving
    // it reverted whatever the chips had just done. One read, one mtime.
    yaml: split(readFileSync(rec.file, 'utf8')).yaml ?? '',
    // Every note this note points at, from any reference facet, resolved to a
    // title. A reference facet stores ids, so without this the panel can only
    // draw `check-technical-challenge-code-submissions-nikola` where the rest of
    // the app draws a title — which is why `parent` had grown a bespoke section
    // to say the same thing better, and why the note then carried two controls
    // for one axis. One answer for every reference facet, so none needs its own.
    refs: Object.fromEntries(
      Object.entries(rec.facets)
        .filter(([name]) => facets[name]?.type === 'ref')
        .flatMap(([, ids]) => ids)
        .map((id) => notes.get(id))
        .filter((r) => r !== undefined)
        .map((r) => [
          r.id,
          { title: r.title, isProject: isProject(r), refCount: inbound.get(r.id) ?? 0 },
        ]),
    ),
    // Each child is a note you click through to, so it carries its own mark —
    // the same three fields `refs` above has always sent.
    //
    // `done` joins them because the panel now draws children and blocked-by as
    // adjacent rows, and "finished" is worth saying on both — a difference in
    // what the server bothered to send would read as a difference between the
    // notes. `blockedBy` has always carried it.
    //
    // It does not follow that both lists draw the same *states*. Only a blocker
    // may draw `is-open` in `bad`, because there "open" means in your way; an
    // unfinished child is a child. The panel decides that per list.
    //
    // Keyed by the relation, so the panel can label each with the word the
    // vocabulary gave it. `blocked_by` changed ends when the relation did: the
    // edge is stored on the note that is stuck, so what a note *holds up* is the
    // derived half.
    inbound: inverseOf(rec, notes, facets, inbound),
    project,
  });
});

/**
 * The notes naming this one, per relation that named its other end.
 *
 * It was two hardcoded lists, `children` and `blocks`, each computed from a
 * facet named here — so a vault renaming either lost the row and a vault's own
 * relation could never have one. Which relations have an inverse worth drawing
 * is `inverse:` in the vocabulary now, and this is a loop.
 *
 * A relation that names no inverse gets no entry, which is the same rule as
 * before: an editable row and no derived one is correct rather than missing.
 */
function inverseOf(
  rec: Note,
  notes: Map<string, Note>,
  facets: Facets,
  inbound: Map<string, number>,
): Record<string, Inbound[]> {
  const out: Record<string, Inbound[]> = {};
  for (const [via, def] of Object.entries(facets)) {
    if (!isRef(def) || !def.inverse) continue;
    const naming = [...notes.values()]
      .filter((r) => (r.facets[via] ?? []).includes(rec.id))
      .map((r) => ({
        id: r.id,
        title: r.title,
        done: isClosed(r, facets),
        isProject: isProject(r),
        refCount: inbound.get(r.id) ?? 0,
      }));
    if (naming.length) out[via] = naming;
  }
  return out;
}

interface Inbound {
  id: string;
  title: string;
  done: boolean;
  isProject: boolean;
  refCount: number;
}

// ---------------------------------------------------------------- writes
//
// Every mutating route lives here and does nothing but delegate to mutate.ts.
// There is still no path to any external system: these write note files, canvas
// files and assets under the data directory, and nothing else.

function fail(c: Context, err: unknown) {
  if (err instanceof Conflict) {
    return c.json({ error: 'file changed on disk', mtime: err.mtime, conflict: true }, 409);
  }
  if (err instanceof Invalid) return c.json({ error: (err as Error).message }, 400);
  return c.json({ error: (err as Error).message }, 500);
}

app.patch('/api/note/:id', async (c) => {
  const root = vaultOf(c);
  try {
    const body = (await c.req.json()) as Parameters<typeof patchNote>[2];
    const res = patchNote(root, c.req.param('id'), body);
    bump(root);
    return c.json(res);
  } catch (err) {
    return fail(c, err);
  }
});

app.post('/api/note', async (c) => {
  const root = vaultOf(c);
  try {
    const body = (await c.req.json()) as Parameters<typeof createNote>[1];
    const res = createNote(root, body);
    bump(root);
    return c.json(res, 201);
  } catch (err) {
    return fail(c, err);
  }
});

app.delete('/api/note/:id', (c) => {
  const root = vaultOf(c);
  try {
    const res = deleteNote(root, c.req.param('id'));
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
      op: 'facet' | 'move' | 'delete' | 'merge';
      facet?: string;
      /** `merge` only: which of the notes survives and absorbs the rest. */
      into?: string;
      values?: string[];
      mode?: 'set' | 'add' | 'remove';
      /**
       * `move` only: the drag's endpoints, from which each note's values follow.
       * One entry per grouping axis crossed — a diagonal drag on a matrix board
       * names two, and they are applied in a single write per note.
       */
      moves?: { facet: string; from: string; to: string }[];
      dragMode?: DragMode;
    };
    const ids = b.ids ?? [];
    let res: unknown;
    if (b.op === 'facet') res = bulkFacet(root, ids, b.facet!, b.values ?? [], b.mode ?? 'set');
    // A drag, one note at a time: the values are per note, so only the endpoints
    // travel and `nextValues` runs here.
    else if (b.op === 'move') {
      res = bulkMove(root, ids, b.moves ?? [], b.dragMode ?? 'replace');
    }
    else if (b.op === 'delete') res = bulkDelete(root, ids);
    // The survivor is named, the rest are the selection, and the composition
    // happens server-side — see `mergeNotes` for why the body cannot travel.
    else if (b.op === 'merge') {
      if (!b.into) throw new Invalid('a merge has to name the note it merges into');
      res = mergeNotes(root, b.into, ids);
    }
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
    const resolved = resolveSpec(root, c.req.url);
    if ('error' in resolved) return c.json({ error: resolved.error }, 404);
    const { spec } = resolved;
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
app.put('/api/note/:id/frontmatter', async (c) => {
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

app.post('/api/note/:id/asset', async (c) => {
  const root = vaultOf(c);
  try {
    const id = c.req.param('id');
    fileFor(root, id); // 400s cleanly when the note does not exist
    const mime = c.req.header('Content-Type') ?? '';
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (!bytes.length) throw new Invalid('empty upload');
    const res = saveAsset(root, id, mime.split(';')[0]!.trim(), bytes);
    return c.json(res, 201);
  } catch (err) {
    return fail(c, err);
  }
});

// Pasted images are referenced from a note body, so the body renderer needs them.
app.get('/api/asset/*', (c) => {
  const root = vaultOf(c);
  const p = paths(root);
  const rel = c.req.path.replace('/api/asset/', '');
  // Confine to the assets tree: a note body is authored content, and a `..` in
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

// ---------------------------------------------------------------- starting work
//
// Deliberately *not* in the writes block above, and this is the one route where
// that distinction is worth a comment. Almost all of it lands outside the vault:
// git worktrees under `$PROJECTOR_WORKSPACES` and an `AGENT_BRIEFING.md` beside
// them, outside every repo. The one thing it does write to a note is the
// `workspace:` link recording where that went, appended through `patchNote` with
// no base mtime — a caller declining the guard, since there is nothing to
// conflict with: the ref is derived from the note and appending it twice is a
// no-op.
//
// It is not a write to an external system (`C2`). Nothing is sent anywhere: the
// deep link comes back in the response and *following* it is the browser's move,
// exactly as it is for the `claude://` link a session chip already offers.

app.post('/api/note/:id/work', async (c) => {
  const root = vaultOf(c);
  try {
    const id = c.req.param('id');
    const ctx = noteContext(id, root);
    if (!ctx) return c.json({ error: `no note "${id}"` }, 404);

    // `commit` is opt-in, so a request that forgets to say prepares nothing. The
    // panel asks twice on purpose: once to find out where the worktrees would go,
    // so its confirm can name the directory and the branch, and again to do it.
    const body = (await c.req.json().catch(() => ({}))) as { commit?: boolean; fresh?: boolean };
    const plan = planWork(ctx, root);
    if (body.commit !== true) return c.json({ ...plan, briefing: plannedBriefing(ctx, plan) });
    return c.json(startWork(ctx, plan, root, { fresh: body.fresh === true }));
  } catch (err) {
    if (err instanceof NotWorkable) return c.json({ error: err.message }, 400);
    return c.json({ error: (err as Error).message }, 500);
  }
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
    // Deliberately not awaited: the answer above is the response, and the fetches
    // announce themselves through `onRefreshed` when they land.
    void refresh(opts, refs, body.force === true);
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
// The point of the watcher is C3: a Claude session editing a note file must show
// up in the open app without a manual refresh.

let revision = 0;
type Send = (
  event: 'change' | 'enriched' | 'attention',
  rev: number,
  vault: string,
  ids?: string[],
  titles?: string[],
) => void;
const listeners = new Set<Send>();

/** Per-vault stamp the CLI may trust until the watcher (or a write) says otherwise. */
const cliFresh = new Map<string, string>();

/** Vaults whose watcher died — their word cannot be trusted, so it is not given. */
const unwatchable = new Set<string>();

/**
 * `ids` is which notes moved, when we know — and we only know from the watcher.
 *
 * A route calls this having just written a file it can name, but naming it here
 * would buy nothing: the client filters its own writes by what it just sent, so an
 * id from a route it called is an id it is about to discard. The watcher is the
 * only caller whose ids are news, because it is the only one that fires for a
 * write this app did not make — an agent's `Write`, a `pj set` in a terminal, a
 * `git checkout`. So the route path stays as it was and the watcher gained an
 * argument.
 *
 * A client that cannot attribute a change still reloads on it. `ids` refines what
 * the app can *say* about a change; it is not what makes it notice one.
 */
function bump(vault: string, ids?: string[]) {
  // Our own writes do not wait to be noticed: a rename inside the same
  // millisecond as the previous one would leave the stamp unchanged.
  cliFresh.delete(vault);
  invalidate(vault);
  revision++;
  for (const fn of [...listeners]) fn('change', revision, vault, ids);
}

/**
 * Enrichment gets its own signal. A chip resolving should refresh the chips, not
 * make the board rebuild itself — and it must never look like a file changed.
 */
/**
 * Something a sweep judged worth interrupting for.
 *
 * A **local** signal, and that is the whole of the C2 story: nothing is sent
 * anywhere. The server tells a tab that is already open, and the tab raises the
 * operating system's own notification if the reader has allowed it. No service,
 * no credential, no egress — so the rule about not writing where someone else
 * reads is not engaged at all, there being no somewhere to write to.
 *
 * Separate from `change` because the two mean different things: a change refetches
 * the board, and this interrupts a person. A client that treated them alike would
 * either notify on every write or notify on none.
 */
function bumpAttention(vault: string, notes: { id: string; title: string }[]) {
  if (!notes.length) return;
  revision++;
  for (const fn of [...listeners])
    fn('attention', revision, vault, notes.map((n) => n.id), notes.map((n) => n.title));
}

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

/**
 * Which note a changed path is, when the path is a note at all.
 *
 * The id is read out of the file rather than off its name, because the two are
 * allowed to differ — `fileFor` scans for exactly that reason. A deletion has no
 * file left to read, so the stem is the only answer available and is the right
 * guess: a rename away from the stem is rare and a deleted note's pulse has
 * nowhere to land anyway.
 *
 * `undefined` for a change to `facets.yaml` or a view, which moves everything and
 * so names nothing.
 *
 * The read is guarded rather than merely checked-for-existence: between the
 * watcher's event and this line the file may already be gone, and a deleted note
 * must still name itself so the client can drop it.
 */
function notesTouched(root: string, changed?: string): string[] | undefined {
  if (!changed) return undefined;
  const dir = paths(root).notes;
  if (!changed.startsWith(dir) || !changed.endsWith('.md')) return undefined;
  const stem = idFromFile(changed, dir);
  try {
    const res = loadNote(changed, dir);
    return [res.ok ? res.rec.id : stem];
  } catch {
    return [stem];
  }
}

/**
 * Anything dotted, below one of the roots being watched.
 *
 * The notes are the vault now, so the watched tree *is* the vault — which is the
 * whole of it, `.git/` and `.projector/` included. Watching those is not merely
 * wasteful: the index writes `.projector/index.db-wal` continuously, so a watcher
 * that sees it reports a change caused by reading, and every client refetches
 * forever. The two paths under `.projector/` that must be watched are named
 * explicitly below, and reach the watcher as roots rather than as children.
 */
const derived = (path: string, roots: string[]): boolean => {
  // The *longest* matching root, because the vault root contains the other two:
  // measured against it, every watched view is below a dot-folder and would be
  // ignored on the spot.
  const below = roots
    .filter((r) => path === r || path.startsWith(r + '/'))
    .sort((a, b) => b.length - a.length)[0];
  if (below === undefined) return false;
  return path.slice(below.length + 1).split('/').some((seg) => seg.startsWith('.'));
};

function ensureWatched(root: string): void {
  if (watched.has(root)) return;
  const p = paths(root);
  const roots = [p.notes, p.views, p.facets];
  const w = watch(roots, {
    ignoreInitial: true,
    // Dot-segments (.git above all) and node_modules are never note sources,
    // and watching them is what turns a workspace-sized vault into EMFILE.
    ignored: (path: string) =>
      path.includes('.tmp-') ||
      derived(path, roots) ||
      path
        .slice(root.length)
        .split('/')
        .some((seg) => (seg.startsWith('.') && seg !== '.') || seg === 'node_modules'),
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
  }).on('error', (err: unknown) => {
    // A tree too big to watch (EMFILE) is a fact about the vault, not a crash.
    // Close, remember, and let /api/cli/stamp refuse to vouch for it.
    unwatchable.add(root);
    cliFresh.delete(root); // a vouch already given must not outlive the watcher
    watched.get(root)?.close();
    info('watch', `${basename(root)} unwatchable: ${(err as Error).message ?? err}`);
  }).on('all', (event: string, changed?: string) => {
    /**
     * Arrivals only, and that is the whole editorial decision.
     *
     * A vault under an editor changes on every keystroke that reaches disk, and
     * an agent rewriting frontmatter touches a dozen files in a second — a log
     * that reported those would be one nobody reads, which is the same as no log.
     * A file *appearing* is an event: a sweep materialised a candidate, an agent
     * wrote a note, or somebody dropped one in by hand. Those are worth a line
     * each, and there are few enough of them that each one stays readable.
     *
     * Deletions are not logged either, for a weaker reason than edits: they are
     * rare but they are also how a decline is applied, so they would mostly
     * duplicate a line `intake` has already written.
     */
    if (event === 'add' && changed) {
      const p2 = paths(root);
      const where = changed.startsWith(p2.views)
        ? 'view'
        : changed.startsWith(p2.notes)
          ? 'note'
          : 'vocabulary';
      info('watch', `${basename(root)} new ${where}  ${basename(changed)}`);
    }
    bump(root, notesTouched(root, changed));
  });
  watched.set(root, w);

}

/**
 * Start this vault's poll loop, if it asked for one and has not got one.
 *
 * Called on **every** request that resolves a vault, rather than once beside the
 * watcher, and that placement is the whole point. The watcher is set up the first
 * time a vault is used and never again — so turning `poll.enabled` on in a vault
 * the server was already watching did nothing at all until a restart, with no
 * error, no log line, and a board that stayed empty for the most plausible
 * reason in the world. Settings are memoised on the file's mtime, so asking this
 * often costs a map lookup and a cached read.
 *
 * `startPolling` is idempotent per vault, which is what makes calling it this
 * often correct rather than merely cheap: a second call hands back the timer it
 * already made instead of doubling the rate. It announces its own interval
 * through the log, so there is nothing to say here — and a vault that did not opt
 * in is not news.
 */
function ensurePolling(root: string): void {
  startPolling(root, (notes) => bumpAttention(root, notes));
}

/**
 * The declined pile: what a sweep saw and nobody filed.
 *
 * Read-only plus one un-decline, and it is not a view — declined candidates are
 * not notes, so there is nothing for the query compiler to answer about them
 * (C9 is about views over notes, and this was never going to be one). It is a
 * surface, reached with `?declined=1` over the single route, the way `?note=`
 * reaches the panel.
 *
 * Why it exists at all: with the classifier running, an empty board has two
 * meanings — nothing happened, or everything was hidden — and no way to tell them
 * apart. This is the audit trail for a decision the app made on its own, and the
 * only place a wrong one can be corrected.
 */
/**
 * What folding this note into the one it extends would change, and then doing it.
 *
 * `GET` states the question — one row per axis where the candidate proposes
 * something the target does not already say — and `POST` performs it with the
 * answers. Two calls rather than one because the answer is a person's, and there
 * is a dialog between them.
 */
app.get('/api/note/:id/fold', (c) => {
  const root = vaultOf(c);
  const id = c.req.param('id');
  const { facets, db } = load(root);
  const { notes } = readAll(paths(root).notes);
  const rec = notes.get(id);
  if (!rec) return c.json({ error: 'not found' }, 404);
  const into = rec.facets.extends?.[0];
  if (!into) return c.json({ error: 'this note extends nothing' }, 400);
  const target = notes.get(into);
  if (!target) return c.json({ error: `it extends "${into}", which does not exist` }, 404);
  void db;
  return c.json({ into, title: target.title, rows: foldRows(rec, target, facets) });
});

app.post('/api/note/:id/fold', async (c) => {
  const root = vaultOf(c);
  const id = c.req.param('id');
  const body = (await c.req.json()) as { into?: string; facets?: Record<string, string[]> };
  if (!body.into) return c.json({ error: 'into is required' }, 400);
  const res = foldInto(root, id, body.into, body.facets ?? {});
  bump(root);
  return c.json(res);
});

app.get('/api/intake/declined', (c) => {
  const root = vaultOf(c);
  const q = c.req.query('q');
  const before = c.req.query('before');
  const limit = Number(c.req.query('limit') ?? 0);
  return c.json(
    suppressions(root, {
      ...(q ? { q } : {}),
      ...(before ? { before } : {}),
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    }),
  );
});

app.post('/api/intake/declined/:fp/restore', (c) => {
  const root = vaultOf(c);
  const fp = decodeURIComponent(c.req.param('fp'));
  const back = unsuppress(root, fp);
  // `rewound` is the channel whose cursor went back, so the surface can say what
  // will actually happen rather than implying the note reappears here and now.
  return c.json({ restored: Boolean(back), rewound: back?.rewound ?? null });
});

app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    let alive = true;
    const send: Send = (event, rev, vault, ids, titles) => {
      void stream.writeSSE({ event, data: JSON.stringify({ rev, vault, ids, titles }) });
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
//
// Resolved against this file rather than the working directory: the server is a
// path you can run from anywhere (`node /somewhere/projector/src/server/serve.ts`),
// and a `./dist` relative to the caller's cwd made the UI 404 everywhere except a
// shell sitting in the repo root — while the existence check above it, which was
// already absolute, cheerfully reported the UI as built.
const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
if (existsSync(dist)) {
  app.use('/assets/*', serveStatic({ root: dist }));
  app.get('*', serveStatic({ path: join(dist, 'index.html') }));
}

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT }, (addr) => {
  console.log(`projector  http://127.0.0.1:${addr.port}`);
  const known = listVaults();
  if (!known.length) console.log('vaults   none yet — the app will ask for a folder');
  for (const v of known) {
    console.log(`vault    ${v.name}  ${v.path}${v.exists ? '' : ' (missing)'}`);
  }
  if (!existsSync(dist)) console.log('ui       not built — run the `build` script, or `dev:web` for the dev server');

  /**
   * The banner above is what this process *is*; everything after it is what it
   * *does*. Switched on here and nowhere else, so `pj` and `node --test` — which
   * import the same modules — stay silent without either of them opting out.
   */
  logTo((line) => console.log(line));
  console.log(`logging  background events — watcher, intake and enrichment`);
});
