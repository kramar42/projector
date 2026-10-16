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
import { settingsFor, settingsPath } from '../src/settings.ts';
import { logTo } from '../src/server/log.ts';
import { forgetKernel, kernelIndex } from '../src/kernel/read.ts';
import { axisValues, intentsOf, isOwner, KERNEL_VALUES, notesOf } from '../src/kernel/state.ts';
import { parseAnswer } from '../src/kernel/query.ts';
import { decide, snapshot, valueFor, verdictFor, writeThrough } from '../src/kernel/write.ts';
import type { Runner } from '../src/intake/kernel.ts';
import { place } from './fixture.ts';

/**
 * Projector over the kernel: the reader, the `kernel` axis it feeds, the owner's
 * answers to a drafted verdict, the status write-through, and `pj kernel`.
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

const fixed = () =>
  execFileSync(FAKE, ['query', '--saved', 'projector/vault-intents', '--json'], { encoding: 'utf8', env: { ...process.env, FAKE_KERNEL_LOG: '' } });

/** The fixed answer's rows, by column. */
const fixedRows = () => parseAnswer(fixed());

const COLUMNS = ['intent', 'alias', 'status', 'statement', 'horizon', 'verdict', 'by', 'at', 'note', 'evidence', 'proposer'];

/** An answer to `vault-intents`, as the kernel prints it, from rows by column. */
const answer = (rows: Record<string, unknown>[]) =>
  JSON.stringify({ columns: COLUMNS, rows: rows.map((r) => COLUMNS.map((c) => r[c] ?? '')), count: rows.length });

