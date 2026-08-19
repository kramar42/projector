import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, patchKey, patchYamlFile, serialize, split } from '../src/schema/frontmatter.ts';
import { parseCard, renderCard } from '../src/schema/card.ts';
import { clean, slugify, uniqueId } from '../src/import/slug.ts';
import { parseLink } from '../src/schema/links.ts';
import { ancestorChains, derivedProject, extractInstructions, resolveProject } from '../src/index/project.ts';
import type { Rec } from '../src/schema/types.ts';
import { NONE, modeFor, nextValues } from '../src/web/views/dragSemantics.ts';

// ---------------------------------------------------------------- frontmatter

test('split returns the body byte-identical', () => {
  const body = 'Some prose.\n\n- [ ] a task\n\n  indented\ttab\n';
  const s = split(`---\nid: x\n---\n${body}`);
  assert.equal(s.body, body);
});

test('join and split round-trip any body without adding or eating a newline', () => {
  for (const body of ['x\n', '\nx\n', '\n\nx', '', 'no trailing newline']) {
    assert.equal(split(join('id: x\n', body)).body, body, JSON.stringify(body));
  }
});

test('render preserves the body byte-for-byte, including no leading blank line', () => {
  const original = 'Tight body, no blank line after the fence.\n';
  const res = parseCard('/f.md', `---\nid: x\nkind: card\ntitle: T\n---\n${original}`);
  assert.ok(res.ok);
  assert.equal(res.rec.body, original);
  assert.equal(split(renderCard(res.rec)).body, original);
});

test('a file with no frontmatter is left alone', () => {
  const s = split('# just markdown\n');
  assert.equal(s.yaml, null);
  assert.equal(s.body, '# just markdown\n');
});

test('patchKey preserves the body and every untouched key, comments included', () => {
  const text = join('id: x\n# a comment worth keeping\nkind: card\ntitle: T\n', '\nbody text\n');
  const out = patchKey(text, 'facets', { priority: ['now'] });
  assert.match(out, /# a comment worth keeping/);
  assert.equal(split(out).body, '\nbody text\n');
  assert.match(out, /priority: \[now\]/);
});

test('patchKey restores canonical key order for a newly added key', () => {
  const text = join('id: x\nkind: card\ntitle: T\nupdated: 2026-01-01\n', '\n');
  const out = patchKey(text, 'edges', [{ type: 'parent', to: 'p' }]);
  const keys = [...out.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['id', 'kind', 'title', 'edges', 'updated']);
});

test('scalar arrays serialize on one line', () => {
  assert.match(serialize({ facets: { priority: ['now', 'month'] } }), /priority: \[now, month\]/);
});

// ---------------------------------------------------------------- card parsing

const CARD = `---
id: demo-card
kind: card
title: Demo
facets:
  priority: [now]
  status: active
edges:
  - {type: parent, to: project-a}
links: [jira:PROJ-1, "https://example.com/x"]
---

Body.
`;

test('a scalar facet value is lifted to an array', () => {
  const res = parseCard('/f.md', CARD);
  assert.ok(res.ok);
  assert.deepEqual(res.rec.facets.status, ['active']);
  assert.deepEqual(res.rec.facets.priority, ['now']);
});

test('links are parsed into kind and ref', () => {
  const res = parseCard('/f.md', CARD);
  assert.ok(res.ok);
  assert.deepEqual(
    res.rec.links.map((l) => l.kind),
    ['jira', 'url'],
  );
});

test('a bad id is reported, not thrown', () => {
  const res = parseCard('/f.md', '---\nid: Not A Slug\nkind: card\ntitle: T\n---\n');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.errors.join(' '), /slug/);
});

test('render then parse round-trips', () => {
  const res = parseCard('/f.md', CARD);
  assert.ok(res.ok);
  const again = parseCard('/f.md', renderCard({ ...res.rec }));
  assert.ok(again.ok);
  assert.equal(again.rec.title, 'Demo');
  assert.deepEqual(again.rec.edges, [{ type: 'parent', to: 'project-a' }]);
  assert.equal(again.rec.body.trim(), 'Body.');
});

