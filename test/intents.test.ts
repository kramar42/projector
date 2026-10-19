import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/config.ts';
import { loadFacets } from '../src/schema/facets.ts';
import { reindex, readAll } from '../src/index/indexer.ts';
import { queryPayload } from '../src/view/payload.ts';
import { parseSpec } from '../src/view/spec.ts';
import { settingsPath } from '../src/settings.ts';
import { logTo } from '../src/server/log.ts';
import { forgetKernel, kernelIndex } from '../src/kernel/read.ts';
import { askOf, asking, axisValues, intentsOf, isOwner, KERNEL_VALUES, lifecycleOf, notesOf } from '../src/kernel/state.ts';
import { parseAnswer } from '../src/kernel/query.ts';
import { decide, openIntent } from '../src/kernel/write.ts';
import type { Runner } from '../src/intake/kernel.ts';
import { place } from './fixture.ts';

/**
 * Projector over the kernel: the reader, the `kernel` axis it feeds, the owner's
 * verdicts and the intents the owner opens about a note, what the panel asks
 * when a note and its intent part ways, and `pj kernel`.
 *
 * The kernel is played by `test/fake-kernel`, a shell script that answers
 * projector's saved query `vault-intents` from `test/kernel-queries/` and
 * records every call — so what is pinned here is exactly the interface: which
 * query projector asks, with which inputs and `KERNEL_DB`, and what it makes of
 * the answer. Nothing here starts the real kernel.
 */

const FAKE = fileURLToPath(new URL('./fake-kernel', import.meta.url));
chmodSync(FAKE, 0o755);

const ALPHA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BETA = 'bbbbbbbb-0000-4000-8000-000000000002';
const DELTA = 'dddddddd-0000-4000-8000-000000000004';

