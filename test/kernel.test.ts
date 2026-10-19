import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { closeIntakeDb } from '../src/intake/db.ts';
import { KERNEL_OFF } from '../src/intake/run.ts';
import { eventsOf, intakeKey, type ConnectorEvent } from '../src/intake/connectors.ts';
import { eventId, parseAnswer } from '../src/kernel/query.ts';
import { eventKey, kernelBatch, sendToKernel, spawnRunner, vaultName, type Examined, type KernelBatch, type Runner } from '../src/intake/kernel.ts';
import { channelLine, pollOnce, stopPolling, tickLine } from '../src/server/poll.ts';
import { settingsFor, settingsPath } from '../src/settings.ts';
import type { Ask } from '../src/intake/classify.ts';
import type { Candidate } from '../src/intake/types.ts';
import { againstFake, connectorAnswer, connectorEvents, FAKE_KERNEL, FIXTURE_BASE, place, WORK_REPO } from './fixture.ts';

/**
 * The kernel: where intake reads what the connectors gathered, and where it
 * records what it judged. Two things are worth pinning. The mapping — one
 * `intake:` event per connector event looked at, one proposal per card and
 * nothing more, about the vault notes it names — because the kernel's
 * idempotence keys on exactly those values. And the pass against
 * `test/fake-kernel`: it reads, judges, writes, and records, and the record is
 * the next pass's cursor.
 */

function vault(config = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'pj-kernel-'));
  mkdirSync(paths(root).config, { recursive: true });
  writeFileSync(place(root, 'alpha.md'), '---\nid: alpha\ntitle: Alpha\n---\n\nbody\n', 'utf8');
  writeFileSync(place(root, 'beta.md'), '---\nid: beta\ntitle: Beta\n---\n\nbody\n', 'utf8');
  if (config) writeFileSync(settingsPath(root), config, 'utf8');
  return root;
}

const cand = (fingerprint: string, title: string, over: Partial<Candidate> = {}): Candidate => ({
  channel: 'git',
  fingerprint,
  title,
  links: [`gh:branch:o/r@${fingerprint}`],
  when: '2026-10-15T09:00:00.000Z',
  detail: `detail of ${title}`,
  ...over,
});

const notes = new Map([
  ['alpha', { id: 'alpha', title: 'Alpha' }],
  ['beta', { id: 'beta', title: 'Beta' }],
]);

// ------------------------------------------------------------------ the mapping