test('link kinds are recognised', () => {
  assert.equal(parseLink('gh:pr:Org/repo#4').kind, 'gh:pr');
  assert.equal(parseLink('claude:local_abc').kind, 'claude');
  assert.equal(parseLink('doc:a/b.md').ref, 'a/b.md');
  assert.equal(parseLink('nonsense').kind, '');
});

// ---------------------------------------------------------------- slugs

test('trello decoration is stripped, brackets stay balanced', () => {
  assert.equal(clean('📂 backlog 📂'), 'backlog');
  assert.equal(clean('• lists •'), 'lists');
  assert.equal(clean('🕘 today 🕔'), 'today');
  assert.equal(clean('Project F (internal platform)'), 'Project F (internal platform)');
});

test('a bare URL slugs to host and first segment', () => {
  assert.equal(slugify('https://github.com/juji-io/datalevin/tree/master'), 'github-juji-io');
  assert.equal(slugify('https://xtdb.com/'), 'xtdb');
});

test('uniqueId suffixes collisions', () => {
  const taken = new Set<string>();
  assert.equal(uniqueId('a', taken), 'a');
  assert.equal(uniqueId('a', taken), 'a-2');
  assert.equal(uniqueId('a', taken), 'a-3');
});

// ---------------------------------------------------------------- projects

function rec(id: string, parents: string[], project?: Rec['project'], body = ''): Rec {
  return {
    id,
    kind: 'card',
    title: id,
    facets: {},
    edges: parents.map((to) => ({ type: 'parent' as const, to })),
    links: [],
    project,
    body,
    file: `/${id}.md`,
  };
}

function graph(...recs: Rec[]): Map<string, Rec> {
  return new Map(recs.map((r) => [r.id, r]));
}

test('repos union down the chain, nearest wins for scalars', () => {
  const g = graph(
    rec('root', [], { key: 'root', jira: 'AAA', repos: [{ path: '/a' }] }),
    rec('mid', ['root'], { key: 'mid', repos: [{ path: '/b' }] }),
    rec('leaf', ['mid']),
  );
  const p = resolveProject('leaf', g, '/data');
  assert.ok(p);
  assert.deepEqual(p.repos.map((r) => r.path), ['/a', '/b']);
  assert.equal(p.jira, 'AAA');
  assert.equal(p.key, 'mid');
  assert.deepEqual(p.chain, ['root', 'mid']);
});

test('repos_replace narrows instead of unioning', () => {
  const g = graph(
    rec('root', [], { key: 'root', repos: [{ path: '/a' }] }),
    rec('mid', ['root'], { key: 'mid', repos: [{ path: '/b' }], repos_replace: true }),
    rec('leaf', ['mid']),
  );
  assert.deepEqual(resolveProject('leaf', g, '/data')!.repos.map((r) => r.path), ['/b']);
});

test('a duplicate repo path is not added twice', () => {
  const g = graph(
    rec('root', [], { key: 'root', repos: [{ path: '/a' }] }),
    rec('leaf', ['root'], { key: 'leaf', repos: [{ path: '/a' }] }),
  );
  assert.equal(resolveProject('leaf', g, '/data')!.repos.length, 1);
});

test('instructions concatenate root first', () => {
  const g = graph(
    rec('root', [], { key: 'root' }, '## Instructions\n\nroot rule\n'),
    rec('leaf', ['root'], { key: 'leaf' }, '## Instructions\n\nleaf rule\n'),
  );
  const p = resolveProject('leaf', g, '/data')!;
  assert.equal(p.instructions.length, 2);
  assert.match(p.instructions[0]!, /root rule/);
  assert.match(p.instructions[1]!, /leaf rule/);
});

test('only the Instructions section is extracted', () => {
  const body = '\nNotes.\n\n## Instructions\n\nthe rule\n\n## Other\n\nnot this\n';
  assert.equal(extractInstructions(body), 'the rule');
});

