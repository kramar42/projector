import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { appRoot, paths } from '../src/config.ts';
import { closeIntakeDb, statusesSent } from '../src/intake/db.ts';
import { commitmentState, importBatch, importNotes, planImport, type ImportBatch } from '../src/kernel/import.ts';
import { MANIFEST, register } from '../src/kernel/register.ts';
import { kernelBatch } from '../src/intake/kernel.ts';
import { forgetSettings, settingsFor, settingsPath, type Settings } from '../src/settings.ts';
import { place } from './fixture.ts';

/**
 * `pj kernel import` and `pj kernel register`: projector as a registered kernel
 * system that owns its adapter. Pinned here: the batch a vault maps to — which
 * notes are commitments and in which state, the status events and their keys,
 * the days — through the vault's own configuration and nothing the code knows
 * about any facet value (C4); the record that makes a repeated status `@n`; the
 * command against `test/fake-kernel`, which records every batch it is given;
 * and the manifest the batches must fit.
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
  return {
    root,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    batches: (): ImportBatch[] =>
      existsSync(batches) ? readFileSync(batches, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
    env: { FAKE_KERNEL_LOG: log, FAKE_KERNEL_BATCHES: batches },
    cleanup: () => {
      closeIntakeDb(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const CLI = fileURLToPath(new URL('../src/cli/pj.ts', import.meta.url));

function pj(root: string, args: string[], env: Record<string, string> = {}): { out: string; err: string; code: number } {
  const clean: Record<string, string | undefined> = { ...process.env, PROJECTOR_NO_DELEGATE: '1' };
  for (const key of ['PROJECTOR_DATA', 'PROJECTOR_VAULTS', 'FAKE_KERNEL_FAIL', 'FAKE_KERNEL_LOG', 'FAKE_KERNEL_BATCHES']) delete clean[key];
  const r = spawnSync(process.execPath, [CLI, '--vault', root, ...args], {
    encoding: 'utf8',
    env: { ...clean, PROJECTOR_VAULTS: join(root, 'registry.json'), ...env },
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
}

// ------------------------------------------------------------------ the mapping

test('a vault maps to entities, commitments, status events and days, through its own map', () => {
  const v = scratch();
  try {
    const planned = planImport(v.root);
    assert.ok(planned.ok);
    const { batch, rows, skipped, vault } = planned.plan;
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
    assert.deepEqual(rows.map((r) => r.key), status.map((e) => e.key), 'every status event is recorded once sent');

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

test('what was sent before decides the status events: nothing unchanged, @n for a repeat, none for a value gone', () => {
  const v = scratch();
  try {
    const cfg = settingsFor(v.root).kernel;
    const notes = importNotes(v.root);
    const sent = new Map([
      // active → done → active again: the third change is a repeat.
      ['ship', { keys: ['vault:scratch:ship:active', 'vault:scratch:ship:done'], status: 'done', at: '2026-10-16T00:00:00.000Z' }],
      // unchanged since the last import.
      ['shipped', { keys: ['vault:scratch:shipped:done'], status: 'done', at: '2026-10-15T10:00:00.000Z' }],
      // was active; the thought has no status now.
      ['thought', { keys: ['vault:scratch:thought:active'], status: 'active', at: '2026-10-15T09:00:00.000Z' }],
    ]);
    const { batch, rows } = importBatch('scratch', cfg, notes, sent);
    const status = Object.fromEntries(batch.events.filter((e) => e.kind === 'vault/status').map((e) => [e.payload.id, e]));

    assert.equal(status.ship!.key, 'vault:scratch:ship:active@2');
    assert.equal(status.ship!.at, '2026-10-16T00:00:00.001Z', 'after the change before it, though the file is older');
    assert.equal(status.ship!.payload.previous, 'done');
    assert.equal(status.shipped, undefined, 'an unchanged status is no event');
    assert.equal(status.thought!.key, 'vault:scratch:thought:none');
    assert.equal(status.thought!.payload.status, null);

    const by = Object.fromEntries(batch.commitments.map((c) => [c.key, c]));
    assert.deepEqual(by['vault:scratch:shipped']!.evidence, ['vault:scratch:shipped:done'], 'an unchanged note cites its last event');
    assert.deepEqual(by['vault:scratch:ship']!.evidence, ['vault:scratch:ship:active@2']);
    assert.equal(by['vault:scratch:thought']!.state, 'none', 'a value gone is no commitment, which drops an open intent');
    assert.deepEqual(rows.map((r) => r.note).sort(), ['paused', 'ship', 'someday', 'thought']);
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

test('an import is refused when the vault asked for nothing, and a day without a date is skipped', () => {
  const off = scratch('kernel:\n  enabled: false\n');
  const nothing = scratch('kernel:\n  enabled: true\n  bin: kernel\n');
  const days = scratch('kernel:\n  enabled: true\n  bin: kernel\n  vault: scratch\n  days: daily\n');
  try {
    const a = planImport(off.root);
    assert.ok(!a.ok && /enabled: true/.test(a.reason));
    const b = planImport(nothing.root);
    assert.ok(!b.ok && /nothing to import/.test(b.reason));

    writeFileSync(place(days.root, 'daily/notes-on-days.md'), note('notes-on-days', 'About days', ''), 'utf8');
    const c = planImport(days.root);
    assert.ok(c.ok);
    assert.deepEqual(c.plan.batch.commitments, [], 'days only: no commitments without an axis');
    assert.deepEqual(c.plan.batch.events.map((e) => e.key), ['vault:scratch:day:2026-10-14', 'vault:scratch:day:2026-10-15']);
    assert.deepEqual(c.plan.skipped, [{ id: 'notes-on-days', why: 'in daily/ with no date in its name' }]);
  } finally {
    for (const x of [off, nothing, days]) x.cleanup();
  }
});

// ------------------------------------------------------------------ the command

test('pj kernel import sends one batch as the owner, records it, and sends no change twice', () => {
  const v = scratch();
  try {
    const dry = pj(v.root, ['kernel', 'import', '--dry-run', '--json'], v.env);
    assert.equal(dry.code, 0, dry.err);
    const printed = JSON.parse(dry.out) as ImportBatch;
    assert.equal(printed.commitments.length, 4);
    assert.deepEqual(v.calls(), [], 'a dry run asks the kernel nothing');

    const human = pj(v.root, ['kernel', 'import', '--dry-run'], v.env);
    assert.match(human.out, /would send vault:scratch — 4 commitment\(s\) \(1 open, 1 met, 2 none\), 4 status change\(s\), 2 day\(s\), 6 entities/);

    const sent = pj(v.root, ['kernel', 'import'], v.env);
    assert.equal(sent.code, 0, sent.err);
    assert.match(sent.out, /^sent vault:scratch — 4 commitment/);
    assert.match(sent.out, /kernel: source system:projector · entities-new 0/);
    assert.deepEqual(v.calls(), [`${join(v.root, 'kdb')}|ingest --source system:projector --owner --json`]);
    const [first] = v.batches();
    assert.deepEqual(first, printed, 'the batch sent is the batch the dry run printed');

    // The record now holds what was sent: a second import reports the same
    // commitments, and no status event again.
    closeIntakeDb(v.root);
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
    closeIntakeDb(v.root);
    assert.deepEqual(statusesSent(v.root, 'scratch').get('ship')!.keys, ['vault:scratch:ship:active', 'vault:scratch:ship:done']);
  } finally {
    v.cleanup();
  }
});

test('a kernel that refuses the batch is a clear message, a non-zero exit, and nothing recorded', () => {
  const v = scratch();
  try {
    const r = pj(v.root, ['kernel', 'import'], { ...v.env, FAKE_KERNEL_FAIL: '1' });
    assert.equal(r.code, 1);
    assert.match(r.err, /pj kernel import: kernel ingest exited 2: error: store is locked/);
    assert.equal(statusesSent(v.root, 'scratch').size, 0, 'a refused batch is sent whole next time');

    const later = pj(v.root, ['kernel', 'import'], v.env);
    assert.equal(later.code, 0, later.err);
    closeIntakeDb(v.root);
    assert.equal(statusesSent(v.root, 'scratch').size, 4, 'and once it is taken, recorded');

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

test('the manifest declares what projector writes, and every batch it sends fits it', () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(m.system, 'projector');
  assert.deepEqual(m.writes, { events: ['vault/', 'intake/'], entities: ['vault:'], proposals: true, commitments: true, judgments: false, conversations: ['intake/slack', 'intake/gmail', 'intake/claude'] });
  assert.deepEqual(m.sync, [{ name: 'vault', run: 'pj kernel import', when: 'after edits, or hourly' }]);
  const dir = join(appRoot, 'kernel');
  for (const spec of m.specs) {
    const text = readFileSync(join(dir, spec), 'utf8');
    assert.match(text, /:name "note-conventions"/);
    assert.match(text, /:trigger \{:manual true\}/);
  }
  for (const skill of m.skills) assert.ok(existsSync(join(dir, skill, 'SKILL.md')), skill);
  for (const r of ['pj CLI', 'skill pj-about', 'skill pj-work']) assert.ok(m.reach.includes(r), r);

  const v = scratch();
  try {
    const planned = planImport(v.root);
    assert.ok(planned.ok);
    const intake = kernelBatch(
      'scratch',
      'jira',
      [
        {
          candidate: { channel: 'jira', fingerprint: 'jira:K-1', title: 'K-1', links: ['jira:K-1'], evidence: { linkedTo: ['ship'] }, state: { key: 'jira:K-1', value: 'Done · Bob' } },
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