function vault(kernel = `kernel:\n  enabled: true\n  bin: ${FAKE}\n  db: ./kdb\n  vault: fake\n  status: status\n`) {
  const root = mkdtempSync(join(tmpdir(), 'pj-intents-'));
  mkdirSync(paths(root).config, { recursive: true });
  writeFileSync(
    paths(root).facets,
    'status: { label: Status, values: [planning, active, on-hold, done, cancelled], open: false, single: true, closed: [done, cancelled] }\n',
    'utf8',
  );
  for (const [id, status] of [
    ['alpha', 'active'],
    ['beta', 'active'],
    ['gamma', 'done'],
    ['delta', 'planning'],
    ['epsilon', 'active'],
    ['plain', 'active'],
  ]) {
    writeFileSync(place(root, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\nfacets: { status: [${status}] }\n---\n\nbody\n`, 'utf8');
  }
  if (kernel) writeFileSync(settingsPath(root), kernel, 'utf8');
  const log = join(root, 'kernel-calls.log');
  process.env.FAKE_KERNEL_LOG = log;
  delete process.env.FAKE_KERNEL_FAIL;
  forgetKernel();
  return {
    root,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    cleanup: () => {
      delete process.env.FAKE_KERNEL_LOG;
      delete process.env.FAKE_KERNEL_FAIL;
      forgetKernel();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const fixed = () =>
  execFileSync(FAKE, ['query', '--saved', 'projector/vault-intents', '--json'], { encoding: 'utf8', env: { ...process.env, FAKE_KERNEL_LOG: '' } });

/** The fixed answer's rows, by column. */
const fixedRows = () => parseAnswer(fixed());

const COLUMNS = ['intent', 'alias', 'status', 'statement', 'horizon', 'verdict', 'by', 'at', 'note', 'evidence', 'proposer'];

/** An answer to `vault-intents`, as the kernel prints it, from rows by column. */
const answer = (rows: Record<string, unknown>[]) =>
  JSON.stringify({ columns: COLUMNS, rows: rows.map((r) => COLUMNS.map((c) => r[c] ?? '')), count: rows.length });

// ------------------------------------------------------------------ the answer, as data

test('each note gets the intent that speaks for it, and the value it draws', () => {
  const notes = notesOf('fake', intentsOf(fixedRows()));
  assert.deepEqual([...notes.keys()].sort(), ['alpha', 'beta', 'delta', 'epsilon', 'gamma'], 'another vault’s note is not ours');

  const alpha = notes.get('alpha')!;
  assert.equal(alpha.intent, ALPHA, 'the open intent outranks the superseded one');
  assert.deepEqual(alpha.others, ['aaaaaaaa-0000-4000-8000-000000000009']);
  assert.equal(alpha.draft, true, 'open, and the latest verdict is an agent’s: a draft');
  assert.equal(alpha.value, 'draft');
  assert.deepEqual(alpha.latest && { verdict: alpha.latest.verdict, by: alpha.latest.by }, { verdict: 'met', by: 'agent:claude' });

  assert.equal(notes.get('beta')!.value, 'open', 'open with no verdict');
  assert.equal(notes.get('gamma')!.value, 'met');
  assert.equal(notes.get('gamma')!.draft, false, 'the owner’s own verdict is not a draft');
  assert.equal(notes.get('epsilon')!.value, 'open', 'the owner said partial: open, and nothing waits on them');
  assert.equal(notes.get('delta')!.value, null, 'a proposed intent is a draft commitment, which the inbox already shows');

  assert.ok(isOwner('kernel:owner') && isOwner('owner') && !isOwner('agent:claude') && !isOwner(null));
});

test('the answer is folded into one intent each, read leniently, and refused whole only when it is not an answer', () => {
  const intents = intentsOf(fixedRows());
  const alpha = intents.find((i) => i.id === ALPHA)!;
  assert.deepEqual(alpha, {
    id: ALPHA,
    status: 'open',
    statement: 'Ship alpha',
    horizon: '2026-10-20',
    about: ['vault:fake:alpha'],
    latest: { verdict: 'met', by: 'agent:claude', at: '2026-10-15T09:00:00Z', note: 'the PR merged', evidence: 1 },
    proposedBy: null,
  });
  assert.equal(intents.find((i) => i.id === BETA)!.latest, null, '"" for no verdict is none');
  assert.equal(intents.find((i) => i.id === DELTA)!.proposedBy, 'agent:projector-intake');

  const rows = intentsOf(
    parseAnswer(
      answer([
        { intent: 'x1', alias: 'vault:v:x', status: ':open', statement: 's', verdict: ':met', by: 'agent:a', evidence: 'e1' },
        { intent: 'x1', alias: 'vault:v:y', status: ':open', statement: 's', verdict: ':met', by: 'agent:a', evidence: 'e2' },
        { intent: 'x1', alias: 'vault:v:x', status: ':open', statement: 's', verdict: ':met', by: 'agent:a', evidence: 'e2' },
        { status: 'open' },
        { intent: 'x2', status: 'imagined' },
      ]),
    ),
  );
  assert.equal(rows.length, 1, 'rows the reader cannot use are skipped, not fatal');
  assert.equal(rows[0]!.status, 'open', 'a keyword’s colon is dropped');
  assert.deepEqual(rows[0]!.about, ['vault:v:x', 'vault:v:y'], 'one row per alias, one intent');
  assert.equal(rows[0]!.latest!.verdict, 'met');
  assert.equal(rows[0]!.latest!.evidence, 2, 'one row per piece of evidence, counted once each');
  assert.throws(() => parseAnswer('[]'), /columns, rows/);
  assert.throws(() => parseAnswer('{"intents": []}'), /columns, rows/);
});

// ------------------------------------------------------------------ the reader

test('the reader asks once per index and TTL, with KERNEL_DB, and shares a read in flight', async () => {
  const v = vault();
  try {
    let clock = 1_000;
    const now = () => clock;
    const [a, b] = await Promise.all([kernelIndex(v.root, 'g1', { now }), kernelIndex(v.root, 'g1', { now })]);
    assert.equal(a, b, 'two callers, one read');
    assert.equal(a.reason, null);
    assert.equal(a.vault, 'fake');
    assert.equal(a.notes.get('alpha')!.value, 'draft');
    assert.deepEqual(v.calls(), [`${join(v.root, 'kdb')}|query --saved projector/vault-intents --in prefix=vault:fake: --limit 10000 --json`]);

    await kernelIndex(v.root, 'g1', { now });
    assert.equal(v.calls().length, 1, 'same index, inside the TTL: no second process');

    clock += 31_000;
    await kernelIndex(v.root, 'g1', { now });
    assert.equal(v.calls().length, 2, 'past the TTL the kernel is asked again — it changes on its own');

    await kernelIndex(v.root, 'g2', { now });
    assert.equal(v.calls().length, 3, 'a rebuilt index asks again');
  } finally {
    v.cleanup();
  }
});

test('a kernel that is absent is an empty answer and one warning, and a vault without one asks nothing', async () => {
  const lines: string[] = [];
  logTo((l) => lines.push(l));
  const missing = vault(`kernel:\n  enabled: true\n  bin: ${join(tmpdir(), 'no-such-kernel', 'bin', 'kernel')}\n  vault: fake\n`);
  const off = vault('');
  try {
    const first = await kernelIndex(missing.root, 'g1');
    assert.equal(first.enabled, true);
    assert.equal(first.notes.size, 0);
    assert.match(first.reason!, /ENOENT/);
    await kernelIndex(missing.root, 'g2');
    await kernelIndex(missing.root, 'g3');
    assert.equal(lines.filter((l) => l.includes('[WARN]') && l.includes('kernel')).length, 1, 'warned once, not per read');

    process.env.FAKE_KERNEL_FAIL = '1';
    const refused = await kernelIndex(missing.root, 'g4', { run: (async () => ({ code: 2, stdout: '', stderr: 'boot\nerror: store is locked {}\n' })) as Runner });
    assert.equal(refused.reason, 'kernel query projector/vault-intents exited 2: error: store is locked {}');

    const none = await kernelIndex(off.root, 'g1');
    assert.equal(none.enabled, false);
    assert.equal(none.reason, null);
    assert.deepEqual(off.calls(), [], 'not enabled: nothing spawned');
  } finally {
    logTo(null);
    missing.cleanup();
    off.cleanup();
  }
});

test('a kernel that refuses the query is an empty answer that says to register, and the next read recovers', async () => {
  const lines: string[] = [];
  logTo((l) => lines.push(l));
  const v = vault();
  try {
    process.env.FAKE_KERNEL_QUERY_FAIL = 'vault-intents';
    const refused = await kernelIndex(v.root, 'g1');
    assert.equal(refused.enabled, true);
    assert.equal(refused.notes.size, 0, 'no stored answer stands in for the kernel’s');
    assert.match(refused.reason!, /^kernel query projector\/vault-intents exited 1: error: no saved query projector\/vault-intents: .* — run `pj kernel register`$/);
    assert.equal(lines.filter((l) => l.includes('[WARN]') && l.includes('register')).length, 1);

    delete process.env.FAKE_KERNEL_QUERY_FAIL;
    const back = await kernelIndex(v.root, 'g2');
    assert.equal(back.reason, null);
    assert.equal(back.notes.get('alpha')!.value, 'draft');
  } finally {
    delete process.env.FAKE_KERNEL_QUERY_FAIL;
    logTo(null);
    v.cleanup();
  }
});

// ------------------------------------------------------------------ the derived axis

test('the kernel axis filters, groups and shows like any axis, and is never stored', async () => {
  const v = vault();
  try {
    const before = readFileSync(place(v.root, 'alpha.md'), 'utf8');
    const k = await kernelIndex(v.root, 'g1');
    const kernel = axisValues(k.notes);
    const { db, notes } = reindex(v.root);
    const deps = { facets: loadFacets(paths(v.root).facets), db, notes, views: [], today: '2026-10-16', kernel };

    const drafts = queryPayload(deps, parseSpec({ 'f.kernel': 'draft' }));
    assert.deepEqual(drafts.ids, ['alpha']);
    assert.deepEqual(drafts.notes.alpha!.computed.kernel, ['draft'], 'a card can show it');

    const board = queryPayload(deps, parseSpec({ group: 'kernel' }));
    assert.deepEqual(board.groupOrder.primary, [...KERNEL_VALUES, '(none)'], 'every value a column, in order, then the notes with no intent');
    const column = (value: string) => board.groups!.find((g) => g.value === value)!.ids.sort();
    assert.deepEqual(column('open'), ['beta', 'epsilon']);
    assert.deepEqual(column('met'), ['gamma']);
    assert.deepEqual(column('(none)'), ['delta', 'plain']);
    const axis = board.counts.find((c) => c.facet === 'kernel')!;
    assert.equal(axis.computed, true);

    // Without the kernel's answer the axis is simply not there to offer.
    const bare = queryPayload({ ...deps, kernel: undefined }, parseSpec({}));
    assert.equal(bare.counts.find((c) => c.facet === 'kernel'), undefined);

    db.close();
    assert.equal(readFileSync(place(v.root, 'alpha.md'), 'utf8'), before, 'C11: the note file holds nothing the kernel said');
    assert.equal(readAll(paths(v.root).notes).notes.get('alpha')!.facets.kernel, undefined);
  } finally {
    v.cleanup();
  }
});

// ------------------------------------------------------------------ the owner's answers

test('accept writes the draft’s verdict as the owner; overrule writes missed or partial; a closed intent is refused', async () => {
  const v = vault();
  try {
    const accepted = await decide(v.root, 'alpha', 'accept');
    assert.equal(accepted.ok, true);
    const db = join(v.root, 'kdb');
    assert.ok(
      v.calls().includes(`${db}|judge ${ALPHA} met --note accepted agent:claude's met in projector`),
      `judge as the owner — no --by, no other identity: ${v.calls().join('\n')}`,
    );

    await decide(v.root, 'alpha', 'overrule');
    assert.ok(v.calls().some((c) => c.startsWith(`${db}|judge ${ALPHA} missed`)));
    await decide(v.root, 'beta', 'overrule', { verdict: 'partial', note: 'half done' });
    assert.ok(v.calls().includes(`${db}|judge ${BETA} partial --note half done`), 'partial keeps it open');

    const closed = await decide(v.root, 'gamma', 'accept');
    assert.equal(closed.ok, false);
    assert.match((closed as { reason: string }).reason, /is met, not open/);
    const none = await decide(v.root, 'plain', 'accept');
    assert.match((none as { reason: string }).reason, /has no intent/);
    assert.equal(v.calls().filter((c) => c.includes('|judge ')).length, 3, 'a refusal never reached the kernel');
  } finally {
    v.cleanup();
  }
});

