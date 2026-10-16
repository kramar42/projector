import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { appRoot, paths } from '../src/config.ts';
import { DatabaseSync } from 'node:sqlite';
import { closeIntakeDb, openIntakeDb } from '../src/intake/db.ts';
import { commitmentState, importBatch, importNotes, planImport, statusesOf, type ImportBatch } from '../src/kernel/import.ts';
import { eventId, parseAnswer } from '../src/kernel/query.ts';
import { MANIFEST, register } from '../src/kernel/register.ts';
import { kernelBatch } from '../src/intake/kernel.ts';
import { forgetSettings, settingsFor, settingsPath, type Settings } from '../src/settings.ts';
import { place } from './fixture.ts';

/**
 * `pj kernel import` and `pj kernel register`: projector as a registered kernel
 * system that owns its adapter. Pinned here: the batch a vault maps to — which
 * notes are commitments and in which state, the status events and their keys,
 * the days — through the vault's own configuration and nothing the code knows
 * about any facet value (C4); the status events read back from the kernel
 * through `projector/vault-status-events`, which make a repeated status `@n`
 * and an unchanged one nothing; the command against `test/fake-kernel`, which
 * records every batch it is given and answers that query with what a test says
 * the kernel holds; and the manifest the batches and the queries must fit.
 */

const FAKE = fileURLToPath(new URL('./fake-kernel', import.meta.url));
chmodSync(FAKE, 0o755);

const CONFIG = (bin = FAKE) =>
  [
    'kernel:',
    '  enabled: true',
    `  bin: ${bin}`,
    '  db: ./kdb',
    '  vault: scratch',
    '  verdicts:',
    '    status: { done: met, cancelled: dropped }',
    '  commitments:',
    '    axis: status',
    '    open: [active]',
    '    horizon: due',
    '  days: daily',
    '',
  ].join('\n');

const note = (id: string, title: string, facets: string, body = 'body') =>
  `---\nid: ${id}\ntitle: ${title}\nfacets: { ${facets} }\n---\n\n${body}\n`;

