import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRIVATE_HEADING, renderShared, withoutPrivate } from '../src/sync/render.ts';
import type { Companions } from '../src/sync/render.ts';
import { parseLink } from '../src/schema/links.ts';
import type { Note } from '../src/schema/types.ts';
import { applySync, planSync, recordFor, renderPlan, type SyncPlan } from '../src/sync/plan.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAll } from '../src/index/indexer.ts';
import { paths } from '../src/config.ts';
import { place } from './fixture.ts';

/**
 * Syncing a view into a folder of markdown.
 *
 * The property under test throughout is that the render is **total and
 * deterministic**: every reference has exactly one outcome, decided by what else
 * is being shared, and nothing enriched or machine-local reaches the output. That
 * is what makes a difference between the folder and a fresh render mean
 * something — which is the whole basis for ever bringing an outside edit back.
 */

const note = (over: Partial<Note> = {}): Note => ({
  id: 'a',
  title: 'A note',
  facets: {},
  links: [],
  body: '',
  file: '/v/a.md',
  ...over,
});

/** Shares `a` and `b` flat, with one asset travelling. */
const companions = (over: Partial<Companions> = {}): Companions => ({
  fileOf: (id) => (id === 'a' ? 'a.md' : id === 'b' ? 'b.md' : null),
  noteAt: (path) =>
    path === '/v/a.md' ? 'a' : path === '/v/b.md' ? 'b' : path === '/v/c.md' ? 'c' : null,
  assetAt: (path) => (path === '/v/assets/a/h.md' ? 'assets/a/h.md' : null),
  docAt: (ref) => (ref.startsWith('/') ? ref : `/v/${ref}`),
  jiraBase: 'https://acme.atlassian.net',
  ...over,
});

// ---------------------------------------------------------------- private sections

test('a private section leaves, taking its subsections and stopping at its peer', () => {
  const body = [
    'Public opening.',
    '',
    '## Private',
    '',
    'Not for anybody else.',
    '',
    '### A subsection of it',
    '',
    'Also not.',
    '',
    '## Public again',
    '',
    'Kept.',
  ].join('\n');
  assert.equal(
    withoutPrivate(body),
    ['Public opening.', '', '## Public again', '', 'Kept.'].join('\n'),
  );
});

test('a private heading inside a fence is a sample, not a marker', () => {
  const body = ['```md', '## Private', 'sample prose', '```', '', 'Kept.'].join('\n');
  assert.equal(withoutPrivate(body), body);
});

test('a deeper private section does not swallow the section it sits in', () => {
  const body = ['## Section', '', '### Private', '', 'held back', '', '### Sibling', '', 'kept'].join('\n');
  assert.equal(withoutPrivate(body), ['## Section', '', '### Sibling', '', 'kept'].join('\n'));
  // The name is the author's marker, so it is the one word this looks for.
  assert.equal(PRIVATE_HEADING, 'Private');
});

// ---------------------------------------------------------------- references

test('a reference to a shared note is repointed, and to an unshared one unwrapped', () => {
  const out = renderShared(
    note({
      body: 'See [B](b.md), and [C](c.md), and [the handout](assets/a/h.md).\n',
    }),
    companions(),
  );
  assert.match(out, /See \[B\]\(b\.md\), and C, and \[the handout\]\(assets\/a\/h\.md\)\./);
});

test('an asset that is not travelling unwraps too, rather than pointing at nothing', () => {
  const out = renderShared(
    note({ body: 'Evidence in [the handout](assets/a/h.md).\n' }),
    companions({ assetAt: () => null }),
  );
  assert.match(out, /Evidence in the handout\./);
});

test('an outward link is left exactly as written', () => {
  const out = renderShared(note({ body: 'Per [the paper](https://example.com/x.md).\n' }), companions());
  assert.match(out, /\[the paper\]\(https:\/\/example\.com\/x\.md\)/);
});

// ---------------------------------------------------------------- links