/** A directory the fake kernel answers `vault-intents` from instead of its fixture. */
function holding(root: string, rows: Record<string, unknown>[]): string {
  const dir = join(root, 'kernel-answers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'vault-intents.json'), answer(rows), 'utf8');
  return dir;
}

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
    assert.equal(by.delta!.outcome, 'written', 'dropped on a proposed intent is the owner dropping it');
    assert.equal(by.gamma!.outcome, 'skipped', 'a met intent is not reopened from a status');
    assert.equal(by.plain, undefined, 'a note with no intent is not a result');
    assert.equal(by.beta, undefined, 'planning is not a verdict');
    const judged = v.calls().filter((c) => c.includes('|judge '));
    assert.deepEqual(judged, [
      `${join(v.root, 'kdb')}|judge ${ALPHA} met --note status set to done in projector`,
      `${join(v.root, 'kdb')}|judge ${DELTA} dropped --note status set to cancelled in projector`,
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

test('pj set writes the note first and tells the kernel second; a refusing kernel fails nothing', () => {
  const v = vault();
  try {
    const set = pj(v.root, ['set', 'beta', '--facet', 'status=done']);
    assert.equal(set.code, 0, set.err);
    assert.match(set.out, /beta: status=done/);
    assert.match(set.out, /kernel: beta: status=done → kernel met on bbbbbbbb/);
    assert.ok(v.calls().includes(`${join(v.root, 'kdb')}|judge ${BETA} met --note status set to done in projector`));

    const quiet = pj(v.root, ['set', 'epsilon', '--facet', 'status=planning']);
    assert.equal(quiet.code, 0);
    assert.equal(v.calls().filter((c) => c.includes('|judge ')).length, 1, 'planning is not a verdict');

    const refused = pj(v.root, ['set', 'alpha', '--facet', 'status=on-hold'], { FAKE_KERNEL_FAIL: '1' });
    assert.equal(refused.code, 0, 'the kernel is additional, never blocking');
    assert.match(refused.err, /kernel: alpha: status=on-hold → kernel dropped not written: .*store is locked/);
    assert.deepEqual(readAll(paths(v.root).notes).notes.get('alpha')!.facets.status, ['on-hold'], 'C1: the file is written regardless');
  } finally {
    v.cleanup();
  }
});

// ------------------------------------------------------------------ the verdict, back into the note

const status = (root: string, id: string) => readAll(paths(root).notes).notes.get(id)!.facets.status;
const bytes = (root: string, id: string) => readFileSync(place(root, `${id}.md`), 'utf8');
const judges = (v: { calls: () => string[] }) => v.calls().filter((c) => c.includes('|judge '));

test('the map read backwards: the first value for a verdict, or the one onVerdict chooses', () => {
  const v = vault(
    `kernel:\n  enabled: true\n  bin: ${FAKE}\n  vault: fake\n${VERDICTS}` +
      '  onVerdict:\n    status: { dropped: cancelled, met: cancelled }\n    nope: { met: done }\n',
  );
  try {
    const cfg = settingsFor(v.root).kernel;
    assert.deepEqual(cfg.onVerdict, { status: { dropped: 'cancelled' } }, 'a choice the forward map does not back is dropped');
    assert.deepEqual(valueFor(cfg, 'met'), { axis: 'status', value: 'done' });
    assert.deepEqual(valueFor(cfg, 'dropped'), { axis: 'status', value: 'cancelled' }, 'onVerdict chooses');
    assert.equal(valueFor(cfg, 'missed'), null, 'nothing maps to missed');
    assert.deepEqual(valueFor({ ...cfg, onVerdict: {} }, 'dropped'), { axis: 'status', value: 'on-hold' }, 'else the first');
    assert.equal(valueFor({ ...cfg, verdicts: {} }, 'met'), null);
  } finally {
    v.cleanup();
  }
});

test('accept writes the mapped value into the file, and the kernel is told exactly once', () => {
  const v = vault();
  try {
    const accept = pj(v.root, ['kernel', 'accept', 'alpha']);
    assert.equal(accept.code, 0, accept.err);
    assert.match(accept.out, /alpha: met on intent aaaaaaaa/);
    assert.match(accept.out, /alpha: status active → done in the file \(kernel met\)/);
    assert.deepEqual(status(v.root, 'alpha'), ['done'], 'the status chip now agrees with the kernel');
    assert.deepEqual(judges(v), [`${join(v.root, 'kdb')}|judge ${ALPHA} met --note accepted agent:claude's met in projector`]);

    // An overrule that closes the intent writes too; one nothing maps to says so and writes nothing.
    const dropped = pj(v.root, ['kernel', 'overrule', 'beta', '--verdict', 'dropped']);
    assert.equal(dropped.code, 0, dropped.err);
    assert.deepEqual(status(v.root, 'beta'), ['on-hold'], 'the first value mapping to dropped');
    const before = bytes(v.root, 'epsilon');
    const missed = pj(v.root, ['kernel', 'overrule', 'epsilon']);
    assert.equal(missed.code, 0, missed.err);
    assert.match(missed.out, /^epsilon: the file is unchanged — no status value maps to missed in kernel\.verdicts$/m);
    assert.equal(bytes(v.root, 'epsilon'), before);
    assert.equal(judges(v).length, 3, 'one judgment per answer, none from the file writes');
  } finally {
    v.cleanup();
  }
});

test('partial keeps the intent open and leaves the file untouched', async () => {
  const v = vault();
  try {
    const before = bytes(v.root, 'alpha');
    const res = await decide(v.root, 'alpha', 'overrule', { verdict: 'partial' });
    assert.equal(res.ok, true);
    assert.equal((res as { file: unknown }).file, null);
    const cli = pj(v.root, ['kernel', 'overrule', 'beta', '--verdict', 'partial']);
    assert.equal(cli.code, 0, cli.err);
    assert.doesNotMatch(cli.out, /file/, 'partial says nothing about the file, because it writes nothing');
    assert.equal(bytes(v.root, 'alpha'), before);
    assert.deepEqual(status(v.root, 'beta'), ['active']);
    assert.equal(judges(v).length, 2);
  } finally {
    v.cleanup();
  }
});

/** The fixed answer with some intents closed while their files still read open, as a directory the fake kernel answers from. */
function closedWhileOpen(root: string): string {
  const gone = new Set(fixedRows().filter((r) => ['vault:fake:beta', 'vault:fake:epsilon'].includes(r.alias as string)).map((r) => r.intent));
  const extra = [
    { intent: 'bbbbbbbb-0000-4000-8000-000000000002', alias: 'vault:fake:beta', status: 'met', statement: 'Write beta', verdict: 'met', by: 'owner' },
    { intent: '11111111-0000-4000-8000-000000000007', alias: 'vault:fake:plain', status: 'dropped', statement: 'Plain', verdict: 'dropped', by: 'owner' },
    { intent: '22222222-0000-4000-8000-000000000008', alias: 'vault:fake:epsilon', status: 'missed', statement: 'Epsilon', verdict: 'missed', by: 'owner' },
  ];
  return holding(root, [...fixedRows().filter((r) => !gone.has(r.intent)), ...extra]);
}

test('pj kernel status lists what disagrees, and pj kernel sync writes the files without judging', () => {
  const v = vault(`kernel:\n  enabled: true\n  bin: ${FAKE}\n  vault: fake\n${VERDICTS}  onVerdict:\n    status: { dropped: cancelled }\n`);
  try {
    const env = { FAKE_KERNEL_QUERIES: closedWhileOpen(v.root) };
    const listed = pj(v.root, ['kernel', 'status'], env);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /3 file\(s\) disagree with the kernel:/);
    assert.match(listed.out, /beta: kernel reads met on bbbbbbbb, the file says status=active — `pj kernel sync` writes done/);
    assert.match(listed.out, /plain: kernel reads dropped on 11111111, the file says status=active — `pj kernel sync` writes cancelled/);
    assert.match(listed.out, /epsilon: kernel reads missed on 22222222, the file says status=active — no status value maps to missed/);
    assert.doesNotMatch(listed.out, /gamma: kernel reads/, 'met in the kernel and done in the file agree');
    assert.equal(JSON.parse(pj(v.root, ['kernel', 'status', '--json'], env).out).disagreements.length, 3);

    const epsilon = bytes(v.root, 'epsilon');
    const sync = pj(v.root, ['kernel', 'sync'], env);
    assert.equal(sync.code, 0, sync.err);
    assert.deepEqual(sync.out.trim().split('\n'), [
      'beta: status active → done in the file (kernel met)',
      'epsilon: the file is unchanged — no status value maps to missed in kernel.verdicts',
      'plain: status active → cancelled in the file (kernel dropped)',
    ]);
    assert.deepEqual(status(v.root, 'beta'), ['done']);
    assert.deepEqual(status(v.root, 'plain'), ['cancelled']);
    assert.equal(bytes(v.root, 'epsilon'), epsilon);
    assert.deepEqual(judges(v), [], 'sync reads the kernel; it never judges');

    const after = pj(v.root, ['kernel', 'status'], env);
    assert.match(after.out, /1 file\(s\) disagree/, 'only the one nothing maps to is left');
    assert.match(pj(v.root, ['kernel', 'sync'], env).out, /^epsilon: the file is unchanged/);
  } finally {
    v.cleanup();
  }
});

test('a vault without kernel.verdicts never touches a file', () => {
  const v = vault(`kernel:\n  enabled: true\n  bin: ${FAKE}\n  db: ./kdb\n  vault: fake\n`);
  try {
    const env = { FAKE_KERNEL_QUERIES: closedWhileOpen(v.root) };
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'plain'];
    const before = ids.map((id) => bytes(v.root, id));

    const accept = pj(v.root, ['kernel', 'accept', 'alpha']);
    assert.equal(accept.code, 0, accept.err);
    assert.match(accept.out, /^alpha: the file is unchanged — kernel\.verdicts is not set$/m);
    assert.equal(judges(v).length, 1, 'the kernel is still told');

    const status = pj(v.root, ['kernel', 'status'], env);
    assert.doesNotMatch(status.out, /disagree/, 'no lifecycle named, nothing to disagree on');
    assert.match(pj(v.root, ['kernel', 'sync'], env).out, /nothing to sync/);
    assert.deepEqual(ids.map((id) => bytes(v.root, id)), before);
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

test('the panel’s route does what the CLI does: one judgment, then the mapped value in the file', async () => {
  const v = vault();
  const s = await server(v.root);
  try {
    const post = (id: string, body: object) =>
      fetch(`${s.url}/api/note/${id}/kernel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Projector-Vault': v.root },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));

    const accept = await post('alpha', { decision: 'accept' });
    assert.equal(accept.status, 200, JSON.stringify(accept.json));
    assert.equal(accept.json.verdict, 'met');
    assert.deepEqual(accept.json.file, { outcome: 'written', axis: 'status', value: 'done', was: ['active'] });
    assert.equal(accept.json.fileLine, 'alpha: status active → done in the file (kernel met)');
    assert.deepEqual(status(v.root, 'alpha'), ['done']);

    const before = bytes(v.root, 'beta');
    const partial = await post('beta', { decision: 'overrule', verdict: 'partial' });
    assert.equal(partial.status, 200);
    assert.equal(partial.json.file, null);
    assert.equal(bytes(v.root, 'beta'), before);
    assert.equal((await post('beta', { decision: 'overrule', verdict: 'met' })).status, 400);

    // The write-through runs after a response, so give it the moment it would take.
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(judges(v), [
      `${join(v.root, 'kdb')}|judge ${ALPHA} met --note accepted agent:claude's met in projector`,
      `${join(v.root, 'kdb')}|judge ${BETA} partial --note partial, said in projector`,
    ]);
  } finally {
    s.stop();
    v.cleanup();
  }
});