// ------------------------------------------------------------------ the asks

test('a note and its intent part ways: the note closed while the intent is open, or the other way — and nothing else asks', () => {
  const rows = fixedRows();
  const notes = notesOf('fake', intentsOf(rows));
  const life = lifecycleOf('status', { status: { closed: ['done', 'cancelled'] } });
  assert.deepEqual(askOf(notes.get('beta'), ['done'], life), { kind: 'judge', value: 'done' }, 'closed note, open intent');
  assert.equal(askOf(notes.get('beta'), ['active'], life), null, 'both open');
  assert.equal(askOf(notes.get('alpha'), ['done'], life), null, 'a draft already waits on it: the draft is the question');
  assert.deepEqual(
    askOf(notes.get('gamma'), ['active'], life),
    { kind: 'close', verdict: 'met', axis: 'status', values: ['done', 'cancelled'] },
    'met intent, open note: the values the facet calls closed, for the owner to pick',
  );
  assert.equal(askOf(notes.get('gamma'), ['cancelled'], life), null, 'any closed value agrees; which one is the owner’s word');
  assert.equal(askOf(notes.get('delta'), ['done'], life), null, 'a proposal is not asked about');
  assert.equal(askOf(notes.get('gamma'), ['active'], lifecycleOf('status', {})), null, 'no closed values declared, nothing to compare');
  assert.equal(askOf(undefined, ['done'], life), null, 'no intent, no ask');

  const held = new Map([
    ['alpha', { facets: { status: ['done'] } }],
    ['beta', { facets: { status: ['done'] } }],
    ['gamma', { facets: { status: ['active'] } }],
    ['epsilon', { facets: { status: ['active'] } }],
  ]);
  const axis = axisValues(notes, asking(life, held));
  assert.deepEqual(
    Object.fromEntries(axis),
    { alpha: 'draft', beta: 'ask', gamma: 'ask', epsilon: 'open' },
    'ask reads on the axis, a draft keeps its own word',
  );
  assert.deepEqual(Object.fromEntries(axisValues(notes)), { alpha: 'draft', beta: 'open', gamma: 'met', epsilon: 'open' }, 'without the notes, the kernel’s word alone');
});

