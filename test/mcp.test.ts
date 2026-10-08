import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { createHandler } from '../src/mcp/server.ts';
import { TOOLS } from '../src/mcp/tools.ts';

/**
 * `pj mcp`: the vault served to a client that cannot run `pj`.
 *
 * What is worth pinning is the promise rather than the plumbing: the tools are
 * the commands — a view asked through MCP answers what `pj ls` answers — and no
 * tool writes a note, `propose` included. The protocol half is driven through
 * `createHandler` without a pipe, and once over a real one, because stdout being
 * the protocol is exactly the kind of wiring a unit test cannot see break.
 */

const CLI = new URL('../src/cli/pj.ts', import.meta.url).pathname;

function vault(): { root: string; registry: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pj-mcp-'));
  const p = paths(root);
  mkdirSync(p.views, { recursive: true });
  writeFileSync(
    p.facets,
    'status: { label: Status, values: [planning, active, done], open: false, single: true }\n' +
      'priority: { label: Priority, values: [now, later], open: false, single: true }\n' +
      'parent: { label: Part of, type: ref, single: true }\n',
    'utf8',
  );
  writeFileSync(
    join(p.views, 'open.yaml'),
    'title: Open\nshape: board\nfilter: { status: [planning, active] }\ngroupBy: [priority]\nshow: [priority]\n',
    'utf8',
  );
  writeFileSync(
    join(p.views, 'unprioritised.yaml'),
    'title: Unprioritised\nshape: table\nunlisted: true\nexpect: empty\nfilter: { priority: ["(none)"] }\n',
    'utf8',
  );
  const card = (id: string, body: string) => writeFileSync(join(p.notes, `${id}.md`), body, 'utf8');
  card('alpha', '---\nid: alpha\ntitle: Alpha launch\nfacets: { status: [planning], priority: [now] }\n---\nfirst\n');
  card('beta', '---\nid: beta\ntitle: Beta\nfacets: { status: [active] }\nlinks: [jira:B-1]\n---\nsecond\n');
  card('gamma', '---\nid: gamma\ntitle: Gamma\nfacets: { status: [done], priority: [later] }\n---\nthird\n');
  const registry = join(root, 'registry.json');
  writeFileSync(registry, JSON.stringify({ vaults: [{ name: 'scratch', path: root }] }), 'utf8');
  return { root, registry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The registry and the live-server shortcut are both seams; a test names its own. */
function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

let next = 0;
async function rpc(handle: ReturnType<typeof createHandler>, method: string, params: Record<string, unknown> = {}) {
  const res = await handle({ jsonrpc: '2.0', id: ++next, method, params });
  assert.ok(res, `${method} answered nothing`);
  return res;
}

async function callTool(handle: ReturnType<typeof createHandler>, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(handle, 'tools/call', { name, arguments: args });
  assert.ok('result' in res, `tools/call ${name} was a protocol error: ${JSON.stringify(res)}`);
  const r = res.result as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError ?? false };
}

function snapshot(root: string): string {
  return ['alpha', 'beta', 'gamma'].map((id) => readFileSync(join(paths(root).notes, `${id}.md`), 'utf8')).join('\0');
}

test('initialize agrees a version, and every tool says it is read-only', async () => {
  const v = vault();
  try {
    const handle = createHandler({ root: v.root, name: 'scratch' });
    const init = await rpc(handle, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} });
    assert.ok('result' in init);
    const r = init.result as { protocolVersion: string; instructions: string; capabilities: Record<string, unknown> };
    assert.equal(r.protocolVersion, '2025-03-26', 'a version the server knows comes back as asked');
    assert.ok(r.capabilities.tools && r.capabilities.resources);
    // The views are the vault's own, read off it — the unlisted rule is not offered.
    assert.match(r.instructions, /open \(Open\)/);
    assert.doesNotMatch(r.instructions, /unprioritised/);

    const unknown = await rpc(handle, 'initialize', { protocolVersion: '1999-01-01' });
    assert.ok('result' in unknown);
    assert.notEqual((unknown.result as { protocolVersion: string }).protocolVersion, '1999-01-01');

    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'a notification gets no answer');

    const list = await rpc(handle, 'tools/list');
    assert.ok('result' in list);
    const tools = (list.result as { tools: { name: string; annotations: Record<string, boolean>; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
    assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true, `${t.name} must declare itself read-only`);
      assert.equal(t.annotations.destructiveHint, false);
      assert.ok(t.inputSchema.properties.vault, `${t.name} takes a vault`);
    }

    const missing = await rpc(handle, 'no/such');
    assert.ok('error' in missing && missing.error.code === -32601);
  } finally {
    v.cleanup();
  }
});

