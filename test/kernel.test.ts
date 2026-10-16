import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { closeIntakeDb, watermarkFor } from '../src/intake/db.ts';
import { CHANNELS } from '../src/intake/run.ts';
import { eventKey, kernelBatch, sendToKernel, vaultName, type Examined, type KernelBatch, type Runner } from '../src/intake/kernel.ts';
import { channelLine, pollOnce, stopPolling } from '../src/server/poll.ts';
import { settingsFor, settingsPath } from '../src/settings.ts';
import type { Ask } from '../src/intake/classify.ts';
import type { Candidate, Channel } from '../src/intake/types.ts';
import { place } from './fixture.ts';

/**
 * The kernel sink: what a tick examined, sent to the owner's kernel as a source
 * batch. Two things are worth pinning. The mapping — one event per examined
 * candidate, one proposal per card and nothing more, about the vault notes it
 * names — because the kernel's idempotence keys on exactly those values. And
 * that a kernel which cannot be reached costs the tick nothing: the card is
 * written and the cursor moves, and the failure is a line.
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

  assert.deepEqual(b.events.map((e) => e.key), ['git:r@new', 'git:r@more', 'git:r@typo', 'git:r@silent', 'git:r@progress', 'git:r@had']);
  assert.ok(b.events.every((e) => e.kind === 'intake/git' && e.at === '2026-10-15T09:00:00.000Z'));
  assert.deepEqual(b.events.map((e) => e.payload.verdict), ['keep', 'extend', 'drop', 'unjudged', 'link', 'keep']);
  assert.deepEqual(b.events[1]!.about, ['vault:demo:alpha'], 'about the note it matched and extends, once');
  assert.deepEqual(b.events[2]!.about, ['vault:demo:beta'], 'a note the vault lacks is not an alias');
  assert.deepEqual(b.events[3]!.about, []);
  assert.deepEqual(b.events[4]!.about, ['vault:demo:beta'], 'what tracks it');
  assert.deepEqual(b.events[1]!.payload, {
    title: 'more on alpha',
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
    { statement: 'Review the new thing', about: [], evidence: ['git:r@new'] },
    { statement: 'Finish alpha', about: ['vault:demo:alpha'], evidence: ['git:r@more'] },
  ], 'keep and extend, by the proposed title; not a decline, a link, or what a note already answers for');

  assert.deepEqual(b.entities, [
    { alias: 'vault:demo:alpha', kind: 'note', name: 'Alpha' },
    { alias: 'vault:demo:beta', kind: 'note', name: 'Beta' },
  ], 'each note once, named by its title');
  assert.deepEqual(b.links, []);
});

test('a candidate carrying its source’s state is keyed by it, so a later sighting is an event of its own', () => {
  const seen = (value: string, fingerprint = 'jira:K-1'): Examined => ({
    candidate: cand(fingerprint, 'K-1', { channel: 'jira', state: { key: 'jira:K-1', value } }),
    verdict: { fingerprint, decision: 'keep', reason: 'r', title: 'Answer K-1' },
    decision: 'keep',
    reason: 'r',
  });
  const first = kernelBatch('demo', 'jira', [seen('To Do · Bob')], notes);
  const later = kernelBatch('demo', 'jira', [seen('In Progress · Bob')], notes);
  assert.equal(first.events[0]!.key, 'jira:K-1@To Do · Bob');
  assert.equal(later.events[0]!.key, 'jira:K-1@In Progress · Bob', 'the same issue, moved: a second event');
  assert.deepEqual(first.proposals[0]!.evidence, ['jira:K-1@To Do · Bob'], 'the proposal cites the event by its key');
  assert.equal(eventKey({ fingerprint: 'claude:s1', state: { key: 'claude:s1', value: '2026-10-15T09:00:00Z' } }), 'claude:s1@2026-10-15T09:00:00Z');
  assert.equal(eventKey({ fingerprint: 'jira:K-1@To Do · Bob', state: { key: 'jira:K-1', value: 'To Do · Bob' } }), 'jira:K-1@To Do · Bob', 'not twice');
  assert.equal(eventKey({ fingerprint: 'git:r@abc' }), 'git:r@abc', 'no state, the fingerprint alone');
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
    assert.deepEqual(settingsFor(none).kernel, { enabled: false, bin: null, db: null, vault: null, timeoutSeconds: 60, verdicts: {}, onVerdict: {}, commitments: null, days: null });
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
  verdicts: {},
  onVerdict: {},
  commitments: null,
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

// ------------------------------------------------------------------ in the tick

/** Keeps `fake:keep`, drops `fake:drop`. */
const judge: Ask = async (_system, user) =>
  JSON.stringify(
    (JSON.parse(user) as { fp: string }[]).map((c) =>
      c.fp === 'fake:drop'
        ? { fp: c.fp, decision: 'drop', reason: 'chatter' }
        : { fp: c.fp, decision: 'ask', reason: 'a real ask', title: 'Answer the real ask' },
    ),
  );

