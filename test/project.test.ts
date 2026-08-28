import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Note } from '../src/schema/types.ts';
import { parseNote } from '../src/schema/note.ts';
import { projectsOf, resolveProject } from '../src/index/project.ts';
import { adjacency, chains, refsOf, wouldCycle } from '../src/index/refs.ts';
import { blockedBy, blockedSet, unblocks } from '../src/index/blocking.ts';
import { loadFacets } from '../src/schema/facets.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { readAll } from '../src/index/indexer.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** A facets.yaml in a temp dir, so a test can declare the vocabulary it needs. */
function facetsFile(body: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'projector-facets-')), 'facets.yaml');
  writeFileSync(f, body, 'utf8');
  return f;
}


/**
 * The reference graph: project resolution and inheritance, cycles, and what blocks what.
 *
 * Split out of a 1,306-line `model.test.ts` that had become the catch-all: anything
 * not obviously about the query compiler, a view spec or intake landed there, and
 * knowing what was covered meant reading all of it.
 */

// ---------------------------------------------------------------- projects

function rec(
  id: string,
  parents: string[],
  project?: Note['project'],
  body = '',
  belongsTo: string[] = [],
): Note {
  return {
    id,
    title: id,
    facets: {
      ...(parents.length ? { parent: parents } : {}),
      ...(belongsTo.length ? { project: belongsTo } : {}),
    },
    links: [],
    project,
    body,
    file: `/${id}.md`,
  };
}

function graph(...recs: Note[]): Map<string, Note> {
  return new Map(recs.map((r) => [r.id, r]));
}

/**
 * A vault of folder projects on disk.
 *
 * Instructions are `AGENTS.md` beside the project note, so a test that asserts
 * what a member inherits has to be a test with real folders in it — `graph`
 * above builds records whose `file` points nowhere, which is exactly right for
 * the ordering tests and useless for this one.
 *
 * Each entry becomes `<root>/<id>/README.md`, plus `<root>/<id>/AGENTS.md` when
 * it states any rules. `readAll` then reads it back the way the indexer does, so
 * these tests exercise the folder id rule at the same time.
 */
function vault(
  ...projects: { id: string; belongsTo?: string[]; project?: Note['project']; rules?: string }[]
): { root: string; notes: Map<string, Note> } {
  const root = mkdtempSync(join(tmpdir(), 'projector-vault-'));
  for (const spec of projects) {
    mkdirSync(join(root, spec.id));
    const fm: string[] = ['---'];
    if (spec.belongsTo?.length) fm.push(`facets:\n  project: [${spec.belongsTo.join(', ')}]`);
    fm.push(`project:\n${stringify(spec.project ?? {}).trimEnd().split('\n').map((l) => `  ${l}`).join('\n')}`);
    fm.push('---', '');
    writeFileSync(join(root, spec.id, 'README.md'), fm.join('\n'), 'utf8');
    if (spec.rules) writeFileSync(join(root, spec.id, 'AGENTS.md'), spec.rules, 'utf8');
  }
  return { root, notes: readAll(root).notes };
}

/** The rules each project on the chain contributed, without the provenance marker. */
const rulesOf = (p: { instructions: string[] }) =>
  p.instructions.map((i) => i.split('\n').slice(1).join('\n').trim());


/** Parse a note from its text, failing the test rather than returning a result. */
function recordOf(text: string): Note {
  const res = parseNote('/x.md', text);
  assert.ok(res.ok);
  return res.rec;
}

test('repos union across the project chain, nearest wins for scalars', () => {
  const g = graph(
    rec('root', [], { jira: 'AAA', repos: [{ path: '/a' }] }),
    rec('mid', [], { repos: [{ path: '/b' }] }, '', ['root']),
    rec('leaf', [], undefined, '', ['mid']),
  );
  const p = resolveProject('leaf', g, '/data');
  assert.ok(p);
  assert.deepEqual(p.repos.map((r) => r.path), ['/a', '/b']);
  assert.equal(p.jira, 'AAA');
  assert.equal(p.key, 'mid');
  assert.deepEqual(p.chain, ['root', 'mid']);
});

test('a note in two projects inherits from both, unioned', () => {
  const { root, notes } = vault(
    { id: 'project-d', project: { repos: [{ path: '/project-d' }] }, rules: 'project-d rule' },
    { id: 'mapping', project: { repos: [{ path: '/mapping' }] }, rules: 'mapping rule' },
    { id: 'deploy', belongsTo: ['project-d', 'mapping'] },
  );
  const p = resolveProject('deploy', notes, root);
  assert.ok(p);
  assert.deepEqual(p.repos.map((r) => r.path), ['/project-d', '/mapping']);
  assert.deepEqual(rulesOf(p), ['project-d rule', 'mapping rule']);
  assert.deepEqual(p.chain, ['project-d', 'mapping', 'deploy']);
});