/**
 * C9 from the outside: the same question through MCP and through `pj ls`
 * answers with the same notes in the same order, because both are one module.
 */
test('ls through a view answers what pj ls answers', async () => {
  const v = vault();
  try {
    await withEnv({ PROJECTOR_NO_DELEGATE: '1' }, async () => {
      const handle = createHandler({ root: v.root, name: 'scratch' });
      const viaMcp = JSON.parse((await callTool(handle, 'ls', { view: 'open', format: 'json' })).text) as { ids: string[] };
      const viaCli = JSON.parse(
        execFileSync(process.execPath, [CLI, '--vault', v.root, 'ls', '--view', 'open', '--json'], {
          encoding: 'utf8',
          env: { ...process.env, PROJECTOR_VAULTS: v.registry },
        }),
      ) as { ids: string[] };
      assert.deepEqual(viaMcp.ids, viaCli.ids);
      assert.deepEqual([...viaMcp.ids].sort(), ['alpha', 'beta']);

      // Text is the CLI's listing plus the view's own `show` facets.
      const text = (await callTool(handle, 'ls', { view: 'open' })).text;
      assert.match(text, /^view open — Open/);
      assert.match(text, /## now \(1\)/);
      assert.match(text, /alpha +Alpha launch +\[priority=now\]/);

      // An override narrows the saved view, as a flag does.
      const narrowed = (await callTool(handle, 'ls', { view: 'open', filter: { status: ['active'] }, format: 'json' })).text;
      assert.deepEqual((JSON.parse(narrowed) as { ids: string[] }).ids, ['beta']);

      const bad = await callTool(handle, 'ls', { view: 'nope' });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /no view "nope"/);
    });
  } finally {
    v.cleanup();
  }
});

test('context, search and views read the vault; a wrong id gets the near matches', async () => {
  const v = vault();
  try {
    const handle = createHandler({ root: v.root, name: 'scratch' });
    const ctx = await callTool(handle, 'context', { id: 'beta' });
    assert.equal(ctx.isError, false);
    assert.match(ctx.text, /Beta/);
    assert.match(ctx.text, /\*\*jira\*\* `B-1`/);
    assert.equal((JSON.parse((await callTool(handle, 'context', { id: 'beta', format: 'json' })).text) as { id: string }).id, 'beta');

    const miss = await callTool(handle, 'context', { id: 'alpha-launch' });
    assert.equal(miss.isError, true);
    assert.match(miss.text, /no note with id "alpha-launch"\. Did you mean: alpha/);

    assert.match((await callTool(handle, 'search', { query: 'laun' })).text, /^alpha +Alpha launch/);
    const views = (await callTool(handle, 'views')).text;
    assert.match(views, /open — Open \(board\)/);
    assert.match(views, /unprioritised — Unprioritised \(table\) \[unlisted; rule: expect empty\]/);

    // Arguments are checked before anything runs, and say what was wrong.
    const bad = await callTool(handle, 'search', {});
    assert.equal(bad.isError, true);
    assert.match(bad.text, /query/);
  } finally {
    v.cleanup();
  }
});

test('vault_status counts the index and names a broken rule', async () => {
  const v = vault();
  try {
    const handle = createHandler({ root: v.root, name: 'scratch' });
    const text = (await callTool(handle, 'vault_status')).text;
    assert.match(text, /^vault scratch at /);
    assert.match(text, /3 note\(s\)/);
    assert.match(text, /check: 0 error\(s\)/);
    assert.match(text, /BROKEN unprioritised +1 beta/);
  } finally {
    v.cleanup();
  }
});

/**
 * The vault's rule — nothing written without its owner — held by the one tool
 * that is about a write. It prints the command, checks it with the write path's
 * own gate, and leaves every byte where it was.
 */