test('every examined candidate is an event; only a card is a proposal', () => {
  const examined: Examined[] = [
    {
      candidate: cand('git:r@new', 'wip new thing'),
      verdict: { fingerprint: 'git:r@new', decision: 'keep', kind: 'ask', reason: 'ask: a review', title: 'Review the new thing' },
      decision: 'keep',
      reason: 'ask: a review',
    },
    {
      candidate: cand('git:r@more', 'more on alpha', { evidence: { matches: [{ id: 'alpha', title: 'Alpha', why: 'branch' }] } }),
      verdict: { fingerprint: 'git:r@more', decision: 'extend', kind: 'ask', reason: 'ask: more', title: 'Finish alpha', target: 'alpha' },
      decision: 'extend',
      reason: 'ask: more',
    },
    {
      candidate: cand('git:r@typo', 'typo', { evidence: { matches: [{ id: 'beta', title: 'Beta', why: 'text' }, { id: 'gone', title: 'Gone', why: 'text' }] } }),
      decision: 'drop',
      reason: 'trivial',
    },
    { candidate: cand('git:r@silent', 'silent'), decision: 'unjudged', reason: 'no verdict from the judge after two asks' },
    {
      candidate: cand('git:r@progress', 'own progress', { evidence: { linkedTo: ['beta'] } }),
      verdict: { fingerprint: 'git:r@progress', decision: 'link', kind: 'progress', reason: 'progress: on beta', target: 'beta' },
      decision: 'link',
      reason: 'progress: on beta',
    },
    {
      candidate: cand('git:r@had', 'already a note', { evidence: { capturedAs: ['beta'] } }),
      verdict: { fingerprint: 'git:r@had', decision: 'keep', reason: 'kept' },
      decision: 'keep',
      reason: 'kept',
    },
  ];
  const b = kernelBatch('demo', 'git', examined, notes);

  assert.deepEqual(b.events.map((e) => e.key), ['intake:git:r@new', 'intake:git:r@more', 'intake:git:r@typo', 'intake:git:r@silent', 'intake:git:r@progress', 'intake:git:r@had']);
  assert.ok(b.events.every((e) => e.kind === 'intake/git' && e.at === '2026-10-15T09:00:00.000Z'));
  assert.deepEqual(b.events.map((e) => e.payload.verdict), ['keep', 'extend', 'drop', 'unjudged', 'link', 'keep']);
  assert.deepEqual(b.events[1]!.about, ['vault:demo:alpha'], 'about the note it matched and extends, once');
  assert.deepEqual(b.events[2]!.about, ['vault:demo:beta'], 'a note the vault lacks is not an alias');
  assert.deepEqual(b.events[3]!.about, []);
  assert.deepEqual(b.events[4]!.about, ['vault:demo:beta'], 'what tracks it');
  assert.deepEqual(b.events[1]!.payload, {
    title: 'more on alpha',
    fingerprint: 'git:r@more',
    detail: 'detail of more on alpha',
    links: ['gh:branch:o/r@git:r@more'],
    evidence: { matches: [{ id: 'alpha', title: 'Alpha', why: 'branch' }] },
    verdict: 'extend',
    kind: 'ask',
    target: 'alpha',
    proposed: 'Finish alpha',
    reason: 'ask: more',
  });
  assert.equal(b.events[2]!.payload.reason, 'trivial', 'a decline carries its reason');

  assert.deepEqual(b.proposals, [
    { statement: 'Review the new thing', about: [], evidence: ['intake:git:r@new'] },
    { statement: 'Finish alpha', about: ['vault:demo:alpha'], evidence: ['intake:git:r@more'] },
  ], 'keep and extend, by the proposed title; not a decline, a link, or what a note already answers for');

  assert.deepEqual(b.entities, [
    { alias: 'vault:demo:alpha', kind: 'note', name: 'Alpha' },
    { alias: 'vault:demo:beta', kind: 'note', name: 'Beta' },
  ], 'each note once, named by its title');
  assert.deepEqual(b.links, []);
});

test('a candidate read from the kernel is keyed by its connector event, and carries it as evidence', () => {
  const event = (key: string | null, at: string): ConnectorEvent => ({
    id: key ? eventId(key) : '0e6f1c53-6a3b-3f6e-9c1d-1f2e3d4c5b6a',
    kind: key ? 'jira/issue' : 'jira/transition',
    key,
    at,
    about: ['jira:K-1'],
    payload: { key: 'K-1', status: 'Done', assignee: 'Bob' },
  });
  const seen = (e: ConnectorEvent): Examined => ({
    candidate: cand('jira:K-1', 'K-1', { channel: 'jira', when: '2026-01-01T00:00:00.000Z', event: e }),
    verdict: { fingerprint: 'jira:K-1', decision: 'keep', reason: 'r', title: 'Answer K-1' },
    decision: 'keep',
    reason: 'r',
  });
  const moved = event('jira:K-1@Done · Bob', '2026-10-15T09:30:00.000Z');
  const b = kernelBatch('demo', 'jira', [seen(moved)], notes);
  assert.equal(b.events[0]!.key, 'intake:jira:K-1@Done · Bob', 'intake: and the connector’s key, never the key itself');
  assert.equal(b.events[0]!.at, '2026-10-15T09:30:00.000Z', 'when the connector event happened: the cursor');
  assert.deepEqual((b.events[0]!.payload.evidence as { event: ConnectorEvent }).event, moved, 'the connector event, whole');
  assert.deepEqual(b.proposals[0]!.evidence, ['intake:jira:K-1@Done · Bob'], 'the proposal cites the intake event');
  const unkeyed = event(null, '2026-10-15T09:31:00.000Z');
  assert.equal(eventKey({ fingerprint: 'jira:K-1', event: unkeyed }), `intake:jira/transition:${unkeyed.id}`, 'no key to recover: kind and kernel id');
  assert.equal(eventKey({ fingerprint: 'git:r@abc' }), 'intake:git:r@abc', 'no connector event, the fingerprint');
});

