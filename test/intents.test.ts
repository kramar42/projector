import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/config.ts';
import { loadFacets } from '../src/schema/facets.ts';
import { reindex, readAll } from '../src/index/indexer.ts';
import { queryPayload } from '../src/view/payload.ts';
import { parseSpec } from '../src/view/spec.ts';
import { settingsFor, settingsPath } from '../src/settings.ts';
import { logTo } from '../src/server/log.ts';
import { forgetKernel, kernelIndex } from '../src/kernel/read.ts';
import { axisValues, isOwner, KERNEL_VALUES, notesOf, parseIntents } from '../src/kernel/state.ts';
import { decide, snapshot, verdictFor, writeThrough } from '../src/kernel/write.ts';
import type { Runner } from '../src/intake/kernel.ts';
import { place } from './fixture.ts';

/**
 * Projector over the kernel: the reader, the `kernel` axis it feeds, the owner's
 * answers to a drafted verdict, the status write-through, and `pj kernel`.
 *
 * The kernel is played by `test/fake-kernel`, a shell script that prints a fixed
 * array of intents and records every call — so what is pinned here is exactly
 * the interface: which arguments projector passes, with which `KERNEL_DB`, and
 * what it makes of the answer. Nothing here starts the real kernel.
 */

const FAKE = fileURLToPath(new URL('./fake-kernel', import.meta.url));
chmodSync(FAKE, 0o755);

const ALPHA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BETA = 'bbbbbbbb-0000-4000-8000-000000000002';
const DELTA = 'dddddddd-0000-4000-8000-000000000004';

const VERDICTS = '  verdicts:\n    status: { done: met, on-hold: dropped, cancelled: dropped }\n';