test('a duplicate repo path is not added twice', () => {
  const g = graph(
    rec('root', [], { repos: [{ path: '/a' }] }),
    rec('leaf', [], { repos: [{ path: '/a' }] }, '', ['root']),
  );
  assert.equal(resolveProject('leaf', g, '/data')!.repos.length, 1);
});

test('instructions come from AGENTS.md, concatenated outermost first', () => {
  const { root, notes } = vault(
    { id: 'outer', rules: 'root rule' },
    { id: 'leaf', belongsTo: ['outer'], rules: 'leaf rule' },
  );
  const p = resolveProject('leaf', notes, root)!;
  assert.deepEqual(rulesOf(p), ['root rule', 'leaf rule']);
  // The provenance marker is what makes a briefing able to say where a rule came
  // from, and it names the note rather than the file.
  assert.match(p.instructions[0]!, /^<!-- from outer -->/);
});

test('a project stating no rules contributes nothing', () => {
  const { root, notes } = vault(
    { id: 'outer', rules: 'only rule' },
    { id: 'leaf', belongsTo: ['outer'] },
  );
  assert.deepEqual(rulesOf(resolveProject('leaf', notes, root)!), ['only rule']);
});

/**
 * A vault's own AGENTS.md is about the vault, not about whichever project note
 * happens to sit beside it.
 *
 * Read, it would attach the vault's rules to every root-level project and to no
 * other note — inheritance along the `project` facet, sourced from something that
 * is not on the chain. So a project that wants instructions is a folder.
 */
test('the vault root AGENTS.md is not any project\'s instructions', () => {
  const root = mkdtempSync(join(tmpdir(), 'projector-vault-'));
  writeFileSync(join(root, 'AGENTS.md'), 'how this vault is kept', 'utf8');
  writeFileSync(join(root, 'flat.md'), '---\nid: flat\nproject: {}\n---\n', 'utf8');
  const { notes } = readAll(root);
  assert.deepEqual(resolveProject('flat', notes, root)!.instructions, []);
  // And it is not a note either, so it cannot arrive by the other door.
  assert.equal(notes.has('agents'), false);
});

test('a note naming no project resolves to null', () => {
  const g = graph(rec('a', []), rec('b', ['a']));
  assert.equal(resolveProject('b', g, '/data'), null);
});

test('a parent edge grants no project — membership is only the facet', () => {
  const g = graph(
    rec('project-a', [], { repos: [{ path: '/staging' }] }),
    rec('child', ['project-a']),
  );
  assert.equal(resolveProject('child', g, '/data'), null);
  assert.deepEqual(projectsOf(g.get('child')!), []);
});

test('a project note is its own innermost context', () => {
  const g = graph(
    rec('project-b', [], { jira: 'SUPPORT' }),
    rec('keycloak', [], { branch: 'kc/{card}' }, '', ['project-b']),
  );
  const p = resolveProject('keycloak', g, '/data')!;
  assert.equal(p.key, 'keycloak');
  assert.equal(p.jira, 'SUPPORT');
  assert.equal(p.branch, 'kc/{card}');
  assert.deepEqual(p.chain, ['project-b', 'keycloak']);
});

test('a cycle between projects terminates', () => {
  const g = graph(
    rec('a', [], {}, '', ['b']),
    rec('b', [], {}, '', ['a']),
  );
  const p = resolveProject('a', g, '/data');
  assert.ok(p);
  assert.ok(p.chain.length <= 2);
});

test('multiple parents give multiple chains', () => {
  const g = graph(rec('a', []), rec('b', []), rec('c', ['a', 'b']));
  const out = chains('c', adjacency('parent', g));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.at(-1)).sort(), ['a', 'b']);
});

test('a parent cycle terminates instead of hanging', () => {
  const g = graph(rec('a', ['b']), rec('b', ['a']));
  const out = chains('a', adjacency('parent', g));
  assert.ok(out.length >= 1);
  assert.ok(out[0]!.length <= 3);
});


// ---------------------------------------------------------------- reference cycles

test('one cycle check serves an edge and a reference facet alike', () => {
  const out: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] };
  const outOf = (id: string) => out[id] ?? [];
  // c already reaches nothing, so a can point at it.
  assert.equal(wouldCycle('a', 'c', outOf), false);
  // b reaches c, so c pointing back at a would close the loop through both.
  assert.equal(wouldCycle('c', 'a', outOf), true);
  // A note pointing at itself is the degenerate case, caught the same way.
  assert.equal(wouldCycle('a', 'a', outOf), true);
});

test('a reference chain is ordered, which is what config inheritance needs', () => {
  const g = graph(
    rec('project-a', [], {}),
    rec('project-d', [], {}, '', ['project-a']),
    rec('mapping', [], {}, '', ['project-d']),
  );
  // `chains` answers *by which routes*, where `walk` answers *what is reachable*
  // — and only the first can put the outermost project first.
  assert.deepEqual(chains('mapping', adjacency('project', g)), [
    ['mapping', 'project-d', 'project-a'],
  ]);
  const p = resolveProject('mapping', g, '/data')!;
  assert.deepEqual(p.chain, ['project-a', 'project-d', 'mapping']);
});