test('a record with no project ancestor resolves to null', () => {
  const g = graph(rec('a', []), rec('b', ['a']));
  assert.equal(resolveProject('b', g, '/data'), null);
});

test('derivedProject reports nearest and root separately', () => {
  const g = graph(
    rec('top', [], { key: 'top' }),
    rec('mid', ['top'], { key: 'mid' }),
    rec('leaf', ['mid']),
  );
  assert.deepEqual(derivedProject('leaf', g), { nearest: 'mid', root: 'top' });
});

test('a project record belongs to itself', () => {
  const g = graph(rec('top', [], { key: 'top' }), rec('mid', ['top'], { key: 'mid' }));
  assert.equal(derivedProject('mid', g).nearest, 'mid');
});

test('multiple parents give multiple chains', () => {
  const g = graph(rec('a', []), rec('b', []), rec('c', ['a', 'b']));
  const chains = ancestorChains('c', g);
  assert.equal(chains.length, 2);
  assert.deepEqual(chains.map((c) => c.at(-1)).sort(), ['a', 'b']);
});

test('a parent cycle terminates instead of hanging', () => {
  const g = graph(rec('a', ['b']), rec('b', ['a']));
  const chains = ancestorChains('a', g);
  assert.ok(chains.length >= 1);
  assert.ok(chains[0]!.length <= 3);
});

// ---------------------------------------------------------------- drag semantics

test('a plain drop replaces the value it came from', () => {
  assert.deepEqual(nextValues(['now'], 'now', 'month', 'replace'), ['month']);
});

test('⌥ drop adds, so a card sits in two columns deliberately', () => {
  assert.deepEqual(nextValues(['now'], 'now', 'month', 'add'), ['now', 'month']);
});

test('⌥ drop on a column the card is already in changes nothing', () => {
  assert.deepEqual(nextValues(['now', 'month'], 'now', 'month', 'add'), ['now', 'month']);
});

test('⇧ drag removes only the value dragged from', () => {
  assert.deepEqual(nextValues(['now', 'month'], 'now', 'backlog', 'remove'), ['month']);
});

test('a replace never leaves a duplicate behind', () => {
  assert.deepEqual(nextValues(['now', 'month'], 'now', 'month', 'replace'), ['month']);
});

test('dropping into uncategorised clears the grouped facet', () => {
  assert.deepEqual(nextValues(['now'], 'now', NONE, 'replace'), []);
});

test('dragging out of uncategorised just adds the target value', () => {
  assert.deepEqual(nextValues([], NONE, 'now', 'replace'), ['now']);
});

test('⌥ into uncategorised is a no-op rather than an empty-string value', () => {
  assert.deepEqual(nextValues(['now'], 'now', NONE, 'add'), ['now']);
});

test('modifier keys map to modes, shift winning over alt', () => {
  assert.equal(modeFor({}), 'replace');
  assert.equal(modeFor({ altKey: true }), 'add');
  assert.equal(modeFor({ shiftKey: true }), 'remove');
  assert.equal(modeFor({ shiftKey: true, altKey: true }), 'remove');
});

// ---------------------------------------------------------------- view files

test('a plain YAML view file is patched in place, not wrapped as frontmatter', () => {
  const original = `# a comment
kind: canvas
title: Project A
layout: tree-lr
include:
  under: project-a
`;
  const out = patchYamlFile(original, { nodes: { project-a: { x: 1, y: 2 } }, layout: 'manual' });
  // The keys must appear exactly once — the frontmatter patcher would have
  // duplicated the whole document.
  assert.equal(out.match(/^kind:/gm)?.length, 1);
  assert.equal(out.match(/^layout:/gm)?.length, 1);
  assert.match(out, /layout: manual/);
  assert.doesNotMatch(out, /^---$/m);
  assert.match(out, /# a comment/);
  assert.match(out, /under: project-a/);
});