test('propose prints the pj command, checks it, and writes nothing', async () => {
  const v = vault();
  try {
    const handle = createHandler({ root: v.root, name: 'scratch' });
    const before = snapshot(v.root);

    const set = (await callTool(handle, 'propose', { command: 'set', id: 'alpha', facet: { status: ['done'] } })).text;
    assert.match(set, /Proposed, not applied/);
    assert.match(set, /^ {2}pj --vault scratch set alpha --facet status=done$/m);
    assert.match(set, /would become: status=done priority=now/);
    assert.doesNotMatch(set, /would be refused/);

    const refused = (await callTool(handle, 'propose', { command: 'set', id: 'alpha', facet: { status: ['blocked'] } })).text;
    assert.match(refused, /would be refused: "blocked" is not allowed for "status"/);

    const add = (await callTool(handle, 'propose', { command: 'add', title: "Ship it's thing", facet: { priority: ['now'] } })).text;
    assert.match(add, /pj --vault scratch add 'Ship it'\\''s thing' --facet priority=now/);
    assert.match(add, /would create ship-it-s-thing|would create ship-its-thing/);

    const unlink = (await callTool(handle, 'propose', { command: 'link', id: 'beta', links: ['jira:B-2'], unlink: true })).text;
    assert.match(unlink, /would be refused: beta does not link jira:B-2/);

    const nobody = await callTool(handle, 'propose', { command: 'set', id: 'nobody', facet: { status: ['done'] } });
    assert.equal(nobody.isError, true);

    assert.equal(snapshot(v.root), before, 'propose must not touch a note');
  } finally {
    v.cleanup();
  }
});

test('a call may name another registered vault, never a path', async () => {
  const v = vault();
  try {
    await withEnv({ PROJECTOR_VAULTS: v.registry }, async () => {
      const handle = createHandler({ root: '/nonexistent', name: null });
      assert.match((await callTool(handle, 'search', { query: 'beta', vault: 'scratch' })).text, /^beta/);

      const path = await callTool(handle, 'search', { query: 'beta', vault: v.root });
      assert.equal(path.isError, true);
      assert.match(path.text, /is not a registered vault\. Registered: scratch/);
    });
  } finally {
    v.cleanup();
  }
});

test('saved views are resources, and a note is a resource template', async () => {
  const v = vault();
  try {
    const handle = createHandler({ root: v.root, name: 'scratch' });
    const list = await rpc(handle, 'resources/list');
    assert.ok('result' in list);
    const uris = (list.result as { resources: { uri: string }[] }).resources.map((r) => r.uri);
    assert.deepEqual(uris.sort(), ['projector://view/open', 'projector://view/unprioritised']);

    const read = await rpc(handle, 'resources/read', { uri: 'projector://view/open' });
    assert.ok('result' in read);
    assert.match((read.result as { contents: { text: string }[] }).contents[0]!.text, /## now \(1\)/);

    const note = await rpc(handle, 'resources/read', { uri: 'projector://note/gamma' });
    assert.ok('result' in note);
    assert.match((note.result as { contents: { text: string }[] }).contents[0]!.text, /Gamma/);

    const missing = await rpc(handle, 'resources/read', { uri: 'projector://note/nope' });
    assert.ok('error' in missing);
  } finally {
    v.cleanup();
  }
});

/**
 * Over a real pipe, because stdout is the protocol: one stray line from library
 * code and the client reads garbage. Every line out must parse.
 */
test('pj mcp speaks newline-delimited JSON-RPC on stdio, and needs --vault', () => {
  const v = vault();
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, PROJECTOR_VAULTS: v.registry, PROJECTOR_NO_DELEGATE: '1' };
    delete env.PROJECTOR_DATA;
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ls', arguments: { view: 'open' } } },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\nnot json\n';
    const run = spawnSync(process.execPath, [CLI, '--vault', 'scratch', 'mcp'], { input, encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id: number | null; result?: unknown; error?: { code: number } });
    assert.deepEqual(lines.map((l) => l.id), [1, 2, null]);
    assert.match(JSON.stringify(lines[1]!.result), /alpha/);
    assert.equal(lines[2]!.error?.code, -32700, 'a line that is not JSON is a parse error, not a crash');

    // The single registered vault would resolve for any other command; not this one.
    const bare = spawnSync(process.execPath, [CLI, 'mcp'], { input: '', encoding: 'utf8', env });
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /pj mcp needs --vault/);
  } finally {
    v.cleanup();
  }
});