test('refsOf drops a self-reference rather than making a loop of one', () => {
  const g = graph(rec('a', [], undefined, '', ['a']));
  assert.deepEqual(refsOf('project', g), []);
});


test('a self-reference and a dangling one are dropped by every blocking answer', () => {
  // `closed` is where "finished" is declared, so the vocabulary has to be here.
  const facets = loadFacets(
    facetsFile('status: { values: [planning, done], closed: [done] }\nblocked_by: { type: ref, blocking: true }\n'),
  );
  // Stored on the note that is stuck: `target` names both of its blockers.
  const notes = new Map(
    [
      recordOf('---\nid: loop\ntitle: Loops\nfacets: { blocked_by: [loop], status: [planning] }\n---\n'),
      recordOf('---\nid: ghost\ntitle: Ghost\nfacets: { blocked_by: [nowhere], status: [planning] }\n---\n'),
      recordOf('---\nid: real\ntitle: Real\nfacets: { status: [planning] }\n---\n'),
      recordOf('---\nid: target\ntitle: Target\nfacets: { blocked_by: [real, fin], status: [planning] }\n---\n'),
      recordOf('---\nid: fin\ntitle: Finished\nfacets: { status: [done] }\n---\n'),
    ].map((r) => [r.id, r]),
  );

  assert.deepEqual(unblocks('loop', notes, facets), [], 'a self-loop unblocks nothing, and terminates');
  assert.deepEqual(blockedBy('loop', notes, facets), [], 'and is blocked by nothing');
  assert.deepEqual(unblocks('ghost', notes, facets), [], 'a value naming no note is not a target');
  assert.deepEqual(unblocks('real', notes, facets), ['target']);

  // A finished blocker stops blocking; an unfinished one does not.
  assert.deepEqual(
    blockedBy('target', notes, facets).map((b) => [b.id, b.done]).sort(),
    [['fin', true], ['real', false]],
  );
  // The axis names the facet that is failing, so a vault with several can say
  // which. `loop` names only itself, and a self-reference is dropped.
  assert.deepEqual(blockedSet(notes, facets).get('target'), ['blocked_by']);
  assert.equal(blockedSet(notes, facets).get('loop'), undefined, 'a self-reference is not one');

  // And a vault that declares no `closed` value has no finished notes: the
  // rule is the vocabulary's, not a literal in the engine.
  const noRule = loadFacets(facetsFile('status: { values: [planning, done] }\nblocked_by: { type: ref, blocking: true }\n'));
  assert.deepEqual(
    blockedBy('target', notes, noRule).map((b) => b.done),
    [false, false],
  );
});

/**
 * One grouping answer for three shapes.
 *
 * Each shape used to spell the ungrouped fallback its own way and filter lanes its
 * own way, and none of them read `axis` — the server's declared column order — so
 * all three leaned on `groups` happening to arrive in it. The empty-group policy
 * differs on purpose, which is why it is an argument: a board keeps an empty
 * declared column because it is somewhere to drag to, and a canvas drops it
 * because a canvas drag moves a position without changing a facet.
 */

test('two projects merge into one outermost-first order, not one chain after another', () => {
  // The shape that broke it: a note that is itself a project and names two
  // others. Walking chain by chain emitted `garden → money → agent`, putting the
  // note's own advice between its two parents' — so the second parent's general
  // rules read after the specific ones they exist to precede.
  const { root, notes } = vault(
    { id: 'garden', rules: 'general: the garden' },
    { id: 'agent', rules: 'general: the agent' },
    { id: 'money', belongsTo: ['garden', 'agent'], rules: 'specific: money' },
  );
  const p = resolveProject('money', notes, root)!;
  assert.deepEqual(p.chain, ['garden', 'agent', 'money']);
  assert.deepEqual(rulesOf(p), [
    'general: the garden',
    'general: the agent',
    'specific: money',
  ]);
  // The nearest value is the most specific one, which is now the note itself
  // rather than whichever parent the traversal reached last.
  assert.equal(p.key, 'money');
});

test('a project reachable at two depths reads at its most general position', () => {
  // `base` is both a direct parent of `leaf` and a grandparent through `mid`.
  // Ranking by the *longest* distance from a root is what keeps it ahead of
  // `mid` on both paths; the shortest would let it read after its own child.
  const g = graph(
    rec('base', [], {}),
    rec('mid', [], {}, '', ['base']),
    rec('leaf', [], {}, '', ['mid', 'base']),
  );
  assert.deepEqual(resolveProject('leaf', g, '/data')!.chain, ['base', 'mid', 'leaf']);
});

test('two parents equally general keep the order the note declared', () => {
  const g = graph(
    rec('alpha', [], {}),
    rec('beta', [], {}),
    rec('note', [], undefined, '', ['beta', 'alpha']),
  );
  // Declaration order, not alphabetical and not traversal order: the file is
  // what decides which of two equals reads first.
  assert.deepEqual(resolveProject('note', g, '/data')!.chain, ['beta', 'alpha']);
});