// ------------------------------------------------------------------ pj kernel

const CLI = fileURLToPath(new URL('../src/cli/pj.ts', import.meta.url));

function pj(root: string, args: string[], env: Record<string, string> = {}): { out: string; err: string; code: number } {
  const clean: Record<string, string | undefined> = { ...process.env, PROJECTOR_NO_DELEGATE: '1' };
  for (const key of ['PROJECTOR_DATA', 'PROJECTOR_VAULTS']) delete clean[key];
  // Both streams, whatever the exit: a kernel that refuses is a line on stderr
  // from a command that still succeeds.
  const r = spawnSync(process.execPath, [CLI, '--vault', root, ...args], {
    encoding: 'utf8',
    env: { ...clean, PROJECTOR_VAULTS: join(root, 'registry.json'), ...env },
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
}

test('pj kernel status, accept and overrule drive the same reader and writer', () => {
  const v = vault();
  try {
    const status = pj(v.root, ['kernel', 'status']);
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /alpha\s+draft\s+aaaaaaaa\s+met by agent:claude 2026-10-15\s+Ship alpha/);
    assert.match(status.out, /alpha\s+\(superseded\)/, 'an outranked intent is listed by its status');
    assert.match(status.out, /delta\s+\(proposed\)/);
    assert.doesNotMatch(status.out, /zeta/, 'another vault’s intents are not this vault’s');
    assert.match(status.out, /1 drafted verdict\(s\) wait for you/);
    const json = JSON.parse(pj(v.root, ['kernel', 'status', '--json']).out);
    assert.equal(json.notes.alpha.value, 'draft');

    const accept = pj(v.root, ['kernel', 'accept', 'alpha']);
    assert.equal(accept.code, 0, accept.err);
    assert.match(accept.out, /alpha: met on intent aaaaaaaa/);
    const overrule = pj(v.root, ['kernel', 'overrule', 'beta', '--verdict', 'partial']);
    assert.equal(overrule.code, 0, overrule.err);
    assert.ok(v.calls().some((c) => c.includes(`judge ${ALPHA} met`)));
    assert.ok(v.calls().some((c) => c.includes(`judge ${BETA} partial`)));

    assert.equal(pj(v.root, ['kernel', 'overrule', 'beta', '--verdict', 'met']).code, 1, 'overrule is missed or partial');
    assert.match(pj(v.root, ['kernel', 'accept', 'gamma']).err, /not open/);
    assert.match(pj(v.root, ['kernel', 'status', '--nonsense']).err, /unknown flag --nonsense/);
    assert.equal(pj(v.root, ['kernel', 'frobnicate']).code, 1);

    // The axis reaches `pj ls` — the payload the app receives.
    const ls = JSON.parse(pj(v.root, ['ls', '--filter', 'kernel=draft', '--json']).out);
    assert.deepEqual(ls.ids, ['alpha']);
  } finally {
    v.cleanup();
  }
});

test('pj set records the status and asks; it never judges, and a refusing kernel fails nothing', () => {
  const v = vault();
  try {
    const set = pj(v.root, ['set', 'beta', '--facet', 'status=done']);
    assert.equal(set.code, 0, set.err);
    assert.match(set.out, /beta: status=done/);
    assert.match(set.out, /kernel: recorded \d+ change\(s\)/);
    assert.match(set.out, /kernel: beta is done and its intent bbbbbbbb is open — judge it: `pj kernel accept beta`/);
    assert.equal(v.calls().filter((c) => c.includes('|judge ')).length, 0, 'a status is a fact; the verdict is the owner’s to give');
    assert.ok(v.calls().some((c) => c.endsWith('|ingest --source system:projector --json')), 'recorded as the system, never as the owner');

    const refused = pj(v.root, ['set', 'alpha', '--facet', 'status=on-hold'], { FAKE_KERNEL_FAIL: '1' });
    assert.equal(refused.code, 0, 'the kernel is additional, never blocking');
    assert.match(refused.err, /kernel: changes not recorded — .*store is locked/);
    assert.deepEqual(readAll(paths(v.root).notes).notes.get('alpha')!.facets.status, ['on-hold'], 'C1: the file is written regardless');

    const status = pj(v.root, ['kernel', 'status']);
    assert.match(status.out, /1 note\(s\) and their intents part ways:\n {2}beta is done/);
    assert.equal(JSON.parse(pj(v.root, ['kernel', 'status', '--json']).out).asks[0].ask.kind, 'judge');
  } finally {
    v.cleanup();
  }
});

test('accept and overrule judge the intent and never touch the note', async () => {
  const v = vault();
  try {
    const before = readFileSync(place(v.root, 'alpha.md'), 'utf8');
    const accepted = await decide(v.root, 'alpha', 'accept');
    assert.equal(accepted.ok, true);
    assert.equal('file' in accepted, false);
    assert.equal(readFileSync(place(v.root, 'alpha.md'), 'utf8'), before, 'C1: the file is the vault’s; the verdict is the kernel’s');
  } finally {
    v.cleanup();
  }
});

test('the owner opens an intent about a note: its entity first, then capture --about, and one open intent at a time', async () => {
  const v = vault();
  try {
    const kdb = join(v.root, 'kdb');
    const opened = await openIntent(v.root, 'plain', { criterion: 'Done when plain ships', horizon: '2026-11-01' });
    assert.equal(opened.ok, true, opened.ok ? '' : opened.reason);
    const calls = v.calls();
    const i = calls.indexOf(`${kdb}|ingest --source system:projector --json`);
    assert.ok(i >= 0, 'the note’s entity, so the kernel can name it');
    assert.equal(calls[i + 1], `${kdb}|capture plain --criterion Done when plain ships --horizon 2026-11-01 --about vault:fake:plain`, 'as the owner: no --by');

    const custom = pj(v.root, ['kernel', 'intent', 'plain', '--statement', 'Plain, reviewed', '--criterion', 'a reviewer signs off']);
    assert.equal(custom.code, 0, custom.err);
    assert.match(custom.out, /^plain: intent \S+ opened/);
    assert.ok(v.calls().includes(`${kdb}|capture Plain, reviewed --criterion a reviewer signs off --about vault:fake:plain`));

    const twice = await openIntent(v.root, 'beta', { criterion: 'x' });
    assert.ok(!twice.ok && /already has an open intent, bbbbbbbb: answer it first/.test(twice.reason));
    const again = await openIntent(v.root, 'gamma', {});
    assert.equal(again.ok, true, 'a closed intent leaves room for a new one');
    assert.ok(v.calls().includes(`${kdb}|capture gamma --about vault:fake:gamma`), 'the title when no statement, the kernel’s criterion when none');

    const bad = await openIntent(v.root, 'plain', { horizon: 'next week' });
    assert.ok(!bad.ok && /YYYY-MM-DD/.test(bad.reason));
    const none = await openIntent(v.root, 'nope', {});
    assert.ok(!none.ok && /no note nope/.test(none.reason));
    assert.equal(pj(v.root, ['kernel', 'intent']).code, 1);
  } finally {
    v.cleanup();
  }
});

const SERVE = fileURLToPath(new URL('../src/server/serve.ts', import.meta.url));

/** The real server on a free port, against one registered vault. */
async function server(root: string): Promise<{ url: string; stop: () => void }> {
  const registry = join(root, 'registry.json');
  writeFileSync(registry, JSON.stringify({ vaults: [{ path: root, name: 'fake', addedAt: 0 }] }), 'utf8');
  const env: Record<string, string | undefined> = { ...process.env, PROJECTOR_PORT: '0', PROJECTOR_VAULTS: registry };
  delete env.PROJECTOR_DATA;
  const child = spawn(process.execPath, [SERVE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15_000);
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = out.match(/projector\s+(http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return { url, stop: () => child.kill() };
}

test('the panel’s routes do what the CLI does: a judgment, an intent, and what to ask — never a file write', async () => {
  const v = vault();
  const s = await server(v.root);
  try {
    const post = (path: string, body: object) =>
      fetch(`${s.url}/api/note/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Projector-Vault': v.root },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));
    const get = (id: string) =>
      fetch(`${s.url}/api/note/${id}`, { headers: { 'X-Projector-Vault': v.root } }).then((r) => r.json() as Promise<Record<string, unknown>>);

    const before = readFileSync(place(v.root, 'alpha.md'), 'utf8');
    const accept = await post('alpha/kernel', { decision: 'accept' });
    assert.equal(accept.status, 200, JSON.stringify(accept.json));
    assert.equal(accept.json.verdict, 'met');
    assert.equal('file' in accept.json, false);
    assert.equal(readFileSync(place(v.root, 'alpha.md'), 'utf8'), before);
    assert.equal((await post('beta/kernel', { decision: 'overrule', verdict: 'met' })).status, 400);

    const intent = await post('plain/intent', { criterion: 'Done when plain ships' });
    assert.equal(intent.status, 200, JSON.stringify(intent.json));
    assert.ok(v.calls().some((c) => c.endsWith('|capture plain --criterion Done when plain ships --about vault:fake:plain')));
    assert.equal((await post('beta/intent', {})).status, 409, 'beta’s intent is still open');

    const gamma = await get('gamma');
    assert.equal(gamma.kernelOn, true);
    assert.equal(gamma.ask, null, 'gamma is done and its intent met');
    writeFileSync(place(v.root, 'gamma.md'), '---\nid: gamma\ntitle: gamma\nfacets: { status: [active] }\n---\n\nbody\n', 'utf8');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual((await get('gamma')).ask, { kind: 'close', verdict: 'met', axis: 'status', values: ['done', 'cancelled'] });
  } finally {
    s.stop();
    v.cleanup();
  }
});