test('only the links a reader can follow travel, and they carry an href', () => {
  const raws = [
    'jira:PROJ-1',
    'gh:pr:acme/platform#412',
    'https://example.com/a',
    'slack:https://acme.slack.com/archives/C1/p1700000000000100',
    'claude:00000000-0000-4000-8000-000000000000',
    'workspace:/Users/someone/Code/wt/a',
  ];
  const out = renderShared(note({ links: raws.map(parseLink) }), companions());
  assert.match(out, /\[PROJ-1\]\(https:\/\/acme\.atlassian\.net\/browse\/PROJ-1\)/);
  assert.match(out, /\[platform#412 \(PR\)\]\(https:\/\/github\.com\/acme\/platform\/pull\/412\)/);
  assert.match(out, /example\.com/);
  assert.match(out, /acme\.slack\.com/);
  // A session on one machine and a directory on it — neither is followable, and
  // the second carries somebody's home directory.
  assert.doesNotMatch(out, /claude/);
  assert.doesNotMatch(out, /4000-8000/);
  assert.doesNotMatch(out, /workspace|Users/);
});

test('a doc link travels only when what it points at is travelling too', () => {
  const links = ['doc:b.md', 'doc:c.md', 'doc:assets/a/h.md', 'doc:../infra/docs/x.md'].map(parseLink);
  const out = renderShared(note({ links }), companions());
  assert.match(out, /- \[b\.md\]\(b\.md\)/);
  assert.match(out, /- \[h\.md\]\(assets\/a\/h\.md\)/);
  // `c` is a note nobody is sharing; the infra doc is in another repository.
  assert.doesNotMatch(out, /c\.md/);
  assert.doesNotMatch(out, /infra/);
});

// ---------------------------------------------------------------- the whole file

test('the note is shared with its title as a heading and nothing else from the frontmatter', () => {
  const out = renderShared(
    note({
      title: 'Card spec — what the unit is',
      facets: { status: ['planning'], priority: ['month'], private: ['true'] },
      body: 'The unit of the model is a card.\n\n## Private\n\nSay nothing about the reorg.\n',
      links: [parseLink('jira:PROJ-1')],
    }),
    companions(),
  );
  assert.equal(
    out,
    [
      '# Card spec — what the unit is',
      '',
      'The unit of the model is a card.',
      '',
      '## Links',
      '',
      '- [PROJ-1](https://acme.atlassian.net/browse/PROJ-1)',
      '',
    ].join('\n'),
  );
});

test('rendering the same note twice gives the same bytes, which is what a diff rests on', () => {
  const n = note({ body: 'See [B](b.md).\n', links: [parseLink('jira:PROJ-1')] });
  assert.equal(renderShared(n, companions()), renderShared(n, companions()));
});

test('a note with an empty body still travels as a named document', () => {
  assert.equal(renderShared(note({ title: 'Just a title' }), companions()), '# Just a title\n');
});

// ---------------------------------------------------------------- images

test('an image travels with the body that shows it, and is never unwrapped', () => {
  const out = renderShared(
    note({ body: 'Before\n\n![a screenshot](assets/a/shot.png)\n\nAfter\n' }),
    companions({ assetAt: (p) => (p === '/v/assets/a/shot.png' ? 'assets/a/shot.png' : null) }),
  );
  assert.match(out, /!\[a screenshot\]\(assets\/a\/shot\.png\)/);
});

test('an image whose file cannot travel is left as written, not deleted', () => {
  // Already broken in the vault, and no worse here — where dropping it would
  // silently take content out of somebody's document.
  const out = renderShared(note({ body: '![missing](docs/absent.png)\n' }), companions());
  assert.match(out, /!\[missing\]\(docs\/absent\.png\)/);
});

test('a link and an image side by side get their separate treatments', () => {
  const out = renderShared(
    note({ body: 'See [C](c.md) ![shot](assets/a/shot.png) end\n' }),
    companions({ assetAt: (p) => (p === '/v/assets/a/shot.png' ? 'assets/a/shot.png' : null) }),
  );
  assert.equal(out, '# A note\n\nSee C ![shot](assets/a/shot.png) end\n');
});

// ---------------------------------------------------------------- the plan

/**
 * The half that touches disk. A sync is the one write whose target is outside the
 * vault, so what matters here is that it says what it will do before it does it,
 * that a second run is quiet, and that unsharing actually unshares.
 */

function vault(files: Record<string, string>): { root: string; target: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pj-publish-'));
  mkdirSync(paths(root).config, { recursive: true });
  writeFileSync(
    paths(root).facets,
    'status: { label: Status, values: [planning, done], open: false, single: true }\n' +
      'private: { label: Private, values: [true], open: false, single: true }\n',
    'utf8',
  );
  for (const [path, content] of Object.entries(files)) {
    const full = place(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return {
    root,
    target: join(root, 'out'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const noteFile = (id: string, title: string, body: string, front = '') =>
  `---\nid: ${id}\ntitle: ${title}\n${front}---\n${body}`;

/** The notes a view would hand the planner, in a fixed order. */
function ordered(root: string, ids: string[]): { list: Note[]; all: Map<string, Note> } {
  const all = readAll(paths(root).notes).notes;
  return { list: ids.map((id) => all.get(id)!), all };
}

test('the index leads with the view focus, and names the folder after the view', () => {
  const v = vault({
    'a.md': noteFile('a', 'Note A', 'Points at [Note B](b.md).\n'),
    'b.md': noteFile('b', 'Note B', 'Plain.\n'),
  });
  try {
    const { list, all } = ordered(v.root, ['a', 'b']);
    const plan = planSync(list, all, {
      root: v.root,
      view: 'shared',
      target: v.target,
      jiraBase: null,
      lead: 'b',
      title: 'Patchwork',
    });
    // `b` is second in the view's order and is still the way in, so it is named
    // rather than merely first — and it is not repeated in the list below.
    assert.equal(
      plan.files.find((f) => f.path === 'README.md')!.content,
      '# Patchwork\n\nStart with [Note B](b.md).\n\n- [Note A](a.md)\n',
    );
  } finally {
    v.cleanup();
  }
});

test('with no focus the index is the view order under a plain heading', () => {
  const v = vault({ 'a.md': noteFile('a', 'Note A', 'Prose.\n') });
  try {
    const { list, all } = ordered(v.root, ['a']);
    const plan = planSync(list, all, { root: v.root, view: 'shared', target: v.target, jiraBase: null });
    assert.equal(
      plan.files.find((f) => f.path === 'README.md')!.content,
      '# Contents\n\n- [Note A](a.md)\n',
    );
  } finally {
    v.cleanup();
  }
});

test('the plan writes an index in the view order and marks every file new', () => {
  const v = vault({
    'a.md': noteFile('a', 'Note A', 'Points at [Note B](b.md).\n'),
    'b.md': noteFile('b', 'Note B', 'Plain.\n'),
  });
  try {
    const { list, all } = ordered(v.root, ['a', 'b']);
    const plan = planSync(list, all, { root: v.root, view: 'shared', target: v.target, jiraBase: null });
    assert.deepEqual(
      plan.files.map((f) => [f.path, f.state]),
      [['README.md', 'new'], ['a.md', 'new'], ['b.md', 'new']],
    );
    const index = plan.files.find((f) => f.path === 'README.md')!.content;
    assert.equal(index, '# Contents\n\n- [Note A](a.md)\n- [Note B](b.md)\n');
    assert.deepEqual(plan.held, []);
    assert.deepEqual(plan.cut, []);
  } finally {
    v.cleanup();
  }
});

test('an excluded note is held back and named, and the links into it are reported cut', () => {
  const v = vault({
    'a.md': noteFile('a', 'Note A', 'Points at [Note B](b.md).\n'),
    'b.md': noteFile('b', 'Note B', 'Secret.\n', 'facets: { private: [true] }\n'),
  });
  try {
    const { list, all } = ordered(v.root, ['a', 'b']);
    const plan = planSync(list, all, {
      root: v.root,
      view: 'shared',
      target: v.target,
      exclude: { private: ['true'] },
      jiraBase: null,
    });
    assert.deepEqual(plan.held, [{ id: 'b', title: 'Note B', because: 'private: true' }]);
    assert.deepEqual(plan.cut, [{ id: 'b', title: 'Note B', from: ['a'] }]);
    assert.deepEqual(plan.files.map((f) => f.path), ['README.md', 'a.md']);
    // Held means held: not the file, and not the prose that pointed at it.
    const shared = plan.files.find((f) => f.path === 'a.md')!.content;
    assert.match(shared, /Points at Note B\./);
    assert.doesNotMatch(shared, /Secret/);
  } finally {
    v.cleanup();
  }
});

test('applying twice writes nothing the second time', () => {
  const v = vault({ 'a.md': noteFile('a', 'Note A', 'Prose.\n') });
  try {
    const plan = (): SyncPlan => {
      const { list, all } = ordered(v.root, ['a']);
      return planSync(list, all, { root: v.root, view: 'shared', target: v.target, jiraBase: null });
    };
    const first = applySync(plan());
    assert.equal(first.written, 2);
    const second = plan();
    // The front page is seeded once and then the folder's own, so the second run
    // plans the note alone.
    assert.deepEqual(second.files.map((f) => f.path), ['a.md']);
    assert.deepEqual(second.files.map((f) => f.state), ['same']);
    assert.equal(applySync(second).written, 0);
  } finally {
    v.cleanup();
  }
});

test('a note that leaves the view is removed from the folder — an unshare unshares', () => {
  const v = vault({
    'a.md': noteFile('a', 'Note A', 'Prose.\n'),
    'b.md': noteFile('b', 'Note B', 'Prose.\n'),
  });
  try {
    const both = ordered(v.root, ['a', 'b']);
    applySync(planSync(both.list, both.all, { root: v.root, view: 'shared', target: v.target, jiraBase: null }));
    assert.ok(existsSync(join(v.target, 'b.md')));

    const one = ordered(v.root, ['a']);
    const next = planSync(one.list, one.all, { root: v.root, view: 'shared', target: v.target, jiraBase: null });
    assert.deepEqual(next.remove, ['b.md']);
    applySync(next);
    assert.equal(existsSync(join(v.target, 'b.md')), false);
    assert.ok(existsSync(join(v.target, 'a.md')));
  } finally {
    v.cleanup();
  }
});

test('a dotfile in the target is never touched, so it can stay a git repository', () => {
  const v = vault({ 'a.md': noteFile('a', 'Note A', 'Prose.\n') });
  try {
    mkdirSync(join(v.target, '.git'), { recursive: true });
    writeFileSync(join(v.target, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const { list, all } = ordered(v.root, ['a']);
    const plan = planSync(list, all, { root: v.root, view: 'shared', target: v.target, jiraBase: null });
    assert.deepEqual(plan.remove, []);
    applySync(plan);
    assert.ok(existsSync(join(v.target, '.git', 'HEAD')));
  } finally {
    v.cleanup();
  }
});

test('the report leads with what would surprise you, and says nothing was written', () => {
  const v = vault({ 'a.md': noteFile('a', 'Note A', 'Prose.\n') });
  try {
    const { list, all } = ordered(v.root, ['a']);
    const out = renderPlan(
      planSync(list, all, { root: v.root, view: 'shared', target: v.target, jiraBase: null }),
      'shared',
    );
    assert.match(out, /new {6}README\.md/);
    assert.match(out, /Nothing written — pass --apply\./);
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- what a sync owns

/**
 * A sync owns only what it wrote.
 *
 * The first version computed removals as "everything here this run did not
 * produce", which reads like pruning and behaves like deleting somebody's work:
 * on a real folder it took a hand-written front page, a 63-line document and a
 * 269-line asset. These pin the four cases the record now separates.
 */

test('a file nobody recorded writing is left alone, not overwritten', () => {
  const v = vault({ 'a.md': noteFile('a', 'Note A', 'Prose.\n') });
  try {
    const plan = () => {
      const { list, all } = ordered(v.root, ['a']);
      return planSync(list, all, { root: v.root, view: 'shared', target: v.target, jiraBase: null });
    };
    // Somebody's folder, kept by hand, with a file at a path the sync also wants.
    mkdirSync(v.target, { recursive: true });
    writeFileSync(join(v.target, 'a.md'), 'written by hand\n', 'utf8');

    const first = plan();
    assert.deepEqual(first.files.map((f) => [f.path, f.state]), [['README.md', 'new'], ['a.md', 'unmanaged']]);
    const done = applySync(first);
    assert.equal(done.skipped, 1);
    assert.equal(readFileSync(join(v.target, 'a.md'), 'utf8'), 'written by hand\n');
  } finally {
    v.cleanup();
  }
});

test('--adopt claims it, which is the only way to overwrite an edit', () => {
  const v = vault({ 'a.md': noteFile('a', 'Note A', 'Prose.\n') });
  try {
    mkdirSync(v.target, { recursive: true });
    writeFileSync(join(v.target, 'a.md'), 'written by hand\n', 'utf8');
    const { list, all } = ordered(v.root, ['a']);
    const plan = planSync(list, all, {
      root: v.root,
      view: 'shared',
      target: v.target,
      jiraBase: null,
      adopt: true,
    });
    assert.deepEqual(plan.files.find((f) => f.path === 'a.md')!.state, 'changed');
    applySync(plan);
    assert.match(readFileSync(join(v.target, 'a.md'), 'utf8'), /# Note A/);
  } finally {
    v.cleanup();
  }
});

test('a file this sync wrote and somebody then edited is a conflict, and survives', () => {
  const v = vault({ 'a.md': noteFile('a', 'Note A', 'Prose.\n') });
  try {
    const plan = () => {
      const { list, all } = ordered(v.root, ['a']);
      return planSync(list, all, { root: v.root, view: 'shared', target: v.target, jiraBase: null });
    };
    applySync(plan());
    // Edited on the far side, the way a shared copy gets edited.
    writeFileSync(join(v.target, 'a.md'), '# Note A\n\nProse, improved by the reader.\n', 'utf8');

    const next = plan();
    assert.equal(next.files.find((f) => f.path === 'a.md')!.state, 'conflict');
    applySync(next);
    assert.match(readFileSync(join(v.target, 'a.md'), 'utf8'), /improved by the reader/);
  } finally {
    v.cleanup();
  }
});

test('a note that leaves the view is removed only while the copy is untouched', () => {
  const v = vault({
    'a.md': noteFile('a', 'Note A', 'Prose.\n'),
    'b.md': noteFile('b', 'Note B', 'Prose.\n'),
  });
  try {
    const both = ordered(v.root, ['a', 'b']);
    applySync(planSync(both.list, both.all, { root: v.root, view: 'shared', target: v.target, jiraBase: null }));
    // Somebody edits the copy of the note that is about to leave the view.
    writeFileSync(join(v.target, 'b.md'), '# Note B\n\nEdited here.\n', 'utf8');

    const one = ordered(v.root, ['a']);
    const next = planSync(one.list, one.all, { root: v.root, view: 'shared', target: v.target, jiraBase: null });
    // An unshare must unshare — but not by throwing away the only copy of an edit.
    assert.deepEqual(next.remove, []);
    assert.deepEqual(next.orphaned, ['b.md']);
    applySync(next);
    assert.ok(existsSync(join(v.target, 'b.md')));
  } finally {
    v.cleanup();
  }
});

test('the record is kept in the vault, and nothing is left in the target', () => {
  const v = vault({ 'a.md': noteFile('a', 'Note A', 'Prose.\n') });
  try {
    const opts = { root: v.root, view: 'shared', target: v.target, jiraBase: null };
    const { list, all } = ordered(v.root, ['a']);
    applySync(planSync(list, all, opts));

    // The target is somebody else's repository: it gets the notes and nothing
    // about the tool that put them there.
    assert.ok(existsSync(recordFor(v.root, 'shared', v.target)));
    assert.ok(recordFor(v.root, 'shared', v.target).startsWith(paths(v.root).syncRecords));
    assert.deepEqual(readdirSync(v.target).sort(), ['README.md', 'a.md']);

    // And two views into one folder, or one view into two, do not share a record.
    assert.notEqual(recordFor(v.root, 'other', v.target), recordFor(v.root, 'shared', v.target));
    assert.notEqual(recordFor(v.root, 'shared', '/elsewhere'), recordFor(v.root, 'shared', v.target));

    const next = planSync(list, all, opts);
    assert.deepEqual(next.files.map((f) => f.state), ['same']);
    assert.deepEqual(next.remove, []);
  } finally {
    v.cleanup();
  }
});

test('a hand-written front page is never regenerated and never pruned', () => {
  const v = vault({ 'a.md': noteFile('a', 'Note A', 'Prose.\n') });
  try {
    const plan = () => {
      const { list, all } = ordered(v.root, ['a']);
      return planSync(list, all, { root: v.root, view: 'shared', target: v.target, jiraBase: null });
    };
    applySync(plan());
    // The generated list is a reasonable first page and a poor permanent one.
    writeFileSync(join(v.target, 'README.md'), '# Patchwork\n\nGrouped, with one line each.\n', 'utf8');

    const next = plan();
    assert.equal(next.files.some((f) => f.path === 'README.md'), false);
    assert.deepEqual(next.remove, []);
    applySync(next);
    assert.match(readFileSync(join(v.target, 'README.md'), 'utf8'), /Grouped, with one line each/);
  } finally {
    v.cleanup();
  }
});
