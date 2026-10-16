import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { closeIntakeDb } from '../src/intake/db.ts';
import { createHandler } from '../src/mcp/server.ts';
import { TOOLS } from '../src/mcp/tools.ts';
import { place } from './fixture.ts';

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
  const card = (id: string, body: string) => writeFileSync(place(root, `${id}.md`), body, 'utf8');
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

/**
 * Three cards in `inbox/`: one of its own, one extending `alpha`, one to say no to.
 * Only the tests that judge cards file them, so the others count three notes.
 */
function inbox(root: string): void {
  const card = (id: string, fm: string) =>
    writeFileSync(place(root, `inbox/${id}.md`), `---\nid: ${id}\ntitle: ${id}\n${fm}---\nwhat came in\n`, 'utf8');
  card('own', 'facets: { priority: [later] }\nsource_fingerprint: git:1\n');
  card('ext', 'facets: { status: [done], priority: [later], extends: [alpha] }\nsource_fingerprint: slack:C1/1\n');
  card('nope', 'facets: { priority: [later] }\nsource_fingerprint: slack:C1/2\n');
}

/** Every note file in the vault, byte for byte, and whether intake's store exists. */
function snapshot(root: string): string {
  const files = ['notes', 'inbox']
    .flatMap((dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).map((f) => join(root, dir, f)) : []))
    .sort();
  return [...files.map((f) => `${f}\n${readFileSync(f, 'utf8')}`), `intake.db: ${existsSync(paths(root).intakeDb)}`].join('\0');
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
    // The instructions name tools that exist, and none that went away.
    for (const t of ['vault_status', 'memory', 'propose']) assert.match(r.instructions, new RegExp(t));
    assert.doesNotMatch(r.instructions, /\bviews tool\b/);

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

