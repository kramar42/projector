import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, patchKey, patchYamlFile, serialize, split } from '../src/schema/frontmatter.ts';
import { parseCard, renderCard } from '../src/schema/card.ts';
import { clean, slugify, uniqueId } from '../src/import/slug.ts';
import { parseLink } from '../src/schema/links.ts';
import { ancestorChains, extractInstructions, projectsOf, resolveProject } from '../src/index/project.ts';
import type { Rec } from '../src/schema/types.ts';
import { NONE, modeFor, nextValues } from '../src/web/views/dragSemantics.ts';
import { ago, firstLine } from '../src/enrich/run.ts';
import { isUnavailable, unavailable } from '../src/enrich/types.ts';
import { branchFetcher, prFetcher } from '../src/enrich/github.ts';
import { sessionFetcher } from '../src/enrich/claudeSession.ts';
import { jiraFetcher, statusTone as jiraStatusTone } from '../src/enrich/jira.ts';
import {
  addWorktree,
  appleScriptQuote,
  branchFor,
  resolveBase,
  shellQuote,
  terminalScript,
  workspacePath,
} from '../src/agent/worktree.ts';
import { buildBriefing } from '../src/agent/briefing.ts';

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

function rec(
  id: string,
  parents: string[],
  project?: Rec['project'],
  body = '',
  belongsTo: string[] = [],
): Rec {
  return {
    id,
    kind: 'card',
    title: id,
    facets: belongsTo.length ? { project: belongsTo } : {},
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

test('repos union across the project chain, nearest wins for scalars', () => {
  const g = graph(
    rec('root', [], { key: 'root', jira: 'AAA', repos: [{ path: '/a' }] }),
    rec('mid', [], { key: 'mid', repos: [{ path: '/b' }] }, '', ['root']),
    rec('leaf', [], undefined, '', ['mid']),
  );
  const p = resolveProject('leaf', g, '/data');
  assert.ok(p);
  assert.deepEqual(p.repos.map((r) => r.path), ['/a', '/b']);
  assert.equal(p.jira, 'AAA');
  assert.equal(p.key, 'mid');
  assert.deepEqual(p.chain, ['root', 'mid']);
});

test('a card in two projects inherits from both, unioned', () => {
  const g = graph(
    rec('project-d', [], { key: 'project-d', repos: [{ path: '/project-d' }] }, '## Instructions\n\nnexus rule\n'),
    rec('mapping', [], { key: 'mapping', repos: [{ path: '/mapping' }] }, '## Instructions\n\nmapping rule\n'),
    rec('deploy', [], undefined, '', ['project-d', 'mapping']),
  );
  const p = resolveProject('deploy', g, '/data');
  assert.ok(p);
  assert.deepEqual(p.repos.map((r) => r.path), ['/project-d', '/mapping']);
  assert.equal(p.instructions.length, 2);
  assert.match(p.instructions[0]!, /project-d rule/);
  assert.match(p.instructions[1]!, /mapping rule/);
  assert.deepEqual(p.chain, ['project-d', 'mapping']);
});

test('repos_replace narrows instead of unioning', () => {
  const g = graph(
    rec('root', [], { key: 'root', repos: [{ path: '/a' }] }),
    rec('mid', [], { key: 'mid', repos: [{ path: '/b' }], repos_replace: true }, '', ['root']),
    rec('leaf', [], undefined, '', ['mid']),
  );
  assert.deepEqual(resolveProject('leaf', g, '/data')!.repos.map((r) => r.path), ['/b']);
});

test('a duplicate repo path is not added twice', () => {
  const g = graph(
    rec('root', [], { key: 'root', repos: [{ path: '/a' }] }),
    rec('leaf', [], { key: 'leaf', repos: [{ path: '/a' }] }, '', ['root']),
  );
  assert.equal(resolveProject('leaf', g, '/data')!.repos.length, 1);
});

test('instructions concatenate outermost first', () => {
  const g = graph(
    rec('root', [], { key: 'root' }, '## Instructions\n\nroot rule\n'),
    rec('leaf', [], { key: 'leaf' }, '## Instructions\n\nleaf rule\n', ['root']),
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

test('a record naming no project resolves to null', () => {
  const g = graph(rec('a', []), rec('b', ['a']));
  assert.equal(resolveProject('b', g, '/data'), null);
});

test('a parent edge grants no project — membership is only the facet', () => {
  const g = graph(
    rec('project-a', [], { key: 'project-a', repos: [{ path: '/staging' }] }),
    rec('child', ['project-a']),
  );
  assert.equal(resolveProject('child', g, '/data'), null);
  assert.deepEqual(projectsOf(g.get('child')!), []);
});

test('a project record is its own innermost context', () => {
  const g = graph(
    rec('project-b', [], { key: 'project-b', jira: 'SUPPORT' }),
    rec('keycloak', [], { key: 'keycloak', branch: 'kc/{card}' }, '', ['project-b']),
  );
  const p = resolveProject('keycloak', g, '/data')!;
  assert.equal(p.key, 'keycloak');
  assert.equal(p.jira, 'SUPPORT');
  assert.equal(p.branch, 'kc/{card}');
  assert.deepEqual(p.chain, ['project-b', 'keycloak']);
});

test('a cycle between projects terminates', () => {
  const g = graph(
    rec('a', [], { key: 'a' }, '', ['b']),
    rec('b', [], { key: 'b' }, '', ['a']),
  );
  const p = resolveProject('a', g, '/data');
  assert.ok(p);
  assert.ok(p.chain.length <= 2);
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

// ---------------------------------------------------------------- enrichment

test('relative ages read naturally', () => {
  const now = Date.now();
  assert.equal(ago(now - 30_000), 'just now');
  assert.equal(ago(now - 20 * 60_000), '20m ago');
  assert.equal(ago(now - 5 * 3600_000), '5h ago');
  assert.equal(ago(now - 3 * 86400_000), '3d ago');
  assert.equal(ago(now - 400 * 86400_000), '1y ago');
  assert.equal(ago(undefined), '');
  assert.equal(ago('not a date'), '');
});

test('firstLine skips blank lines and truncates', () => {
  assert.equal(firstLine('\n\n  hello there\nsecond'), 'hello there');
  assert.equal(firstLine('x'.repeat(50), 10), 'x'.repeat(9) + '…');
});

test('a fetcher signals unavailability instead of throwing', () => {
  const u = unavailable('no credentials', true);
  assert.equal(isUnavailable(u), true);
  assert.equal(u.needsSetup, true);
  assert.equal(isUnavailable({ label: 'x' }), false);
});

test('an unparseable gh ref is reported, not fetched', async () => {
  for (const bad of ['no-hash', 'ORG/repo#', '#12', 'ORG/repo']) {
    const r = await prFetcher.fetch(bad);
    assert.equal(isUnavailable(r), true, bad);
    if (isUnavailable(r)) assert.match(r.reason, /expected gh:pr/);
  }
});

test('an unparseable branch ref is reported', async () => {
  for (const bad of ['ORG/repo', 'ORG/repo@', '@main']) {
    const r = await branchFetcher.fetch(bad);
    assert.equal(isUnavailable(r), true, bad);
  }
});

test('a session id that is not one is rejected without touching disk', async () => {
  const r = await sessionFetcher.fetch('nope');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) assert.match(r.reason, /not a session id/);
});

test('a desktop-app local_ id explains why it cannot resolve', async () => {
  const r = await sessionFetcher.fetch('local_3c379ddf-4887-4235-a12e-493ecfb49420');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) assert.match(r.reason, /transcript uuid/);
});

test('jira says what configuration it needs', async () => {
  const saved = process.env.COCKPIT_JIRA_URL;
  delete process.env.COCKPIT_JIRA_URL;
  const r = await jiraFetcher.fetch('PROJ-303');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) {
    assert.equal(r.needsSetup, true);
    assert.match(r.reason, /COCKPIT_JIRA_URL/);
  }
  if (saved) process.env.COCKPIT_JIRA_URL = saved;
});

test('a bad issue key never reaches the network', async () => {
  process.env.COCKPIT_JIRA_URL = 'https://example.invalid';
  process.env.COCKPIT_JIRA_EMAIL = 'a@b.c';
  process.env.COCKPIT_JIRA_TOKEN = 'x';
  const r = await jiraFetcher.fetch('not-a-key');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) assert.match(r.reason, /not an issue key/);
  delete process.env.COCKPIT_JIRA_URL;
  delete process.env.COCKPIT_JIRA_EMAIL;
  delete process.env.COCKPIT_JIRA_TOKEN;
});

test('jira status colour follows statusCategory, not workflow names', () => {
  // Custom workflows make names useless; the category is stable.
  assert.equal(jiraStatusTone('Preparation', 'new'), 'neutral');
  assert.equal(jiraStatusTone('in review', 'indeterminate'), 'warn');
  assert.equal(jiraStatusTone('Done', 'done'), 'good');
  // Jira files abandonment under `done`; that is not a success.
  assert.equal(jiraStatusTone("Won't do", 'done'), 'neutral');
  assert.equal(jiraStatusTone('Cancelled', 'done'), 'neutral');
  assert.equal(jiraStatusTone('Duplicate', 'done'), 'neutral');
  assert.equal(jiraStatusTone('Anything', undefined), 'neutral');
});

// ---------------------------------------------------------------- agent layer

test('branch name prefers the template, then a lone jira key, then the id', () => {
  assert.equal(branchFor('fix-kpow', { template: 'kc/{card}' }), 'kc/fix-kpow');
  assert.equal(branchFor('fix-kpow', { jiraKeys: ['PROJ-303'] }), 'PROJ-303');
  // Two keys is ambiguous, so fall back to something unambiguous.
  assert.equal(branchFor('fix-kpow', { jiraKeys: ['A-1', 'B-2'] }), 'fix-kpow');
  assert.equal(branchFor('fix-kpow', {}), 'fix-kpow');
});

test('a branch with slashes still makes a legal directory name', () => {
  assert.equal(
    workspacePath('/wt', 'keycloak', 'kc/fix-kpow'),
    '/wt/keycloak-wt-kc-fix-kpow',
  );
});

test('a path with a double quote produces a valid AppleScript literal', () => {
  // Unlike shlex, shellQuote uses the '\'' form and so never emits a double
  // quote of its own — but a path may contain one, and that must not end the
  // AppleScript string early.
  const script = terminalScript('/tmp/we"ird', 'go');
  const body = script.split('\n').find((l) => l.includes('do script'))!;
  const literal = body.slice(body.indexOf('"') + 1, body.lastIndexOf('"'));
  assert.ok(!/(^|[^\\])"/.test(literal), `unescaped quote in: ${literal}`);
  // Unescaping the literal must give back a shell command that quotes the path.
  const unescaped = literal.replace(/\\(["\\])/g, '$1');
  assert.ok(unescaped.includes(shellQuote('/tmp/we"ird')), unescaped);
});

test('an apostrophe round-trips through both quoting layers', () => {
  const script = terminalScript("/tmp/don't", 'go');
  const body = script.split('\n').find((l) => l.includes('do script'))!;
  const literal = body.slice(body.indexOf('"') + 1, body.lastIndexOf('"'));
  // AppleScript unescapes \\ to \, leaving exactly what the shell needs.
  const forShell = literal.replace(/\\\\/g, '\\');
  assert.equal(forShell, `cd ${shellQuote("/tmp/don't")} && claude ${shellQuote('go')}`);
});

test('appleScriptQuote escapes backslashes before quotes', () => {
  assert.equal(appleScriptQuote('a\\b"c'), 'a\\\\b\\"c');
});

test('base branch falls back from declared to origin/HEAD to HEAD', () => {
  const git = (out: Record<string, string>) => (args: string[]) => {
    const key = args.join(' ');
    const hit = Object.entries(out).find(([k]) => key.includes(k));
    return hit ? { ok: true, out: hit[1], err: '' } : { ok: false, out: '', err: 'no' };
  };
  assert.equal(resolveBase({ path: '/r', base: 'dev' }, git({})), 'dev');
  assert.equal(resolveBase({ path: '/r' }, git({ 'refs/remotes/origin/HEAD': 'origin/main\n' })), 'origin/main');
  assert.equal(resolveBase({ path: '/r' }, git({ 'rev-parse --abbrev-ref': 'trunk\n' })), 'trunk');
});

test('a missing repo is reported per repo, never thrown', () => {
  const res = addWorktree({ path: '/definitely/not/here' }, '/wt', 'b', () => ({ ok: true, out: '', err: '' }));
  assert.equal(res.created, false);
  assert.match(res.error ?? '', /repo not found/);
  assert.equal(res.name, 'here');
});

test('worktree prune runs even when the folder already exists', () => {
  // Without the unconditional prune, reopening a hand-deleted workspace fails
  // with "missing but already registered worktree".
  const calls: string[] = [];
  const git = (args: string[]) => {
    calls.push(args.join(' '));
    return { ok: true, out: '', err: '' };
  };
  addWorktree({ path: '/Users' }, '/Users', 'b', git); // /Users/Users won't exist
  assert.ok(calls.some((c) => c === 'worktree prune'), calls.join(' | '));
});

test('the briefing names failed repos as out of scope and stops before building', () => {
  const ctx = {
    id: 'c1', kind: 'card' as const, title: 'T', isProject: false, file: 'cards/c1.md',
    facets: {}, body: '', project: null, parents: [], children: [], blockedBy: [],
    blocks: [], relates: [], links: [], siblings: [],
  };
  const out = buildBriefing({
    ctx, workspace: '/wt/x', branch: 'b',
    repos: [
      { name: 'ok', path: '/wt/x/ok', created: true, error: null },
      { name: 'bad', path: '/wt/x/bad', created: false, error: 'boom' },
    ],
  });
  assert.match(out, /`ok\/`/);
  assert.match(out, /out of scope[\s\S]*bad.*boom/);
  assert.match(out, /STOP/);
  assert.match(out, /deliberately left out/);
  assert.match(out, /ck link-session c1/);
});