function vault(kernel = `kernel:\n  enabled: true\n  bin: ${FAKE}\n  db: ./kdb\n  vault: fake\n${VERDICTS}`) {
  const root = mkdtempSync(join(tmpdir(), 'pj-intents-'));
  mkdirSync(paths(root).config, { recursive: true });
  writeFileSync(
    paths(root).facets,
    'status: { label: Status, values: [planning, active, on-hold, done, cancelled], open: false, single: true }\n',
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

const fixed = () => execFileSync(FAKE, ['intents', '--json'], { encoding: 'utf8', env: { ...process.env, FAKE_KERNEL_LOG: '' } });

// ------------------------------------------------------------------ the answer, as data

test('each note gets the intent that speaks for it, and the value it draws', () => {
  const notes = notesOf('fake', parseIntents(fixed()));
  assert.deepEqual([...notes.keys()].sort(), ['alpha', 'beta', 'delta', 'epsilon', 'gamma'], 'another vault’s note is not ours');

  const alpha = notes.get('alpha')!;
  assert.equal(alpha.intent, ALPHA, 'the open intent outranks the superseded one');
  assert.deepEqual(alpha.others, ['aaaaaaaa-0000-4000-8000-000000000009']);
  assert.equal(alpha.proposed, true, 'open, and the latest verdict is an agent’s: a draft');
  assert.equal(alpha.value, 'proposed-verdict');
  assert.deepEqual(alpha.latest && { verdict: alpha.latest.verdict, by: alpha.latest.by }, { verdict: 'met', by: 'agent:claude' });

  assert.equal(notes.get('beta')!.value, 'open', 'open with no verdict');
  assert.equal(notes.get('gamma')!.value, 'met');
  assert.equal(notes.get('gamma')!.proposed, false, 'the owner’s own verdict is not a draft');
  assert.equal(notes.get('epsilon')!.value, 'open', 'the owner said partial: open, and nothing waits on them');
  assert.equal(notes.get('delta')!.value, null, 'a proposed intent is a draft commitment, which the inbox already shows');

  assert.ok(isOwner('kernel:owner') && isOwner('owner') && !isOwner('agent:claude') && !isOwner(null));
});

test('the answer is read leniently, row by row, and refused whole only when it is not an array', () => {
  const rows = parseIntents(
    JSON.stringify([
      { id: 'x1', status: ':open', statement: 's', about: ['vault:v:x'], latest: { verdict: ':met', by: 'agent:a' } },
      { status: 'open' },
      { id: 'x2', status: 'imagined' },
      'not an intent',
    ]),
  );
  assert.equal(rows.length, 1, 'rows the reader cannot use are skipped, not fatal');
  assert.equal(rows[0]!.status, 'open', 'a keyword’s colon is dropped');
  assert.equal(rows[0]!.latest!.verdict, 'met');
  assert.throws(() => parseIntents('{"intents": []}'), /array/);
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
    assert.equal(a.notes.get('alpha')!.value, 'proposed-verdict');
    assert.deepEqual(v.calls(), [`${join(v.root, 'kdb')}|intents --json --about vault:fake:`]);

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
    assert.equal(refused.reason, 'kernel intents exited 2: error: store is locked {}');

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

// ------------------------------------------------------------------ the derived axis

test('the kernel axis filters, groups and shows like any axis, and is never stored', async () => {
  const v = vault();
  try {
    const before = readFileSync(place(v.root, 'alpha.md'), 'utf8');
    const k = await kernelIndex(v.root, 'g1');
    const kernel = axisValues(k.notes);
    const { db, notes } = reindex(v.root);
    const deps = { facets: loadFacets(paths(v.root).facets), db, notes, views: [], today: '2026-10-16', kernel };

    const drafts = queryPayload(deps, parseSpec({ 'f.kernel': 'proposed-verdict' }));
    assert.deepEqual(drafts.ids, ['alpha']);
    assert.deepEqual(drafts.notes.alpha!.computed.kernel, ['proposed-verdict'], 'a card can show it');

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
      v.calls().includes(`${db}|observe ${ALPHA} met --note accepted agent:claude's met in projector`),
      `observe as the owner — no --by, no other identity: ${v.calls().join('\n')}`,
    );

    await decide(v.root, 'alpha', 'overrule');
    assert.ok(v.calls().some((c) => c.startsWith(`${db}|observe ${ALPHA} missed`)));
    await decide(v.root, 'beta', 'overrule', { verdict: 'partial', note: 'half done' });
    assert.ok(v.calls().includes(`${db}|observe ${BETA} partial --note half done`), 'partial keeps it open');

    const closed = await decide(v.root, 'gamma', 'accept');
    assert.equal(closed.ok, false);
    assert.match((closed as { reason: string }).reason, /is met, not open/);
    const none = await decide(v.root, 'plain', 'accept');
    assert.match((none as { reason: string }).reason, /has no intent/);
    assert.equal(v.calls().filter((c) => c.includes('observe')).length, 3, 'a refusal never reached the kernel');
  } finally {
    v.cleanup();
  }
});

// ------------------------------------------------------------------ status write-through

test('a status value maps to a verdict only when it arrives, and only through the vault’s own map', () => {
  const v = vault();
  const map = settingsFor(v.root).kernel.verdicts;
  v.cleanup();
  assert.deepEqual(map, { status: { done: 'met', 'on-hold': 'dropped', cancelled: 'dropped' } });
  const s = (v: string) => ({ status: v ? [v] : [] });

  assert.deepEqual(verdictFor(map, s('active'), s('done')), { axis: 'status', value: 'done', verdict: 'met' });
  assert.deepEqual(verdictFor(map, s('active'), s('on-hold'))?.verdict, 'dropped');
  assert.deepEqual(verdictFor(map, s('planning'), s('cancelled'))?.verdict, 'dropped');
  assert.equal(verdictFor(map, s('planning'), s('active')), null, 'not a verdict');
  assert.equal(verdictFor(map, s('done'), s('done')), null, 're-saving says nothing new');
  assert.equal(verdictFor(map, s('on-hold'), s('cancelled')), null, 'dropped to dropped says nothing new');
  assert.equal(verdictFor(map, s('done'), s('')), null, 'clearing the axis is not a verdict');
  assert.equal(verdictFor({}, s('active'), s('done')), null, 'no map, no write-through');
});

test('setting a status tells the kernel after the vault, skipping what is not open, and failing quietly', async () => {
  const v = vault();
  try {
    const axes = ['status'];
    const before = snapshot(readAll(paths(v.root).notes).notes, ['alpha', 'delta', 'gamma', 'plain', 'beta'], axes);
    const after = new Map(before);
    after.set('alpha', { status: ['done'] });
    after.set('delta', { status: ['cancelled'] });
    after.set('gamma', { status: ['on-hold'] });
    after.set('plain', { status: ['done'] });
    after.set('beta', { status: ['planning'] });

    const results = await writeThrough(v.root, before, after);
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(by.alpha!.outcome, 'written');
    assert.equal(by.delta!.outcome, 'written', 'dropped on a proposed intent is the owner declining it');
    assert.equal(by.gamma!.outcome, 'skipped', 'a met intent is not reopened from a status');
    assert.equal(by.plain, undefined, 'a note with no intent is not a result');
    assert.equal(by.beta, undefined, 'planning is not a verdict');
    const observed = v.calls().filter((c) => c.includes('observe'));
    assert.deepEqual(observed, [
      `${join(v.root, 'kdb')}|observe ${ALPHA} met --note status set to done in projector`,
      `${join(v.root, 'kdb')}|observe ${DELTA} dropped --note status set to cancelled in projector`,
    ]);

    process.env.FAKE_KERNEL_FAIL = '1';
    const failed = await writeThrough(v.root, before, after);
    assert.ok(failed.length && failed.every((r) => r.outcome === 'failed'), 'reported, not thrown');
  } finally {
    v.cleanup();
  }
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
    assert.match(status.out, /alpha\s+proposed-verdict\s+aaaaaaaa\s+met by agent:claude 2026-10-15\s+Ship alpha/);
    assert.match(status.out, /alpha\s+\(superseded\)/, 'an outranked intent is listed by its status');
    assert.match(status.out, /delta\s+\(proposed\)/);
    assert.doesNotMatch(status.out, /zeta/, 'another vault’s intents are not this vault’s');
    assert.match(status.out, /1 drafted verdict\(s\) wait for you/);
    const json = JSON.parse(pj(v.root, ['kernel', 'status', '--json']).out);
    assert.equal(json.notes.alpha.value, 'proposed-verdict');

    const accept = pj(v.root, ['kernel', 'accept', 'alpha']);
    assert.equal(accept.code, 0, accept.err);
    assert.match(accept.out, /alpha: met on intent aaaaaaaa/);
    const overrule = pj(v.root, ['kernel', 'overrule', 'beta', '--verdict', 'partial']);
    assert.equal(overrule.code, 0, overrule.err);
    assert.ok(v.calls().some((c) => c.includes(`observe ${ALPHA} met`)));
    assert.ok(v.calls().some((c) => c.includes(`observe ${BETA} partial`)));

    assert.equal(pj(v.root, ['kernel', 'overrule', 'beta', '--verdict', 'met']).code, 1, 'overrule is missed or partial');
    assert.match(pj(v.root, ['kernel', 'accept', 'gamma']).err, /not open/);
    assert.match(pj(v.root, ['kernel', 'status', '--nonsense']).err, /unknown flag --nonsense/);
    assert.equal(pj(v.root, ['kernel', 'frobnicate']).code, 1);

    // The axis reaches `pj ls` — the payload the app receives.
    const ls = JSON.parse(pj(v.root, ['ls', '--filter', 'kernel=proposed-verdict', '--json']).out);
    assert.deepEqual(ls.ids, ['alpha']);
  } finally {
    v.cleanup();
  }
});

test('pj set writes the note first and tells the kernel second; a refusing kernel fails nothing', () => {
  const v = vault();
  try {
    const set = pj(v.root, ['set', 'beta', '--facet', 'status=done']);
    assert.equal(set.code, 0, set.err);
    assert.match(set.out, /beta: status=done/);
    assert.match(set.out, /kernel: beta: status=done → kernel met on bbbbbbbb/);
    assert.ok(v.calls().includes(`${join(v.root, 'kdb')}|observe ${BETA} met --note status set to done in projector`));

    const quiet = pj(v.root, ['set', 'epsilon', '--facet', 'status=planning']);
    assert.equal(quiet.code, 0);
    assert.equal(v.calls().filter((c) => c.includes('observe')).length, 1, 'planning is not a verdict');

    const refused = pj(v.root, ['set', 'alpha', '--facet', 'status=on-hold'], { FAKE_KERNEL_FAIL: '1' });
    assert.equal(refused.code, 0, 'the kernel is additional, never blocking');
    assert.match(refused.err, /kernel: alpha: status=on-hold → kernel dropped not written: .*store is locked/);
    assert.deepEqual(readAll(paths(v.root).notes).notes.get('alpha')!.facets.status, ['on-hold'], 'C1: the file is written regardless');
  } finally {
    v.cleanup();
  }
});