test('context and search read the vault; a wrong id gets the near matches', async () => {
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
 * What the `views` tool answered is part of the status now: the vault's
 * questions, rules marked. And the intake half — whether there is a kernel to
 * triage from, which connector gathers each channel, and how much waits in the
 * inbox — is what tells a client where the vault's news comes from.
 */
test('vault_status lists every saved view, where intake reads from, and the inbox', async () => {
  const v = vault();
  try {
    inbox(v.root);
    const handle = createHandler({ root: v.root, name: 'scratch' });
    const before = (await callTool(handle, 'vault_status')).text;
    assert.match(before, /open — Open \(board\)/);
    assert.match(before, /unprioritised — Unprioritised \(table\) \[unlisted; rule: expect empty\]/);
    assert.match(before, /^inbox: 3 card\(s\)/m);
    assert.match(before, /^intake: the kernel block is off, so there is nothing to triage$/m);
    assert.equal(existsSync(paths(v.root).intakeDb), false, 'asking does not create intake\'s store');

    writeFileSync(join(v.root, '.projector', 'config.yaml'), 'kernel:\n  enabled: true\n  bin: kernel\n', 'utf8');
    const after = (await callTool(handle, 'vault_status')).text;
    assert.match(after, /^intake: triages the kernel’s connector events — `pj intake status` asks the kernel how far it got$/m);
    assert.match(after, /^ {2}claude +gathered by bin\/kernel sync claude-code$/m);
    assert.match(after, /^ {2}gmail +gathered by bin\/kernel sync gmail$/m);
    assert.equal(existsSync(paths(v.root).intakeDb), false, 'and still creates nothing');

    // Folded in, not aliased.
    assert.ok(!TOOLS.some((t) => t.name === 'views'));
    const gone = await rpc(handle, 'tools/call', { name: 'views', arguments: {} });
    assert.ok('error' in gone && /unknown tool "views"/.test(gone.error.message));
  } finally {
    closeIntakeDb(v.root);
    v.cleanup();
  }
});

/**
 * The vault's rule — nothing written without its owner — held by the one tool
 * that is about a write. It prints the commands, checks each with the write
 * path's own gate, and leaves every byte where it was: the inbox, and intake's
 * store, which a real decline would create.
 */
test('propose drafts a batch of pj commands, checks each, and writes nothing', async () => {
  const v = vault();
  try {
    inbox(v.root);
    const handle = createHandler({ root: v.root, name: 'scratch' });
    const before = snapshot(v.root);

    const out = await callTool(handle, 'propose', {
      commands: [
        { verb: 'set', id: 'alpha', facet: { status: ['done'] } },
        { verb: 'accept', id: 'own' },
        { verb: 'accept', id: 'ext', only: ['status'] },
        { verb: 'decline', id: 'nope', reason: 'answered in the thread' },
        { verb: 'decline', id: 'slack:C9/9', reason: 'noise', title: 'A bot' },
        { verb: 'add', title: "Ship it's thing", facet: { priority: ['now'] } },
        { verb: 'decline', id: 'alpha', reason: 'kept' },
        { verb: 'set', id: 'nobody', facet: { status: ['done'] } },
        { verb: 'set', id: 'gamma', facet: { status: ['blocked'] } },
        { verb: 'accept', id: 'nope' },
        { verb: 'decline', id: 'own', reason: ' ' },
      ],
    });
    assert.equal(out.isError, false, 'an invalid entry is reported, not the whole batch refused');
    const text = out.text;
    assert.match(text, /Proposed, not applied/);
    assert.match(text, /6 to run, 5 refused/);

    // The block is exactly the valid entries, in order, and every line runs.
    const block = text.split('\n').filter((l) => l.startsWith('  pj '));
    assert.deepEqual(block, [
      '  pj --vault scratch set alpha --facet status=done',
      '  pj --vault scratch accept own',
      '  pj --vault scratch accept ext --only status',
      "  pj --vault scratch decline nope --reason 'answered in the thread'",
      "  pj --vault scratch decline slack:C9/9 --reason noise --title 'A bot'",
      "  pj --vault scratch add 'Ship it'\\''s thing' --facet priority=now",
    ]);

    assert.match(text, /1\. set alpha\n {3}alpha now: status=planning priority=now\n {3}would become: status=done priority=now/);
    assert.match(text, /2\. accept own\n {3}would file own as its own note in notes\//);
    assert.match(text, /3\. accept ext\n {3}would fold ext into alpha, taking status/);
    assert.match(text, /4\. decline nope\n {3}would remove the card and record slack:C1\/2 as declined/);
    assert.match(text, /5\. decline slack:C9\/9\n {3}would record slack:C9\/9 as declined/);
    assert.match(text, /6\. add\n {3}would create ship-it-s-thing|6\. add\n {3}would create ship-its-thing/);
    // Each refusal names its entry and why, and its command stays out of the block.
    assert.match(text, /7\. decline alpha — refused: "alpha" is not a card — use pj rm to delete a note/);
    assert.match(text, /8\. set nobody — refused: no note with id "nobody"/);
    assert.match(text, /9\. set gamma — refused: "blocked" is not allowed for "status"[^\n]*\n {3}not run: pj --vault scratch set gamma --facet status=blocked/);
    assert.match(text, /10\. accept nope — refused: entry 4 already declines nope/);
    assert.match(text, /11\. decline own — refused: a decline needs a reason/);

    assert.equal(snapshot(v.root), before, 'propose must not touch a note, the inbox or intake');

    const single = (await callTool(handle, 'propose', { commands: [{ verb: 'link', id: 'beta', links: ['jira:B-2'], unlink: true }] })).text;
    assert.match(single, /0 to run, 1 refused/);
    assert.match(single, /1\. link beta — refused: beta does not link jira:B-2/);

    const empty = await callTool(handle, 'propose', { commands: [] });
    assert.equal(empty.isError, true, 'a batch of nothing is a malformed call');
    const wrong = await callTool(handle, 'propose', { commands: [{ verb: 'rm', id: 'alpha' }] });
    assert.equal(wrong.isError, true, 'rm is not a verb propose drafts');
  } finally {
    v.cleanup();
  }
});

/** `context` fresh is `pj context --fresh`: the links re-resolved before the answer. */
test('context with fresh re-resolves the note\'s links first', async () => {
  const v = vault();
  try {
    writeFileSync(place(v.root, 'assets/gamma/spec.md'), '# Written down\n', 'utf8');
    writeFileSync(
      place(v.root, 'gamma.md'),
      "---\nid: gamma\ntitle: Gamma\nfacets: { status: [done], priority: [later] }\nlinks: ['doc:assets/gamma/spec.md']\n---\nthird\n",
      'utf8',
    );
    const handle = createHandler({ root: v.root, name: 'scratch' });
    type Ctx = { links: { enrichment: { state: string; data?: { title?: string } } }[] };
    const cached = JSON.parse((await callTool(handle, 'context', { id: 'gamma', format: 'json' })).text) as Ctx;
    assert.equal(cached.links[0]!.enrichment.state, 'missing', 'a plain context never fetches');
    const fresh = JSON.parse((await callTool(handle, 'context', { id: 'gamma', fresh: true, format: 'json' })).text) as Ctx;
    assert.equal(fresh.links[0]!.enrichment.state, 'fresh');
    assert.equal(fresh.links[0]!.enrichment.data?.title, 'Written down');

    const ghost = await callTool(handle, 'context', { id: 'ghost', fresh: true });
    assert.equal(ghost.isError, true);
    assert.match(ghost.text, /no note with id "ghost"/);
  } finally {
    v.cleanup();
  }
});

/**
 * `memory/` read through MCP, for a client with no file access. Read-only
 * (decision 17), and closed: a day is a date and a part is one of three, so no
 * argument can name a path.
 */
test('memory reads AGENTS.md, a day of theories and the patterns; none is empty, not an error', async () => {
  const v = vault();
  try {
    const handle = createHandler({ root: v.root, name: 'scratch' });
    const none = await callTool(handle, 'memory');
    assert.equal(none.isError, false, 'a vault the scientist has not run in is not broken');
    assert.match(none.text, /^no memory\/ in this vault/);

    const m = (rel: string, body: string) => writeFileSync(place(v.root, `memory/${rel}`), body, 'utf8');
    m('AGENTS.md', 'how to investigate\n');
    m('theories/2026-10-12.md', 'older theory\n');
    m('theories/2026-10-13.md', 'newest theory\n');
    m('theories/notes.txt', 'not a day\n');
    m('patterns/a.md', 'pattern a\n');
    m('patterns/b.md', 'pattern b\n');
    m('patterns/deeper/c.md', 'not read\n');

    const all = (await callTool(handle, 'memory')).text;
    assert.match(all, /## memory\/AGENTS\.md\n\nhow to investigate/);
    assert.match(all, /## memory\/theories\/2026-10-13\.md\n\n(.*\n)*newest theory/);
    assert.match(all, /other days: 2026-10-12/);
    assert.doesNotMatch(all, /older theory/, 'the newest day by default');
    assert.match(all, /## memory\/patterns\/a\.md\n\npattern a/);
    assert.match(all, /## memory\/patterns\/b\.md\n\npattern b/);
    assert.doesNotMatch(all, /not read|not a day/);

    const day = (await callTool(handle, 'memory', { part: 'theories', day: '2026-10-12' })).text;
    assert.match(day, /older theory/);
    assert.doesNotMatch(day, /how to investigate|pattern a/, 'a part is only that part');

    const missing = await callTool(handle, 'memory', { part: 'theories', day: '2026-10-11' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /no memory\/theories\/2026-10-11\.md — have 2026-10-13, 2026-10-12/);

    for (const bad of [{ day: '../../.projector/config' }, { day: '2026-10-1' }, { part: '../notes' }]) {
      const r = await callTool(handle, 'memory', bad);
      assert.equal(r.isError, true, `${JSON.stringify(bad)} must be refused before anything is read`);
    }
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