test('a candidate with no date is an event the kernel dates itself', () => {
  const b = kernelBatch('demo', 'jira', [{ candidate: cand('jira:K-1', 'K-1', { when: undefined }), decision: 'drop', reason: 'no' }], notes);
  assert.equal('at' in b.events[0]!, false);
  assert.equal(b.events[0]!.kind, 'intake/jira');
});

test('the vault is named by the file, else by its folder', () => {
  const plain = vault();
  const named = vault('kernel:\n  vault: work\n');
  const was = process.env.PROJECTOR_VAULTS;
  process.env.PROJECTOR_VAULTS = join(plain, 'no-registry.json');
  try {
    assert.equal(vaultName(named), 'work');
    assert.equal(vaultName(plain), plain.split('/').pop());
  } finally {
    if (was === undefined) delete process.env.PROJECTOR_VAULTS;
    else process.env.PROJECTOR_VAULTS = was;
    rmSync(plain, { recursive: true, force: true });
    rmSync(named, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ settings

test('the kernel is off unless the file turns it on', () => {
  const none = vault();
  const on = vault('kernel:\n  enabled: true\n  bin: ~/k/bin/kernel\n  db: scratch/db\n  timeout: 1\n');
  const bare = vault('kernel:\n  enabled: true\n  bin: kernel\n');
  try {
    assert.deepEqual(settingsFor(none).kernel, { enabled: false, bin: null, db: null, vault: null, timeoutSeconds: 60, status: null, days: null });
    const k = settingsFor(on).kernel;
    assert.equal(k.enabled, true);
    assert.match(k.bin!, /\/k\/bin\/kernel$/);
    assert.ok(!k.bin!.startsWith('~'), 'a ~ is expanded');
    assert.equal(k.db, join(on, 'scratch/db'), 'a relative db is the vault’s');
    assert.equal(k.timeoutSeconds, 5, 'floored');
    assert.equal(settingsFor(bare).kernel.bin, 'kernel', 'a bare name stays a command on PATH');
  } finally {
    for (const r of [none, on, bare]) rmSync(r, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ sending

const batch: KernelBatch = { entities: [], events: [], links: [], proposals: [] };
const cfg = {
  enabled: true,
  bin: '/k/bin/kernel',
  db: '/scratch/db',
  vault: null,
  timeoutSeconds: 5,
  status: null,
  days: null,
};

test('a batch goes to `<bin> ingest` on stdin, with KERNEL_DB', async () => {
  let seen: { bin: string; args: string[]; input: string; db?: string } | null = null;
  const run: Runner = async (bin, args, input, env) => {
    seen = { bin, args, input, db: env.KERNEL_DB };
    return { code: 0, stdout: '{"events-new":3,"proposals-new":1,"source":"system:projector"}\n', stderr: '' };
  };
  assert.deepEqual(await sendToKernel(cfg, batch, run), { ok: true, events: 3, proposals: 1 });
  assert.deepEqual(seen, {
    bin: '/k/bin/kernel',
    args: ['ingest', '--source', 'system:projector', '--json'],
    input: JSON.stringify(batch),
    db: '/scratch/db',
  });
});

test('every way of not reaching the kernel is a reason, never a throw', async () => {
  assert.deepEqual(await sendToKernel({ ...cfg, bin: null }, batch), { ok: false, reason: 'kernel.bin is not set' });

  const missing = await sendToKernel({ ...cfg, bin: join(tmpdir(), 'no-such-kernel', 'bin', 'kernel') }, batch);
  assert.equal(missing.ok, false);
  assert.match((missing as { reason: string }).reason, /ENOENT/);

  const refused = await sendToKernel(cfg, batch, async () => ({ code: 1, stdout: '', stderr: 'boot\nerror: store is locked {}\n' }));
  assert.deepEqual(refused, { ok: false, reason: 'kernel ingest exited 1: error: store is locked {}' });

  const garbled = await sendToKernel(cfg, batch, async () => ({ code: 0, stdout: 'not json', stderr: '' }));
  assert.equal(garbled.ok, false);

  const thrown = await sendToKernel(cfg, batch, async () => {
    throw new Error('spawn failed');
  });
  assert.deepEqual(thrown, { ok: false, reason: 'spawn failed' });
});

test('the real spawn path: a kernel that exits non-zero is reported with what it said', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pj-kernel-bin-'));
  const bin = join(dir, 'kernel');
  // Echoes stdin to a file so the test can read what was sent, then refuses.
  writeFileSync(bin, `#!/bin/sh\ncat > "${join(dir, 'got.json')}"\necho "db=$KERNEL_DB" >&2\nexit 3\n`, 'utf8');
  chmodSync(bin, 0o755);
  try {
    const r = await sendToKernel({ ...cfg, bin }, { ...batch, proposals: [{ statement: 's', about: [], evidence: ['e'] }] });
    assert.deepEqual(r, { ok: false, reason: 'kernel ingest exited 3: db=/scratch/db' });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'got.json'), 'utf8')).proposals, [{ statement: 's', about: [], evidence: ['e'] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the pass, against the fake kernel

const FAKE = FAKE_KERNEL;
const ID = 'a77e3f00-0000-4000-8000-000000000001';
/** An hour after the shipped fixture's events: inside every channel's window. */
const NOW = FIXTURE_BASE.getTime() + 3_600_000;
const EVENTS = connectorEvents(FIXTURE_BASE);

/**
 * The judge, by channel: the owner's session is a drop, the commits are their
 * own progress (linked onto the project whose repo they are in), the Jira move
 * and the Slack ask are cards, the invoice is a drop. Counts what it was asked.
 */
function judgeOf() {
  const asked: string[] = [];
  const ask: Ask = async (_system, user) =>
    JSON.stringify(
      (JSON.parse(user) as { fp: string }[]).map((c) => {
        asked.push(c.fp);
        const ch = c.fp.split(':')[0];
        if (ch === 'git') return { fp: c.fp, decision: 'progress', reason: 'the owner’s commits' };
        if (ch === 'jira') return { fp: c.fp, decision: 'ask', reason: 'a secret to rotate', title: 'Rotate the webhook signing secret' };
        if (ch === 'slack') return { fp: c.fp, decision: 'promise', reason: 'said will do', title: 'Review the webhook PR for Vivek' };
        return { fp: c.fp, decision: 'drop', reason: ch === 'gmail' ? 'a receipt' : 'nothing open' };
      }),
    );
  return { ask, asked };
}

function passVault(kernel = `kernel:\n  enabled: true\n  bin: ${FAKE}\n`): string {
  const root = vault(kernel);
  writeFileSync(place(root, 'widget', 'README.md'), `---\nid: widget\ntitle: Widget\nproject:\n  repos:\n    - path: ${WORK_REPO}\n---\n\nbody\n`, 'utf8');
  return root;
}

function cleanup(root: string) {
  stopPolling(root);
  closeIntakeDb(root);
  rmSync(root, { recursive: true, force: true });
}

const inbox = (root: string) => {
  try {
    return readdirSync(join(root, 'inbox')).sort();
  } catch {
    return [];
  }
};

test('a pass judges the connector events in the kernel, writes the cards, and records the attempt', async () => {
  const root = passVault();
  try {
    await againstFake(async (read) => {
      const { ask, asked } = judgeOf();
      const res = await pollOnce(root, ask, { now: NOW });
      const { calls, batches } = read();

      // It read the kernel and fetched nothing: the cursor, then the events.
      assert.equal(calls[0], 'query --saved projector/intake-newest --json');
      assert.match(calls[1]!, /^query --saved projector\/connector-events-since --in since=\S+ --in kinds= :claude\/session :git\/commit :jira\/issue :jira\/transition :slack\/message :gmail\/message  --limit 10000 --json$/);
      assert.equal(calls[2], 'attempt start judge-intake --executor agent:projector-intake --json', 'started before the first judgment');
      assert.deepEqual(calls.slice(3, 8).map((c) => c.split(' ').slice(0, 3).join(' ')), Array(5).fill('ingest --source system:projector'));
      const end = calls[8]!.match(/^attempt end (\S+) (\S+) --result (.*) --json$/);
      assert.ok(end, calls[8]);
      assert.equal(end![1], ID);
      assert.equal(end![2], 'done');
      assert.deepEqual(JSON.parse(end![3]!), { seen: 5, created: 2, extending: 0, updates: 0, linked: 1, declined: 2, unanswered: 0, skipped: 5, recorded: 10 });
      assert.equal(calls.length, 9);

      // One candidate per piece of work: the session in the declared repo, the
      // branch's two commits as one, the issue with its transition, the DM, the mail.
      assert.deepEqual(asked.map((fp) => fp.split(':')[0]), ['claude', 'git', 'jira', 'slack', 'gmail']);
      assert.ok(asked.includes('git:widget@feature/webhooks'));
      assert.ok(asked.includes('claude:c0ffee00-1111-4222-8333-444455556666'));
      assert.ok(asked.includes('jira:WID-7'));

      // Two cards in inbox/, the commits linked onto the project they were in.
      assert.equal(res.created.length, 2);
      assert.equal(inbox(root).length, 2);
      assert.equal(res.linked, 1);
      assert.match(readFileSync(place(root, 'widget', 'README.md'), 'utf8'), /git:widget@feature\/webhooks/);

      // Every connector event the pass looked at is one intake event in the attempt,
      // at the instant the connector event happened, carrying it as evidence.
      const events = batches.flatMap((b) => b.events);
      assert.equal(events.length, EVENTS.length);
      for (const e of events) {
        assert.equal(e.attempt, ID);
        const source = (e.payload.evidence as { event: { key: string | null; at: string; kind: string } }).event;
        const fixture = EVENTS.find((f) => eventId(f.key) === (e.payload.evidence as { event: { id: string } }).event.id)!;
        assert.ok(fixture, e.key);
        assert.equal(source.kind, fixture.kind);
        assert.equal(e.at, fixture.at);
        assert.equal(e.kind, `intake/${{ 'claude/session': 'claude', 'git/commit': 'git', 'jira/issue': 'jira', 'jira/transition': 'jira', 'slack/message': 'slack', 'gmail/message': 'gmail' }[fixture.kind]}`);
      }
      const verdicts = Object.fromEntries(events.map((e) => [e.key, e.payload.verdict]));
      assert.equal(verdicts['intake:jira:WID-7@In Progress · Olena'], 'keep');
      assert.equal(verdicts[`intake:${EVENTS[1]!.key}`], 'skip', 'a session outside every declared repo is skipped, and recorded');
      assert.match(String(events.find((e) => e.key === `intake:${EVENTS[1]!.key}`)!.payload.reason), /outside every declared repo/);

      // A card is a proposal citing its intake event.
      assert.deepEqual(
        batches.flatMap((b) => b.proposals).map((p) => p.evidence),
        [['intake:jira:WID-7@In Progress · Olena'], [`intake:${EVENTS[7]!.key}`]],
      );
      assert.deepEqual(res.attempt, { ok: true, id: ID, status: 'done' });
      assert.match(tickLine(res, 1000), /2 notes written, 1 link attached, 2 declined, 10 recorded in the kernel {2}— kernel attempt a77e3f00 done$/);
    });
  } finally {
    cleanup(root);
  }
});

test('a second pass judges nothing new: the cursor is the intake events the first one wrote', async () => {
  const root = passVault();
  try {
    await againstFake(async (read) => {
      const first = judgeOf();
      await pollOnce(root, first.ask, { now: NOW });
      const before = read().calls.length;

      const second = judgeOf();
      const res = await pollOnce(root, second.ask, { now: NOW });
      const { calls } = read();
      assert.deepEqual(second.asked, [], 'the judge is asked nothing');
      assert.equal(res.created.length, 0);
      assert.equal(res.recorded, 0);
      assert.equal(res.attempt, undefined, 'nothing to judge starts no attempt');
      assert.deepEqual(calls.slice(before).map((c) => c.split(' ').slice(0, 3).join(' ')), [
        'query --saved projector/intake-newest',
        'query --saved projector/connector-events-since',
      ], 'it read the cursor and the events, and wrote nothing');
      assert.ok(res.channels.every((c) => c.read === 0), 'every channel a row of zeroes');
      assert.equal(inbox(root).length, 2);
    });
  } finally {
    cleanup(root);
  }
});

test('with the kernel block off, a pass has nothing to read, says so, and never fetches', async () => {
  const root = passVault(`kernel:\n  enabled: false\n  bin: ${FAKE}\n`);
  try {
    await againstFake(async (read) => {
      const { ask, asked } = judgeOf();
      const res = await pollOnce(root, ask, { now: NOW });
      assert.equal(res.idle, KERNEL_OFF);
      assert.match(res.idle!, /nothing to read/);
      assert.deepEqual(read().calls, [], 'the kernel is not asked');
      assert.deepEqual(asked, []);
      assert.equal(res.created.length, 0);
      assert.deepEqual(res.channels, []);
      assert.equal(res.attempt, undefined);
    });
  } finally {
    cleanup(root);
  }
});

test('intake events are keyed intake:<the connector event’s key>, never the connector’s own key', async () => {
  const root = passVault();
  try {
    await againstFake(async (read) => {
      await pollOnce(root, judgeOf().ask, { now: NOW });
      const keys = read().batches.flatMap((b) => b.events.map((e) => e.key));
      assert.ok(keys.every((k) => k.startsWith('intake:')), keys.join('\n'));
      const connector = new Set(EVENTS.map((e) => e.key));
      assert.ok(keys.every((k) => !connector.has(k)), 'no intake event collides with the event it judged');
      // Every key the payload lets it recover is the connector's own, prefixed;
      // a transition's names a changelog entry its payload omits, so it goes by
      // its kind and kernel id instead.
      const transition = EVENTS.find((e) => e.kind === 'jira/transition')!;
      assert.deepEqual(
        keys.sort(),
        EVENTS.map((e) => (e === transition ? `intake:jira/transition:${eventId(e.key)}` : `intake:${e.key}`)).sort(),
      );
    });
  } finally {
    cleanup(root);
  }
});

test('a held pass ends its attempt failed, records nothing for that channel, and the next reads it again', async () => {
  const root = passVault();
  try {
    await againstFake(async (read) => {
      const res = await pollOnce(root, async () => null, { now: NOW });
      assert.ok(res.held, 'the judge could not be reached');
      const { calls, batches } = read();
      assert.equal(batches.length, 0, 'nothing recorded, so the cursor has not moved');
      const end = calls.at(-1)!.match(/^attempt end (\S+) failed --result (.*) --json$/);
      assert.ok(end, calls.at(-1));
      assert.equal(JSON.parse(end![2]!).held, res.held);
      assert.deepEqual(res.attempt, { ok: true, id: ID, status: 'failed' });

      const again = judgeOf();
      const next = await pollOnce(root, again.ask, { now: NOW });
      assert.equal(next.held, undefined);
      assert.equal(again.asked.length, 5, 'the same events, judged this time');
    });
  } finally {
    cleanup(root);
  }
});

test('an attempt the kernel will not start is a line: the events go without one and the pass goes on', async () => {
  const root = passVault();
  try {
    await againstFake(
      async (read) => {
        const res = await pollOnce(root, judgeOf().ask, { now: NOW });
        assert.equal(res.created.length, 2);
        const { calls, batches } = read();
        assert.ok(!calls.some((c) => c.startsWith('attempt end')), 'no end for an attempt that never started');
        assert.ok(batches.flatMap((b) => b.events).every((e) => e.attempt === undefined));
        assert.equal(res.attempt?.ok, false);
        assert.match(tickLine(res, 1000), /kernel attempt not recorded: kernel attempt start exited 1: error: no spec named judge-intake/);
      },
      { FAKE_KERNEL_ATTEMPT_FAIL: '1' },
    );
  } finally {
    cleanup(root);
  }
});

test('a kernel that cannot be read is a pass that read nothing, never a hold or a fetch', async () => {
  const root = passVault();
  try {
    await againstFake(
      async () => {
        const { ask, asked } = judgeOf();
        const res = await pollOnce(root, ask, { now: NOW });
        assert.match(res.idle!, /kernel query projector\/intake-newest exited 2: error: store is locked/);
        assert.equal(res.held, undefined);
        assert.deepEqual(asked, []);
      },
      { FAKE_KERNEL_FAIL: '1' },
    );
  } finally {
    cleanup(root);
  }
});

test('a batch the kernel refuses costs a second read, never a second card', async () => {
  const root = passVault();
  const real = (bin: string, args: string[], input: string, env: Record<string, string | undefined>, ms: number) =>
    spawnRunner(bin, args, input, env, ms);
  const refusing: Runner = async (bin, args, input, env, ms) =>
    args[0] === 'ingest' ? { code: 1, stdout: '', stderr: 'error: store is locked {}' } : real(bin, args, input, env, ms);
  try {
    await againstFake(async () => {
      const res = await pollOnce(root, judgeOf().ask, { now: NOW, kernel: refusing });
      assert.equal(res.created.length, 2, 'the cards are written first');
      const jira = res.channels.find((c) => c.channel === 'jira')!;
      assert.equal(jira.kernel?.ok, false);
      assert.match(channelLine(jira), /kernel not written: kernel ingest exited 1: error: store is locked \{\} — the next pass judges these again/);

      // Nothing was recorded, so the next pass reads all of it again — and finds
      // every piece already answered for: the cards captured, the commits linked,
      // the drops declined. Nothing is judged twice, and nothing written twice.
      const again = judgeOf();
      const next = await pollOnce(root, again.ask, { now: NOW });
      assert.deepEqual(again.asked, []);
      assert.equal(next.created.length, 0);
      assert.equal(next.recorded, EVENTS.length, 'and this time the kernel takes the record');
      assert.equal(inbox(root).length, 2);
    });
  } finally {
    cleanup(root);
  }
});

test('a pass with nothing to judge starts no attempt, so a quiet hour is no verdict', async () => {
  const root = passVault();
  const dir = mkdtempSync(join(tmpdir(), 'pj-quiet-'));
  writeFileSync(join(dir, 'connector-events-since.json'), JSON.stringify(connectorAnswer([])), 'utf8');
  try {
    await againstFake(
      async (read) => {
        const res = await pollOnce(root, judgeOf().ask, { now: NOW });
        assert.deepEqual(read().calls.map((c) => c.split(' ')[0]), ['query', 'query']);
        assert.equal(res.attempt, undefined);
        assert.equal(res.created.length, 0);
      },
      { FAKE_KERNEL_QUERIES: dir },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup(root);
  }
});

test('the shipped fixture is the connectors’ shape, and every key is recovered from its payload but the transition’s', () => {
  const shipped = JSON.parse(readFileSync(new URL('./kernel-queries/connector-events-since.json', import.meta.url), 'utf8'));
  assert.deepEqual(shipped, connectorAnswer(EVENTS), 'test/kernel-queries is generated from test/fixture.ts');
  const events = eventsOf(parseAnswer(JSON.stringify(shipped)));
  assert.equal(events.length, EVENTS.length, 'one event per id, however many aliases');
  for (const e of events) {
    const f = EVENTS.find((x) => eventId(x.key) === e.id)!;
    assert.equal(e.key, f.kind === 'jira/transition' ? null : f.key, f.kind);
    assert.equal(e.at, f.at, 'milliseconds restored');
    assert.deepEqual(e.about, [...f.about].sort());
  }
  assert.equal(intakeKey(events.find((e) => e.kind === 'claude/session')!), `intake:${EVENTS[0]!.key}`);
});