/** An active note, a done one, one in planning, one on hold, a thought, a card and two days. */
function scratch(config = CONFIG()) {
  const root = mkdtempSync(join(tmpdir(), 'pj-import-'));
  mkdirSync(paths(root).config, { recursive: true });
  writeFileSync(
    paths(root).facets,
    [
      'status: { label: Status, values: [planning, active, on-hold, done, cancelled], open: false, single: true }',
      'due: { label: Due, type: date, single: true }',
      'day: { label: Day, type: date, single: true }',
      '',
    ].join('\n'),
    'utf8',
  );
  const files: [string, string][] = [
    ['ship.md', note('ship', 'Ship the widget', 'status: [active], due: [2026-10-19]', 'The widget.\n\nDone when the widget is live.')],
    ['shipped.md', note('shipped', 'Ship the gadget', 'status: [done]')],
    ['someday.md', note('someday', 'Think about a gizmo', 'status: [planning]')],
    ['paused.md', note('paused', 'Paused work', 'status: [on-hold]')],
    ['thought.md', note('thought', 'Just a thought', '')],
    ['inbox/card.md', note('card', 'A card', 'status: [active]')],
    ['daily/2026-10-14.md', note('2026-10-14', 'Tuesday', 'day: [2026-10-14]', 'Shipped the gadget.')],
    ['daily/day-2026-10-15.md', note('day-2026-10-15', 'Wednesday', 'day: [2026-10-15]', 'Started the widget.')],
  ];
  for (const [name, text] of files) {
    const file = place(root, name);
    writeFileSync(file, text, 'utf8');
    utimesSync(file, new Date('2026-10-15T10:00:00Z'), new Date('2026-10-15T10:00:00Z'));
  }
  writeFileSync(settingsPath(root), config, 'utf8');
  const log = join(root, 'kernel-calls.log');
  const batches = join(root, 'batches.jsonl');
  const answers = join(root, 'kernel-answers');
  mkdirSync(answers, { recursive: true });
  const taken = (): ImportBatch[] =>
    existsSync(batches) ? readFileSync(batches, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return {
    root,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    batches: taken,
    /** The fake kernel now answers `vault-status-events` with every status event of the batches it took, as the real one would. */
    holds: () => writeFileSync(join(answers, 'vault-status-events.json'), statusAnswer(taken().flatMap((b) => b.events)), 'utf8'),
    env: { FAKE_KERNEL_LOG: log, FAKE_KERNEL_BATCHES: batches, FAKE_KERNEL_QUERIES: answers },
    cleanup: () => {
      closeIntakeDb(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * `projector/vault-status-events` as the kernel answers it for these events:
 * once per key, newest first, each event by the id the kernel derives from its
 * key and never by the key itself.
 */
function statusAnswer(events: ImportBatch['events']): string {
  const once = new Map(events.filter((e) => e.kind === 'vault/status').map((e) => [e.key, e]));
  const rows = [...once.values()]
    .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))
    .map((e) => [e.about[0], eventId(e.key), new Date(e.at!).toISOString().replace('.000Z', 'Z'), e.payload]);
  return JSON.stringify({ columns: ['note', 'event', 'at', 'payload'], rows, count: rows.length });
}

const CLI = fileURLToPath(new URL('../src/cli/pj.ts', import.meta.url));

function pj(root: string, args: string[], env: Record<string, string> = {}): { out: string; err: string; code: number } {
  const clean: Record<string, string | undefined> = { ...process.env, PROJECTOR_NO_DELEGATE: '1' };
  for (const key of ['PROJECTOR_DATA', 'PROJECTOR_VAULTS', 'FAKE_KERNEL_FAIL', 'FAKE_KERNEL_LOG', 'FAKE_KERNEL_BATCHES', 'FAKE_KERNEL_QUERIES', 'FAKE_KERNEL_QUERY_FAIL']) {
    delete clean[key];
  }
  const r = spawnSync(process.execPath, [CLI, '--vault', root, ...args], {
    encoding: 'utf8',
    env: { ...clean, PROJECTOR_VAULTS: join(root, 'registry.json'), ...env },
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
}

// ------------------------------------------------------------------ the mapping

test('a vault maps to entities, commitments, status events and days, through its own map', async () => {
  const v = scratch();
  try {
    const planned = await planImport(v.root);
    assert.ok(planned.ok, planned.ok ? '' : planned.reason);
    const { batch, skipped, vault } = planned.plan;
    assert.equal(vault, 'scratch');

    assert.deepEqual(
      batch.commitments.map((c) => [c.key, c.state]),
      [
        ['vault:scratch:paused', 'none'],
        ['vault:scratch:ship', 'open'],
        ['vault:scratch:shipped', 'met'],
        ['vault:scratch:someday', 'none'],
      ],
      'active is open, done met; planning and on-hold are no commitment; the thought, the card and the days are not reported',
    );
    const ship = batch.commitments.find((c) => c.key === 'vault:scratch:ship')!;
    assert.deepEqual(ship, {
      key: 'vault:scratch:ship',
      statement: 'Ship the widget',
      criterion: 'Done when the widget is live.',
      horizon: '2026-10-19',
      about: ['vault:scratch:ship'],
      state: 'open',
      evidence: ['vault:scratch:ship:active'],
    });
    assert.equal(
      batch.commitments.find((c) => c.key === 'vault:scratch:shipped')!.criterion,
      'status done in the vault',
      'without a Done when line, the values the vault maps to met',
    );

    const status = batch.events.filter((e) => e.kind === 'vault/status');
    assert.deepEqual(
      status.map((e) => e.key),
      ['vault:scratch:paused:on-hold', 'vault:scratch:ship:active', 'vault:scratch:shipped:done', 'vault:scratch:someday:planning'],
      'the kernel’s old vault reader’s keys, so a store that imported this vault before stays continuous',
    );
    assert.deepEqual(status[1], {
      key: 'vault:scratch:ship:active',
      kind: 'vault/status',
      at: '2026-10-15T10:00:00.000Z',
      about: ['vault:scratch:ship'],
      payload: { vault: 'scratch', id: 'ship', axis: 'status', status: 'active', path: 'notes/ship.md' },
    });

    const days = batch.events.filter((e) => e.kind === 'vault/day');
    assert.deepEqual(days, [
      {
        key: 'vault:scratch:day:2026-10-14',
        kind: 'vault/day',
        at: '2026-10-14',
        about: ['vault:scratch:2026-10-14'],
        payload: { vault: 'scratch', id: '2026-10-14', date: '2026-10-14', path: 'daily/2026-10-14.md', title: 'Tuesday', text: 'Shipped the gadget.' },
      },
      {
        key: 'vault:scratch:day:2026-10-15',
        kind: 'vault/day',
        at: '2026-10-15',
        about: ['vault:scratch:day-2026-10-15'],
        payload: {
          vault: 'scratch',
          id: 'day-2026-10-15',
          date: '2026-10-15',
          path: 'daily/day-2026-10-15.md',
          title: 'Wednesday',
          text: 'Started the widget.',
        },
      },
    ]);

    assert.deepEqual(
      batch.entities.map((e) => e.alias).sort(),
      [
        'vault:scratch:2026-10-14',
        'vault:scratch:day-2026-10-15',
        'vault:scratch:paused',
        'vault:scratch:ship',
        'vault:scratch:shipped',
        'vault:scratch:someday',
      ],
      'an entity per note with a commitment or a day',
    );
    assert.ok(batch.entities.every((e) => e.kind === 'note'));
    assert.deepEqual(batch.proposals, []);
    assert.deepEqual(batch.links, []);
    assert.deepEqual(skipped, []);
  } finally {
    v.cleanup();
  }
});

test('the kernel’s status events decide the next: nothing unchanged, @n for a repeat, none for a value gone', () => {
  const v = scratch();
  try {
    const cfg = settingsFor(v.root).kernel;
    const notes = importNotes(v.root);
    const event = (key: string, at: string, status: string | null) => {
      const alias = key.slice(0, key.lastIndexOf(':'));
      const id = alias.slice(alias.lastIndexOf(':') + 1);
      return { key, kind: 'vault/status', at, about: [alias], payload: { vault: 'scratch', id, axis: 'status', status, path: `notes/${id}.md` } };
    };
    // What the kernel answers: ids, not keys, and newest first.
    const answer = parseAnswer(
      statusAnswer([
        // active → done → active again → done again: the third change is a repeat, and so is the fourth.
        event('vault:scratch:ship:active', '2026-10-15T08:00:00.000Z', 'active'),
        event('vault:scratch:ship:done', '2026-10-15T09:00:00.000Z', 'done'),
        event('vault:scratch:ship:active@2', '2026-10-15T10:00:00.000Z', 'active'),
        event('vault:scratch:ship:done@3', '2026-10-16T00:00:00.000Z', 'done'),
        // unchanged since the last import.
        event('vault:scratch:shipped:done', '2026-10-15T10:00:00.000Z', 'done'),
        // was active; the thought has no status now.
        event('vault:scratch:thought:active', '2026-10-15T09:00:00.000Z', 'active'),
        // another vault's note, whose alias only starts like this vault's.
        event('vault:scratchpad:x:active', '2026-10-15T09:00:00.000Z', 'active'),
      ]),
    );
    const sent = statusesOf('scratch', answer);
    assert.deepEqual(
      sent.get('ship'),
      {
        keys: ['vault:scratch:ship:active', 'vault:scratch:ship:done', 'vault:scratch:ship:active@2', 'vault:scratch:ship:done@3'],
        status: 'done',
        at: '2026-10-16T00:00:00.000Z',
      },
      'each key recovered from the id the kernel derived from it, oldest first',
    );
    assert.deepEqual([...sent.keys()], ['ship', 'shipped', 'thought']);

    const { batch } = importBatch('scratch', cfg, notes, sent);
    const status = Object.fromEntries(batch.events.filter((e) => e.kind === 'vault/status').map((e) => [e.payload.id, e]));

    assert.equal(status.ship!.key, 'vault:scratch:ship:active@4');
    assert.equal(status.ship!.at, '2026-10-16T00:00:00.001Z', 'after the change before it, though the file is older');
    assert.equal(status.ship!.payload.previous, 'done');
    assert.equal(status.shipped, undefined, 'an unchanged status is no event');
    assert.equal(status.thought!.key, 'vault:scratch:thought:none');
    assert.equal(status.thought!.payload.status, null);

    const by = Object.fromEntries(batch.commitments.map((c) => [c.key, c]));
    assert.deepEqual(by['vault:scratch:shipped']!.evidence, ['vault:scratch:shipped:done'], 'an unchanged note cites its last event');
    assert.deepEqual(by['vault:scratch:ship']!.evidence, ['vault:scratch:ship:active@4']);
    assert.equal(by['vault:scratch:thought']!.state, 'none', 'a value gone is no commitment, which drops an open intent');

    // An event keyed some other way is counted, and read as the import would key it.
    const odd = statusesOf('scratch', [{ note: 'vault:scratch:ship', event: 'not-an-id', at: '2026-10-15T08:00:00Z', payload: { status: 'active' } }]);
    assert.deepEqual(odd.get('ship')!.keys, ['vault:scratch:ship:active']);
  } finally {
    v.cleanup();
  }
});

// ------------------------------------------------------------------ configuration

test('the kernel block’s commitments and days: read from the file, naming no value in code', () => {
  const v = scratch();
  const bare = scratch('kernel:\n  enabled: true\n  bin: kernel\n  commitments: { open: [active] }\n  days: ./journal/\n');
  try {
    const k = settingsFor(v.root).kernel;
    assert.deepEqual(k.commitments, { axis: 'status', open: ['active'], horizon: 'due' });
    assert.equal(k.days, 'daily');
    assert.equal(settingsFor(bare.root).kernel.commitments, null, 'no axis, no commitments');
    assert.equal(settingsFor(bare.root).kernel.days, 'journal', 'a folder, however it is written');

    const cfg = { ...k, verdicts: { stage: { shipped: 'met' as const, binned: 'dropped' as const } }, commitments: { axis: 'stage', open: ['doing', 'shipped'], horizon: null } };
    assert.equal(commitmentState(cfg, { stage: ['doing'] }), 'open');
    assert.equal(commitmentState(cfg, { stage: ['shipped'] }), 'met', 'a verdict outranks open');
    assert.equal(commitmentState(cfg, { stage: ['binned'] }), 'dropped');
    assert.equal(commitmentState(cfg, { stage: ['idea'] }), 'none', 'every other value is no commitment');
    assert.equal(commitmentState(cfg, { status: ['active'] }), 'none', 'another axis says nothing');
    assert.equal(commitmentState({ ...cfg, commitments: null }, { stage: ['doing'] }), 'none');
  } finally {
    v.cleanup();
    bare.cleanup();
  }
});

test('an import is refused when the vault asked for nothing, and a day without a date is skipped', async () => {
  const off = scratch('kernel:\n  enabled: false\n');
  const nothing = scratch('kernel:\n  enabled: true\n  bin: kernel\n');
  const days = scratch('kernel:\n  enabled: true\n  bin: kernel\n  vault: scratch\n  days: daily\n');
  try {
    const a = await planImport(off.root);
    assert.ok(!a.ok && /enabled: true/.test(a.reason));
    const b = await planImport(nothing.root);
    assert.ok(!b.ok && /nothing to import/.test(b.reason));

    writeFileSync(place(days.root, 'daily/notes-on-days.md'), note('notes-on-days', 'About days', ''), 'utf8');
    const c = await planImport(days.root);
    assert.ok(c.ok, 'days only: no status to ask the kernel about, so `bin: kernel` is never run');
    assert.deepEqual(c.plan.batch.commitments, [], 'days only: no commitments without an axis');
    assert.deepEqual(c.plan.batch.events.map((e) => e.key), ['vault:scratch:day:2026-10-14', 'vault:scratch:day:2026-10-15']);
    assert.deepEqual(c.plan.skipped, [{ id: 'notes-on-days', why: 'in daily/ with no date in its name' }]);
  } finally {
    for (const x of [off, nothing, days]) x.cleanup();
  }
});

// ------------------------------------------------------------------ the command

const STATUS_QUERY = 'query --saved projector/vault-status-events --in alias=vault:scratch: --limit 10000 --json';

test('pj kernel import asks the kernel what it holds, sends one batch as the owner, and sends no change twice', () => {
  const v = scratch();
  try {
    const kdb = join(v.root, 'kdb');
    const dry = pj(v.root, ['kernel', 'import', '--dry-run', '--json'], v.env);
    assert.equal(dry.code, 0, dry.err);
    const printed = JSON.parse(dry.out) as ImportBatch;
    assert.equal(printed.commitments.length, 4);
    assert.deepEqual(v.calls(), [`${kdb}|${STATUS_QUERY}`], 'a dry run asks the kernel what it holds, and sends nothing');

    const human = pj(v.root, ['kernel', 'import', '--dry-run'], v.env);
    assert.match(human.out, /would send vault:scratch — 4 commitment\(s\) \(1 open, 1 met, 2 none\), 4 status change\(s\), 2 day\(s\), 6 entities/);

    const sent = pj(v.root, ['kernel', 'import'], v.env);
    assert.equal(sent.code, 0, sent.err);
    assert.match(sent.out, /^sent vault:scratch — 4 commitment/);
    assert.match(sent.out, /kernel: source system:projector · entities-new 0/);
    assert.deepEqual(v.calls().slice(-2), [`${kdb}|${STATUS_QUERY}`, `${kdb}|ingest --source system:projector --owner --json`]);
    const [first] = v.batches();
    assert.deepEqual(first, printed, 'the batch sent is the batch the dry run printed');
    assert.equal(existsSync(paths(v.root).intakeDb), false, 'nothing of what was sent is kept here: the kernel is the record');

    // The kernel now holds what it took: a second import reports the same
    // commitments, and no status event again.
    v.holds();
    const again = pj(v.root, ['kernel', 'import'], v.env);
    assert.equal(again.code, 0, again.err);
    const second = v.batches()[1]!;
    assert.deepEqual(second.events.filter((e) => e.kind === 'vault/status'), []);
    assert.deepEqual(second.commitments, first!.commitments, 'the same states, citing the same events');
    assert.deepEqual(second.events.map((e) => e.key), ['vault:scratch:day:2026-10-14', 'vault:scratch:day:2026-10-15'], 'days are keyed by date, so the kernel writes each once');

    // A status changes: one event, and only for that note.
    writeFileSync(place(v.root, 'ship.md'), note('ship', 'Ship the widget', 'status: [done]'), 'utf8');
    pj(v.root, ['kernel', 'import'], v.env);
    const third = v.batches()[2]!;
    assert.deepEqual(third.events.filter((e) => e.kind === 'vault/status').map((e) => e.key), ['vault:scratch:ship:done']);
    assert.equal(third.commitments.find((c) => c.key === 'vault:scratch:ship')!.state, 'met');

    // And back to a status it held before: the kernel's record makes it @2.
    v.holds();
    writeFileSync(place(v.root, 'ship.md'), note('ship', 'Ship the widget', 'status: [active]'), 'utf8');
    pj(v.root, ['kernel', 'import'], v.env);
    const fourth = v.batches()[3]!;
    const back = fourth.events.filter((e) => e.kind === 'vault/status');
    assert.deepEqual(back.map((e) => e.key), ['vault:scratch:ship:active@2']);
    assert.equal(back[0]!.payload.previous, 'done');
    assert.deepEqual(fourth.commitments.find((c) => c.key === 'vault:scratch:ship')!.evidence, ['vault:scratch:ship:active@2']);
  } finally {
    v.cleanup();
  }
});

test('a kernel that refuses the batch, or the query, is a clear message, a non-zero exit, and nothing kept', () => {
  const v = scratch();
  try {
    const r = pj(v.root, ['kernel', 'import'], { ...v.env, FAKE_KERNEL_FAIL: '1' });
    assert.equal(r.code, 1);
    assert.match(r.err, /pj kernel import: kernel query projector\/vault-status-events exited 2: error: store is locked/);
    assert.deepEqual(v.batches(), [], 'a kernel that cannot say what it holds is sent nothing');

    // The query answers and the batch is refused: the kernel took nothing, so it holds nothing, and the next import sends it whole.
    const fails = join(v.root, 'fails-on-ingest');
    writeFileSync(fails, `#!/bin/sh\n[ "$1" = ingest ] && { echo "error: batch refused {}" >&2; exit 1; }\nexec ${FAKE} "$@"\n`, 'utf8');
    chmodSync(fails, 0o755);
    writeFileSync(settingsPath(v.root), CONFIG(fails), 'utf8');
    const refused = pj(v.root, ['kernel', 'import'], v.env);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /pj kernel import: kernel ingest exited 1: error: batch refused/);
    writeFileSync(settingsPath(v.root), CONFIG(), 'utf8');
    const later = pj(v.root, ['kernel', 'import'], v.env);
    assert.equal(later.code, 0, later.err);
    assert.equal(v.batches()[0]!.events.filter((e) => e.kind === 'vault/status').length, 4, 'sent whole');

    // A kernel that has not registered projector's queries says so, with what to run.
    const unregistered = pj(v.root, ['kernel', 'import'], { ...v.env, FAKE_KERNEL_QUERY_FAIL: 'vault-status-events' });
    assert.equal(unregistered.code, 1);
    assert.match(unregistered.err, /no saved query projector\/vault-status-events: .* — run `pj kernel register`/);
    assert.equal(v.batches().length, 1);

    const nobin = scratch(CONFIG(join(tmpdir(), 'no-such-kernel', 'bin', 'kernel')));
    try {
      const n = pj(nobin.root, ['kernel', 'import'], nobin.env);
      assert.equal(n.code, 1);
      assert.match(n.err, /pj kernel import: .*ENOENT/);
    } finally {
      nobin.cleanup();
    }
    assert.equal(pj(v.root, ['kernel', 'import', 'extra'], v.env).code, 1);
  } finally {
    v.cleanup();
  }
});

test('an intake.db from before opens without the tables the kernel now answers for, and keeps its declines', () => {
  const v = scratch();
  try {
    const file = paths(v.root).intakeDb;
    mkdirSync(dirname(file), { recursive: true });
    const old = new DatabaseSync(file);
    // The shape intake.db had while intake fetched: cursors, the state each
    // tracked item was seen in, the import's old record, and a decline with
    // none of the columns added since.
    old.exec(`CREATE TABLE watermark (channel TEXT PRIMARY KEY, cursor TEXT, ran_at TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, captured INTEGER NOT NULL DEFAULT 0);
      INSERT INTO watermark VALUES ('jira', '2026-10-14T10:00:00Z', '2026-10-14T10:00:00Z', 3, 1);
      CREATE TABLE seen (key TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL);
      INSERT INTO seen VALUES ('jira:K-1', 'Done', '2026-10-15T10:00:00Z');
      CREATE TABLE kernel_status (vault TEXT NOT NULL, note TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (vault, note, seq));
      INSERT INTO kernel_status VALUES ('scratch', 'ship', 0, 'active', 'vault:scratch:ship:active', '2026-10-15T10:00:00Z');
      CREATE TABLE suppressed (fingerprint TEXT PRIMARY KEY, channel TEXT, title TEXT, reason TEXT NOT NULL, at TEXT NOT NULL);
      INSERT INTO suppressed VALUES ('git:r@sha', 'git', 'a typo', 'trivial', '2026-10-15T10:00:00Z');
      CREATE TABLE rescued (fingerprint TEXT PRIMARY KEY, channel TEXT, title TEXT, reason TEXT NOT NULL, at TEXT NOT NULL);`);
    old.close();

    const db = openIntakeDb(v.root);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const gone of ['kernel_status', 'watermark', 'seen']) assert.ok(!tables.includes(gone), gone);
    assert.deepEqual(tables.sort(), ['rescued', 'suppressed']);
    // The decline survives, defaulted to a person's and gaining the event column empty.
    assert.deepEqual(
      { ...(db.prepare('SELECT reason, decided_by, was_judged, event FROM suppressed WHERE fingerprint = ?').get('git:r@sha') as object) },
      { reason: 'trivial', decided_by: 'person', was_judged: 0, event: null },
    );
    const rescued = (db.prepare('PRAGMA table_info(rescued)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(rescued.includes('event') && rescued.includes('offered'));
  } finally {
    closeIntakeDb(v.root);
    v.cleanup();
  }
});

// ------------------------------------------------------------------ registering

test('pj kernel register hands the kernel this checkout’s manifest', async () => {
  const v = scratch();
  try {
    const r = pj(v.root, ['kernel', 'register'], v.env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `registered system:projector from ${MANIFEST}`);
    assert.deepEqual(v.calls(), [`${join(v.root, 'kdb')}|register ${MANIFEST}`]);
    assert.equal(MANIFEST, join(appRoot, 'kernel', 'manifest.json'));

    const refused = pj(v.root, ['kernel', 'register'], { ...v.env, FAKE_KERNEL_FAIL: '1' });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /pj kernel register: kernel register exited 2/);
    const cfg: Settings['kernel'] = { ...settingsFor(v.root).kernel, bin: null };
    assert.deepEqual(await register(cfg), { ok: false, reason: 'kernel.bin is not set' });
  } finally {
    v.cleanup();
  }
});

test('the manifest declares what projector writes and reads, and every batch it sends fits it', async () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(m.system, 'projector');
  assert.deepEqual(m.writes, { events: ['vault/', 'intake/', 'plan/', 'review/'], entities: ['vault:'], proposals: true, commitments: true, judgments: false, conversations: ['intake/slack', 'intake/gmail', 'intake/claude'] });
  assert.deepEqual(m.sync, [{ name: 'vault', run: 'pj kernel import', when: 'after edits, or hourly' }]);
  const dir = join(appRoot, 'kernel');
  assert.deepEqual(m.specs, ['specs/note-conventions.edn', 'specs/daily-plan.edn', 'specs/weekly-review.edn', 'specs/judge-intake.edn']);
  const scheduled: Record<string, RegExp> = {
    'specs/daily-plan.edn': /:trigger \{:daily "07:00"\}/,
    'specs/weekly-review.edn': /:trigger \{:weekly :sunday :at "18:00"\}/,
  };
  for (const spec of m.specs) {
    const text = readFileSync(join(dir, spec), 'utf8');
    assert.match(text, new RegExp(`:name "${basename(spec, '.edn')}"`));
    assert.match(text, scheduled[spec] ?? /:trigger \{:manual true[ }]/, `${spec}: ${scheduled[spec] ? 'the kernel’s tick fires it' : 'tick never fires it'}`);
  }
  // The day and the week are planned here, where the owner plans: each loop's procedure is a projector
  // skill, read whole into the brief, and reads every open intent in the ledger, not only the vault's.
  for (const [spec, name] of [['specs/daily-plan.edn', 'plan-day'], ['specs/weekly-review.edn', 'review-week']] as const) {
    const text = readFileSync(join(dir, spec), 'utf8');
    const skill = text.match(/:skill "([^"]+)"/)?.[1];
    assert.ok(skill && existsSync(join(dir, 'specs', skill, 'SKILL.md')), `${spec} names its skill`);
    assert.equal(basename(skill), name);
    assert.match(text, /:executor :agent/);
    assert.match(readFileSync(join(dir, 'specs', skill, 'SKILL.md'), 'utf8'), /every open intent in the ledger, not only the vault's/);
    assert.ok(m.skills.includes(`../.claude/skills/${name}`), name);
  }
  // Intake's judgment is a spec too: each tick that judges is an attempt of it, started by projector.
  const judgeIntake = readFileSync(join(dir, 'specs/judge-intake.edn'), 'utf8');
  assert.match(judgeIntake, /:executor :agent/);
  assert.match(judgeIntake, /:budget \{:minutes \d+\}/);
  assert.match(judgeIntake, /classify\.ts/);
  // Work on a note is the kernel's worktree spec, not one of projector's: projector answers the kernel's
  // question about the note through its context command, the vault resolved from the alias.
  assert.equal(existsSync(join(dir, 'specs/work-a-note.edn')), false, 'work-a-note is retired to the kernel');
  assert.deepEqual(m.context, { run: '~/.local/bin/pj context --alias {alias} --json-kernel' });
  assert.ok(!m.skills.includes('../.claude/skills/pj-work'), 'pj-work is a redirect, not a procedure');
  // How the develop spec changes projector's own code.
  assert.deepEqual(m.develop, { repo: '..', 'default-branch': 'main', branch: 'kernel/<attempt>', test: 'bun test', typecheck: 'bun run typecheck', guide: 'CLAUDE.md' });
  assert.ok(existsSync(join(dir, m.develop.repo, m.develop.guide)));
  for (const skill of m.skills) assert.ok(existsSync(join(dir, skill, 'SKILL.md')), skill);
  // What projector reads of the kernel: its saved queries, each an EDN file whose :in names exactly its inputs.
  assert.deepEqual(
    m.queries.map((q: { name: string; query: string; inputs: { name: string; type: string }[] }) => [q.name, q.query, q.inputs.map((i) => `${i.name}:${i.type}`)]),
    [
      ['vault-intents', 'queries/vault-intents.edn', ['prefix:string']],
      ['vault-status-events', 'queries/vault-status-events.edn', ['alias:string']],
      ['intake-proposals', 'queries/intake-proposals.edn', []],
      ['intake-newest', 'queries/intake-newest.edn', []],
      ['connector-events-since', 'queries/connector-events-since.edn', ['since:instant', 'kinds:string']],
      ['connector-event', 'queries/connector-event.edn', ['event:uuid']],
    ],
  );
  for (const q of m.queries as { name: string; query: string; inputs: { name: string }[]; description: string }[]) {
    const text = readFileSync(join(dir, q.query), 'utf8');
    const ins = /:in ([^\n]*)/.exec(text)?.[1]?.match(/\?[a-z][a-z0-9-]*/g) ?? [];
    assert.deepEqual(ins, q.inputs.map((i) => `?${i.name}`), q.name);
    assert.ok(q.description, q.name);
    assert.ok(existsSync(join(appRoot, 'test', 'kernel-queries', `${q.name}.json`)), `test/fake-kernel answers ${q.name}`);
  }
  assert.match(readFileSync(join(dir, 'queries/vault-status-events.edn'), 'utf8'), /\(alias \?s "system:projector"\)/, 'this system’s events only');
  for (const r of ['pj CLI', 'skill pj-about']) assert.ok(m.reach.includes(r), r);
  assert.ok(!m.reach.includes('skill pj-work'));
  assert.ok(m.reach.some((r: string) => /bin\/kernel worktree <the note's open intent>/.test(r)), 'reach says where work on a note starts');
  // What a session capturing for the owner runs: pj add for work, the note's file for a note about it.
  assert.deepEqual(m.accepts.map((x: { what: string }) => x.what.split(':')[0]), ['A task or a project', 'A note about work already in the vault']);
  assert.match(m.accepts[0].how, /^~\/\.local\/bin\/pj --vault \S+ add <title> --facet status=planning/);
  assert.match(m.accepts[1].how, /pj --vault \S+ context <note id>/);

  const v = scratch();
  try {
    const planned = await planImport(v.root);
    assert.ok(planned.ok);
    const intake = kernelBatch(
      'scratch',
      'jira',
      [
        {
          candidate: { channel: 'jira', fingerprint: 'jira:K-1', title: 'K-1', links: ['jira:K-1'], evidence: { linkedTo: ['ship'] } },
          verdict: { fingerprint: 'jira:K-1', decision: 'keep', reason: 'r', title: 'Answer K-1' },
          decision: 'keep',
          reason: 'r',
        },
      ],
      new Map([['ship', { id: 'ship', title: 'Ship the widget' }]]),
    );
    for (const b of [planned.plan.batch, intake]) {
      for (const e of b.events) assert.ok(m.writes.events.some((p: string) => e.kind.startsWith(p)), e.kind);
      for (const e of b.entities) assert.ok(m.writes.entities.some((p: string) => e.alias.startsWith(p)), e.alias);
    }
  } finally {
    v.cleanup();
  }
});

forgetSettings();