function withFake(run: (root: string) => Promise<void>, config: string) {
  return async () => {
    const root = vault(`channels: [fake]\n${config}`);
    const fake: Channel = {
      name: 'fake',
      defaultDays: 1,
      collect: (ctx) => ({
        channel: 'fake',
        cursor: ctx.cursor,
        nextCursor: '2026-10-15T12:00:00.000Z',
        fetched: true,
        candidates: [cand('fake:keep', 'raw ask', { channel: 'fake' }), cand('fake:drop', 'thanks!', { channel: 'fake' })],
        skipped: [],
      }),
    };
    CHANNELS.push(fake);
    try {
      await run(root);
    } finally {
      CHANNELS.splice(CHANNELS.indexOf(fake), 1);
      stopPolling(root);
      closeIntakeDb(root);
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  'a tick sends what it examined: both candidates as events, the card as a proposal',
  withFake(async (root) => {
    const sent: KernelBatch[] = [];
    const run: Runner = async (_bin, _args, input) => {
      sent.push(JSON.parse(input) as KernelBatch);
      return { code: 0, stdout: '{"events-new":2,"proposals-new":1}', stderr: '' };
    };
    const res = await pollOnce(root, judge, { kernel: run });
    assert.equal(res.created.length, 1, 'the card is still written');
    assert.equal(sent.length, 1, 'one batch per channel');
    assert.deepEqual(sent[0]!.events.map((e) => [e.key, e.kind, e.payload.verdict]), [
      ['fake:keep', 'intake/fake', 'keep'],
      ['fake:drop', 'intake/fake', 'drop'],
    ]);
    assert.deepEqual(sent[0]!.proposals, [{ statement: 'Answer the real ask', about: [], evidence: ['fake:keep'] }]);
    const c = res.channels.find((x) => x.channel === 'fake')!;
    assert.deepEqual(c.kernel, { ok: true, events: 2, proposals: 1 });
    assert.match(channelLine(c), /kernel 2 events, 1 proposed/);
  }, 'kernel:\n  enabled: true\n  bin: kernel\n'),
);

test(
  'a kernel that cannot be reached neither holds the cursor nor fails the tick',
  withFake(async (root) => {
    const res = await pollOnce(root, judge);
    assert.equal(res.held, undefined, 'not held');
    assert.equal(res.created.length, 1, 'the card is written');
    assert.equal(res.declined, 1, 'and the decline recorded');
    assert.ok(res.advanced.includes('fake'), 'the cursor moves');
    assert.equal(watermarkFor(root, 'fake')?.cursor, '2026-10-15T12:00:00.000Z');
    const c = res.channels.find((x) => x.channel === 'fake')!;
    assert.equal(c.kernel?.ok, false);
    assert.match(channelLine(c), /kernel not reached: .*ENOENT/);
  }, `kernel:\n  enabled: true\n  bin: ${join(tmpdir(), 'no-such-kernel', 'bin', 'kernel')}\n`),
);

test(
  'off by default: nothing is sent and the line is as it was',
  withFake(async (root) => {
    let calls = 0;
    const res = await pollOnce(root, judge, {
      kernel: async () => {
        calls++;
        return { code: 0, stdout: '{}', stderr: '' };
      },
    });
    assert.equal(calls, 0);
    const c = res.channels.find((x) => x.channel === 'fake')!;
    assert.equal(c.kernel, undefined);
    assert.doesNotMatch(channelLine(c), /kernel/);
  }, ''),
);
