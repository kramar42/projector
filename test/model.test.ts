import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, patchKey, patchYamlFile, serialize, split } from '../src/schema/frontmatter.ts';
import { loadCard, parseCard, renderCard } from '../src/schema/card.ts';
import { createCard, deleteCard, patchFields } from '../src/server/mutate.ts';
import { isProject } from '../src/index/project.ts';
import { clean, slugify, uniqueId } from '../src/schema/slug.ts';
import { parseLink } from '../src/schema/links.ts';
import { projectsOf, resolveProject } from '../src/index/project.ts';
import { adjacency, chains, refsOf, wouldCycle } from '../src/index/refs.ts';
import { validate, validateViews } from '../src/schema/validate.ts';
import { specFromFile } from '../src/view/spec.ts';
import { bucketOf, loadFacets, orderValues } from '../src/schema/facets.ts';
import { history } from '../src/agent/history.ts';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { SEED_FACETS, SEED_VIEWS } from '../src/server/seed.ts';
import type { Rec } from '../src/schema/types.ts';
import { NONE } from '../src/schema/vocabulary.ts';
import {
  connectOutcome,
  dropOutcome,
  modeFor,
  nextValues,
  type DragMode,
} from '../src/view/dropOutcome.ts';
import { blockedBy, blockedSet, unblocks } from '../src/index/blocking.ts';
import { groupsFor, labelFor } from '../src/web/views/groups.ts';
import { CONTEXT_BAND, assignClusters, clusterBoxes, clusteredLayout } from '../src/web/views/layout.ts';
import type { CardDTO } from '../src/web/types.ts';
import { ago, firstLine } from '../src/sources/run.ts';
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
import { countCards, initVault, looksLikeVault, normalise, resolveDoc, suggestName } from '../src/vault.ts';
import { resolveCliVault } from '../src/config.ts';
import { patchCard } from '../src/server/mutate.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join as pathJoin, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
  const text = join('id: x\ntitle: T\nupdated: 2026-01-01\n', '\n');
  const out = patchKey(text, 'facets', { parent: ['p'] });
  const keys = [...out.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['id', 'title', 'facets', 'updated']);
});

test('a facet the vocabulary does not know is preserved, not dropped', () => {
  const res = parseCard('/f.md', '---\nid: x\ntitle: T\nfacets: { invented: [a] }\n---\n');
  assert.ok(res.ok);
  assert.deepEqual(res.rec.facets.invented, ['a']);
});

test('scalar arrays serialize on one line', () => {
  assert.match(serialize({ facets: { priority: ['now', 'month'] } }), /priority: \[now, month\]/);
});

// ---------------------------------------------------------------- card parsing

const CARD = `---
id: demo-card
title: Demo
facets:
  priority: [now]
  status: active
  parent: [project-a]
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
  // A relation survives the round trip as what it is: a facet value.
  assert.deepEqual(again.rec.facets.parent, ['project-a']);
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

function graph(...recs: Rec[]): Map<string, Rec> {
  return new Map(recs.map((r) => [r.id, r]));
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

test('a card in two projects inherits from both, unioned', () => {
  const g = graph(
    rec('project-d', [], { repos: [{ path: '/project-d' }], instructions: 'project-d rule' }),
    rec('mapping', [], { repos: [{ path: '/mapping' }], instructions: 'mapping rule' }),
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

test('a duplicate repo path is not added twice', () => {
  const g = graph(
    rec('root', [], { repos: [{ path: '/a' }] }),
    rec('leaf', [], { repos: [{ path: '/a' }] }, '', ['root']),
  );
  assert.equal(resolveProject('leaf', g, '/data')!.repos.length, 1);
});

test('instructions concatenate outermost first', () => {
  const g = graph(
    rec('root', [], { instructions: 'root rule' }),
    rec('leaf', [], { instructions: 'leaf rule' }, '', ['root']),
  );
  const p = resolveProject('leaf', g, '/data')!;
  assert.equal(p.instructions.length, 2);
  assert.match(p.instructions[0]!, /root rule/);
  assert.match(p.instructions[1]!, /leaf rule/);
});

test('a record naming no project resolves to null', () => {
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

test('a project record is its own innermost context', () => {
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
  const saved = process.env.PROJECTOR_JIRA_URL;
  delete process.env.PROJECTOR_JIRA_URL;
  const r = await jiraFetcher.fetch('PROJ-303');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) {
    assert.equal(r.needsSetup, true);
    assert.match(r.reason, /PROJECTOR_JIRA_URL/);
  }
  if (saved) process.env.PROJECTOR_JIRA_URL = saved;
});

test('a bad issue key never reaches the network', async () => {
  process.env.PROJECTOR_JIRA_URL = 'https://example.invalid';
  process.env.PROJECTOR_JIRA_EMAIL = 'a@b.c';
  process.env.PROJECTOR_JIRA_TOKEN = 'x';
  const r = await jiraFetcher.fetch('not-a-key');
  assert.equal(isUnavailable(r), true);
  if (isUnavailable(r)) assert.match(r.reason, /not an issue key/);
  delete process.env.PROJECTOR_JIRA_URL;
  delete process.env.PROJECTOR_JIRA_EMAIL;
  delete process.env.PROJECTOR_JIRA_TOKEN;
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
    id: 'c1', title: 'T', isProject: false, file: 'cards/c1.md',
    facets: {}, body: '', project: null, parents: [], children: [], blockedBy: [],
    blocks: [], links: [], siblings: [],
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
  assert.match(out, /pj link c1 --session/);
});

// ---------------------------------------------------------------- vaults

test('a vault path is normalised: ~ expanded, absolute, no trailing slash', () => {
  assert.equal(normalise('/tmp/v/'), '/tmp/v');
  assert.equal(normalise('/tmp/v///'), '/tmp/v');
  assert.equal(normalise('~/v').startsWith('/'), true);
  assert.ok(!normalise('~/v').includes('~'));
});

test('the suggested name is the folder name, and nothing cleverer', () => {
  // There is no list of "too generic" leaf names that borrows the parent instead.
  // A suggestion sits in an editable field, so guessing buys nothing and costs
  // predictability.
  assert.equal(suggestName('/Users/k/notes/vault'), 'vault');
  assert.equal(suggestName('/Users/k/Code/work/projector/work'), 'work');
  assert.equal(suggestName('/Users/k/second-brain'), 'second-brain');
});

test('doc refs resolve against the vault, and absolutely when absolute', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'pj-vault-'));
  mkdirSync(pathJoin(dir, 'cards'), { recursive: true });
  writeFileSync(pathJoin(dir, 'inside.md'), '# in');
  const outside = pathJoin(dir, '..', `pj-outside-${process.pid}.md`);
  writeFileSync(outside, '# out');

  assert.equal(resolveDoc('inside.md', dir).path, pathJoin(dir, 'inside.md'));
  // A doc outside the vault is reached with `../` — relative means relative to
  // the vault, not to the card file.
  assert.equal(resolveDoc(`../${basename(outside)}`, dir).path, resolve(outside));
  assert.equal(resolveDoc(outside, dir).path, resolve(outside));
  // A miss reports what it tried, so the message can say where it looked.
  const miss = resolveDoc('nope.md', dir);
  assert.equal(miss.path, null);
  assert.deepEqual(miss.tried, [pathJoin(dir, 'nope.md')]);

  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { force: true });
});

test('a directory is a vault when it holds what a vault is made of', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'pj-vault-'));
  assert.equal(looksLikeVault(dir), false);
  mkdirSync(pathJoin(dir, 'cards'));
  assert.equal(looksLikeVault(dir), true);
  rmSync(dir, { recursive: true, force: true });
});

test('the CLI picks a vault explicitly, or unambiguously, or asks', () => {
  const one = [{ path: '/v/one', name: 'one' }];
  const two = [...one, { path: '/v/two', name: 'two' }];

  // An explicit flag wins over everything.
  assert.deepEqual(resolveCliVault(['node', 'pj', '--vault', '/v/x', 'ls'], two), { root: '/v/x' });
  // One registered vault needs no flag.
  assert.deepEqual(resolveCliVault(['node', 'pj', 'ls'], one), { root: '/v/one' });
  // Several, with no choice made, must ask rather than guess.
  const ambiguous = resolveCliVault(['node', 'pj', 'ls'], two);
  assert.ok('error' in ambiguous && /--vault/.test(ambiguous.error));
  // None at all says how to get one.
  const none = resolveCliVault(['node', 'pj', 'ls'], []);
  assert.ok('error' in none && /no vault/.test(none.error));
  // A flag with no value is an error, not a silent fallback.
  const bare = resolveCliVault(['node', 'pj', 'ls', '--vault'], one);
  assert.ok('error' in bare);
});

// ---------------------------------------------------------------- kind and due

test('a record declares no class of thing; only id and title are required', () => {
  const bare = parseCard('/c.md', '---\nid: c\ntitle: C\n---\n');
  assert.ok(bare.ok);
  assert.deepEqual(bare.rec.facets, {});
  // `kind` used to live here, asserting card-vs-node. What it gated is read off
  // the record now: no `status` keeps it off a status-filtered board, and being
  // named as a `parent` is what makes it a container.
  assert.equal('kind' in bare.rec.facets, false);
});

test('a yaml date in a facet round-trips as a date, not a timestamp', () => {
  const res = parseCard('/d.md', '---\nid: d\ntitle: D\nfacets: { due: [2026-09-01] }\n---\n');
  assert.ok(res.ok);
  // Storage is uniform — the file holds a string and the *type* governs what it
  // means — so a YAML date must not arrive as an ISO timestamp.
  assert.deepEqual(res.rec.facets.due, ['2026-09-01']);
  assert.match(renderCard({ ...res.rec }), /due: \[2026-09-01\]/);
});

// ---------------------------------------------------------------- validation

function facetsFile(body: string): string {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'projector-facets-'));
  const f = pathJoin(dir, 'facets.yaml');
  writeFileSync(f, body, 'utf8');
  return f;
}

function recordOf(text: string): Rec {
  const res = parseCard('/x.md', text);
  assert.ok(res.ok);
  return res.rec;
}

test('a single-valued facet holding two values is an error, not a card in two columns', () => {
  const facets = loadFacets(
    facetsFile('status: { values: [planning, done], open: false, single: true }\n'),
  );
  const bad = recordOf('---\nid: x\ntitle: X\nfacets: { status: [planning, done] }\n---\n');
  const issues = validate(new Map([['x', bad]]), facets, '/data');
  const single = issues.filter((i) => /one value at a time/.test(i.message));
  assert.equal(single.length, 1);
  assert.equal(single[0]!.severity, 'error');

  const good = recordOf('---\nid: x\ntitle: X\nfacets: { status: [done] }\n---\n');
  assert.equal(
    validate(new Map([['x', good]]), facets, '/data').filter((i) => i.severity === 'error').length,
    0,
  );
});

test('a typed value must be what the type says', () => {
  const facets = loadFacets(
    facetsFile('due: { type: date, single: true }\nestimate: { type: number }\n'),
  );
  const bad = recordOf(
    '---\nid: x\ntitle: X\nfacets: { due: ["next friday"], estimate: [big] }\n---\n',
  );
  const issues = validate(new Map([['x', bad]]), facets, '/data');
  assert.ok(issues.some((i) => i.severity === 'error' && /not YYYY-MM-DD/.test(i.message)));
  assert.ok(issues.some((i) => i.severity === 'error' && /not a number/.test(i.message)));

  const good = recordOf('---\nid: x\ntitle: X\nfacets: { due: [2026-09-01], estimate: [3] }\n---\n');
  assert.equal(validate(new Map([['x', good]]), facets, '/data').filter((i) => i.severity === 'error').length, 0);
});

test('an ordered facet orders by its buckets, not alphabetically', () => {
  const def = loadFacets(
    facetsFile('due: { type: date, buckets: { overdue: -1, today: 0, week: 7 }, overflow: later }\n'),
  ).due!;
  // Falling through to alphabetical put `later` first, which is exactly backwards.
  assert.deepEqual(orderValues(def, ['later', 'week', 'overdue', 'today']), [
    'overdue', 'today', 'week', 'later',
  ]);
  assert.equal(bucketOf(def, '2026-08-19', '2026-08-21'), 'overdue');
  assert.equal(bucketOf(def, '2026-08-21', '2026-08-21'), 'today');
  assert.equal(bucketOf(def, '2026-08-24', '2026-08-21'), 'week');
  assert.equal(bucketOf(def, '2026-12-01', '2026-08-21'), 'later');
  // No buckets declared: the value is its own bucket.
  const plain = loadFacets(facetsFile('when: { type: date }\n')).when!;
  assert.equal(bucketOf(plain, '2026-08-19', '2026-08-21'), '2026-08-19');
});

// ---------------------------------------------------------------- history

test('pj log reads status transitions out of the diffs', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    mkdirSync(pathJoin(root, 'cards'), { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 'T');

    const card = pathJoin(root, 'cards', 'ship.md');
    writeFileSync(card, '---\nid: ship\ntitle: Ship\nfacets: { status: [planning] }\n---\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'add ship');

    writeFileSync(card, '---\nid: ship\ntitle: Ship\nfacets: { status: [done], due: [2026-09-01] }\n---\n', 'utf8');
    git('add', '-A');
    git('commit', '-qm', 'finish ship');

    const r = history(root, '1 year ago');
    assert.deepEqual(r.created, ['ship']);
    assert.deepEqual(r.finished, ['ship']);
    // Newest first, and the transition is read from the diff rather than from
    // `updated`, which only ever says that *something* changed.
    const moved = r.commits[0]!.changes.find((c) => c.kind === 'status');
    assert.ok(moved && moved.kind === 'status');
    assert.equal(moved.from, 'planning');
    assert.equal(moved.to, 'done');
    const dated = r.commits[0]!.changes.find((c) => c.kind === 'due');
    assert.ok(dated && dated.kind === 'due');
    assert.equal(dated.to, '2026-09-01');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- reference cycles

test('one cycle check serves an edge and a reference facet alike', () => {
  const out: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] };
  const outOf = (id: string) => out[id] ?? [];
  // c already reaches nothing, so a can point at it.
  assert.equal(wouldCycle('a', 'c', outOf), false);
  // b reaches c, so c pointing back at a would close the loop through both.
  assert.equal(wouldCycle('c', 'a', outOf), true);
  // A record pointing at itself is the degenerate case, caught the same way.
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

// ---------------------------------------------------------------- the seed

test('every seeded file parses as what it claims to be', () => {
  // The facet vocabulary and the conventions doc are template literals, so a
  // stray backtick in a comment silently ends the string and breaks the whole
  // module. That has happened three times; this is the guard.
  const facets = parse(SEED_FACETS) as Record<string, Record<string, unknown>>;
  assert.ok(Object.keys(facets).length > 5);
  for (const [name, def] of Object.entries(facets)) {
    assert.equal(typeof def, 'object', `${name} should be a mapping`);
  }
  // Reference facets declare no values, and every relation is one.
  for (const name of ['parent', 'blocks', 'project']) {
    assert.equal(facets[name]!.type, 'ref', `${name} should be a reference facet`);
    assert.equal(facets[name]!.values, undefined, `${name} should declare no values`);
  }
  for (const view of SEED_VIEWS) {
    const y = parse(view.body) as Record<string, unknown>;
    assert.ok(y.shape, `${view.path} states its shape`);
    assert.ok(y.title, `${view.path} has a title`);
  }
});

test('a new vault is seeded with a vocabulary and views, and no prose', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-seed-'));
  try {
    initVault(root, SEED_FACETS, SEED_VIEWS);
    assert.ok(existsSync(pathJoin(root, 'facets.yaml')));
    assert.ok(existsSync(pathJoin(root, 'cards')));
    assert.ok(existsSync(pathJoin(root, 'views')));
    // No card-conventions README. That text was a copy of the `projector` skill,
    // which an agent already has — and two places stating the format is one
    // place to drift out of date.
    assert.equal(existsSync(pathJoin(root, 'cards', 'README.md')), false);
    // A seeded vault is a vault, and an empty one: the README used to be the
    // only file in cards/, so this is what "no cards yet" now looks like.
    assert.ok(looksLikeVault(root));
    assert.equal(countCards(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the seeded vocabulary covers every facet the seeded views use', () => {
  const facets = parse(SEED_FACETS) as Record<string, unknown>;
  const computed = new Set(['type', 'blocked', 'triage', 'due', 'staleness']);
  for (const view of SEED_VIEWS) {
    const y = parse(view.body) as { filter?: Record<string, unknown>; groupBy?: string[]; chips?: string[] };
    for (const name of [...Object.keys(y.filter ?? {}), ...(y.groupBy ?? []), ...(y.chips ?? [])]) {
      assert.ok(name in facets || computed.has(name), `${view.path} uses unknown facet "${name}"`);
    }
  }
});

// ---------------------------------------------------------------- nested set

function scratchVault(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-set-'));
  mkdirSync(pathJoin(root, 'cards'), { recursive: true });
  writeFileSync(
    pathJoin(root, 'facets.yaml'),
    'status: { values: [planning, done], open: false, single: true }\ndue: { type: date, single: true }\n',
    'utf8',
  );
  writeFileSync(
    pathJoin(root, 'cards', 'x.md'),
    '---\nid: x\n# a comment worth keeping\ntitle: X\nfacets: { status: [planning] }\n---\n\nbody\n',
    'utf8',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('--set writes a nested field, and YAML values carry structure', () => {
  const { root, cleanup } = scratchVault();
  try {
    patchFields(root, 'x', { 'project.jira': 'PROJ' });
    patchFields(root, 'x', { 'project.repos': '[{path: ~/a, base: main}]' });
    const rec = loadCard(pathJoin(root, 'cards', 'x.md'));
    assert.ok(rec.ok);
    // A flat key=value cannot express a list of maps, which is why the value is
    // parsed as YAML rather than split on a separator.
    assert.equal(rec.rec.project?.jira, 'PROJ');
    assert.deepEqual(rec.rec.project?.repos, [{ path: '~/a', base: 'main' }]);
    // Only the touched key is rewritten, so everything else survives.
    const text = readFileSync(pathJoin(root, 'cards', 'x.md'), 'utf8');
    assert.match(text, /# a comment worth keeping/);
    assert.equal(text.endsWith('\nbody\n'), true);
  } finally {
    cleanup();
  }
});

test('--set project={} makes a project and --set project= unmakes one', () => {
  const { root, cleanup } = scratchVault();
  try {
    patchFields(root, 'x', { project: '{}' });
    const made = loadCard(pathJoin(root, 'cards', 'x.md'));
    assert.ok(made.ok);
    assert.equal(isProject(made.rec), true);
    patchFields(root, 'x', { project: '' });
    const after = loadCard(pathJoin(root, 'cards', 'x.md'));
    assert.ok(after.ok);
    assert.equal(after.rec.project, undefined);
  } finally {
    cleanup();
  }
});

test('--set is validated against the result, not the input', () => {
  const { root, cleanup } = scratchVault();
  try {
    // The same vocabulary rules as any other write: a single facet cannot hold
    // two, and `id` is refused because other records reference it.
    assert.throws(() => patchFields(root, 'x', { 'facets.status': '[planning, done]' }), /one value at a time/);
    assert.throws(() => patchFields(root, 'x', { id: 'y' }), /id cannot be changed/);
    assert.throws(() => patchFields(root, 'x', { 'facets.nope': '[a]' }), /unknown facet/);
    assert.throws(() => patchFields(root, 'x', { 'facets.due': '["next friday"]' }), /not YYYY-MM-DD/);
    assert.throws(() => patchFields(root, 'x', { 'title.deep': 'x' }), /not a mapping/);
  } finally {
    cleanup();
  }
});

test('a caller-supplied id is honoured or refused, never silently changed', () => {
  const { root, cleanup } = scratchVault();
  try {
    assert.equal(createCard(root, { title: 'Whatever', id: 'chosen' }).id, 'chosen');
    // Something is about to reference this by name, so a collision is an error
    // rather than a quietly suffixed id.
    assert.throws(() => createCard(root, { title: 'Again', id: 'chosen' }), /already taken/);
    assert.throws(() => createCard(root, { title: 'Bad', id: 'Not A Slug' }), /lowercase slug/);
  } finally {
    cleanup();
  }
});

test('deleting a record drops every reference pointing at it', () => {
  const { root, cleanup } = scratchVault();
  try {
    writeFileSync(pathJoin(root, 'facets.yaml'), 'parent: { type: ref, single: true }\n', 'utf8');
    createCard(root, { title: 'Container', id: 'box' });
    createCard(root, { title: 'Inside', id: 'thing', parent: 'box' });
    const { removedEdges } = deleteCard(root, 'box');
    assert.equal(removedEdges, 1);
    const left = loadCard(pathJoin(root, 'cards', 'thing.md'));
    assert.ok(left.ok);
    // A dangling reference is what removing the file by hand leaves behind.
    assert.equal(left.rec.facets.parent, undefined);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- clusters

const face = (id: string): CardDTO =>
  ({ id, title: id, isProject: false, facets: {}, buckets: {}, links: [], progress: null,
     excerpt: '', body: '', updated: null, childCount: 0, blockedBy: [], unblocks: [] }) as CardDTO;

test('a record in several groups is clustered into the first the axis declares', () => {
  const nodes = [face('a'), face('b'), face('c')];
  const groups = [
    { value: 'now', ids: ['a', 'b'] },
    { value: 'month', ids: ['b'] },
  ];
  const assign = assignClusters(nodes, groups);
  // A board draws `b` in both columns; a canvas cannot, because a record has one
  // position. First declared wins, and the sidebar says how many that applies to.
  assert.equal(assign.get('b'), 'now');
  assert.equal(assign.get('a'), 'now');
  // `c` matched no group — it is context, and gets a band of its own rather than
  // being scattered through the others.
  assert.equal(assign.get('c'), CONTEXT_BAND);
});

test('clusters stack without overlapping, context last', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(face);
  const groups = [
    { value: 'now', ids: ['a', 'b'] },
    { value: 'month', ids: ['c'] },
  ];
  const placed = clusteredLayout(nodes, [], [], groups);
  const boxes = clusterBoxes(assignClusters(nodes, groups), placed, groups);
  assert.deepEqual(boxes.map((b) => b.value), ['now', 'month', CONTEXT_BAND]);
  for (let i = 1; i < boxes.length; i++) {
    assert.ok(boxes[i]!.y > boxes[i - 1]!.y + boxes[i - 1]!.h - 1, 'bands must not overlap');
  }
});

test('a band is measured from where its members actually are', () => {
  const nodes = ['a', 'b'].map(face);
  const groups = [{ value: 'now', ids: ['a', 'b'] }];
  const placed = clusteredLayout(nodes, [], [], groups);
  const before = clusterBoxes(assignClusters(nodes, groups), placed, groups)[0]!;
  // Dragging a card grows its band, because the box is derived from final
  // positions rather than from the layout pass — which is what lets a saved
  // arrangement and clustering coexist without agreeing about anything.
  placed.set('b', { ...placed.get('b')!, x: 4000 });
  const after = clusterBoxes(assignClusters(nodes, groups), placed, groups)[0]!;
  assert.ok(after.w > before.w);
});

test('an empty declared value gets no band', () => {
  const nodes = [face('a')];
  const groups = [
    { value: 'now', ids: ['a'] },
    { value: 'someday', ids: [] },
  ];
  // A board draws an empty column because it is somewhere to drag a card *to*.
  // Dragging on a canvas moves a position and changes no facet, so an empty band
  // would be decoration with no affordance.
  const boxes = clusterBoxes(assignClusters(nodes, groups), clusteredLayout(nodes, [], [], groups), groups);
  assert.deepEqual(boxes.map((b) => b.value), ['now']);
});

/**
 * A view file naming a facet the vocabulary does not have.
 *
 * This is the `pj next` bug in its new address. That command spent two days
 * filtering on `kind`, a facet P7 deleted, and an empty result is not an error —
 * so moving the query out of TypeScript and into `views/*.yaml` would have moved
 * the failure rather than fixing it. `pj check` reading views is what closes it.
 */
test('a view naming an unknown axis is an error, in every position it can appear', () => {
  const facets = loadFacets(
    facetsFile('status: { values: [planning, done] }\nparent: { type: ref }\n'),
  );
  const view = (raw: Record<string, unknown>) => [
    { spec: specFromFile('v', raw), file: '/data/views/v.yaml' },
  ];

  const cases: [string, Record<string, unknown>][] = [
    ['filter', { filter: { kind: ['task'] } }],
    ['groupBy', { groupBy: ['kind'] }],
    ['sort', { sort: ['kind:asc'] }],
    ['show', { show: ['kind'] }],
  ];
  for (const [where, raw] of cases) {
    const issues = validateViews(view(raw), facets);
    assert.equal(issues.length, 1, `${where}: expected exactly one issue`);
    assert.equal(issues[0]!.severity, 'error', `${where}: must be an error, not a warning`);
    assert.match(issues[0]!.message, /kind/, `${where}: must name the offending axis`);
  }

  // `focus.via` is walked, so it has to be a reference facet specifically — a
  // label facet parses fine and then traverses nothing.
  const viaLabel = validateViews(view({ focus: { id: 'x', via: 'status', dir: 'in' } }), facets);
  assert.equal(viaLabel.length, 1);
  assert.match(viaLabel[0]!.message, /reference facet/);

  // Pseudo-facets are legitimate axes, and every real position is accepted.
  const good = validateViews(
    view({
      filter: { status: ['planning'], blocked: ['clear'] },
      groupBy: ['triage'],
      sort: ['status:asc', 'updated:desc', 'title:asc'],
      show: ['parent', 'status'],
      focus: { id: 'x', via: 'parent', dir: 'in' },
    }),
    facets,
  );
  assert.deepEqual(good, [], 'a view built from declared axes must be clean');
});

/**
 * `pj link` is the only writer of a card's `links`, and it goes through the gate.
 *
 * Three commands used to write that array. `link` and `unlink` patched
 * frontmatter directly and so never bumped `updated`, while `link-session` went
 * through `patchCard` and did — so attaching a Jira issue left a card reading as
 * untouched, on a field README says "only ever says that *something* changed".
 */
test('linking bumps updated, and unlinking an absent ref refuses', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-link-'));
  try {
    mkdirSync(pathJoin(root, 'cards'), { recursive: true });
    writeFileSync(
      pathJoin(root, 'cards', 'a.md'),
      '---\nid: a\ntitle: Card A\nupdated: 2020-01-01\n---\nbody\n',
      'utf8',
    );
    writeFileSync(pathJoin(root, 'facets.yaml'), 'status: { values: [planning, done] }\n', 'utf8');

    patchCard(root, 'a', { links: ['jira:FOO-1'] });
    const after = readFileSync(pathJoin(root, 'cards', 'a.md'), 'utf8');
    assert.match(after, /links: \[jira:FOO-1\]/);
    assert.doesNotMatch(after, /updated: 2020-01-01/, 'a write that leaves `updated` alone is the bug');
    assert.match(after, /updated: \d{4}-\d{2}-\d{2}/);

    // Emptying the array drops the key rather than storing `links: []`.
    patchCard(root, 'a', { links: [] });
    assert.doesNotMatch(readFileSync(pathJoin(root, 'cards', 'a.md'), 'utf8'), /links:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The gesture that meant two things.
 *
 * The board computed `nextValues` for one card and then threw it away whenever
 * more than one was selected, sending uniform values to the bulk endpoint
 * instead. Three of four gestures diverged and one *inverted*: shift-dragging
 * `now`→`month` took `now` off a single card and `month` off a batch. There is no
 * cardinality branch to test any more, so this asserts the property instead — the
 * intent carries endpoints, and one transform answers for every card.
 */
test('a drop means the same thing however many cards are selected', () => {
  const both = ['now', 'month'];
  const cases: [string, string, DragMode, string[]][] = [
    ['now', 'month', 'remove', ['month']],
    ['now', 'backlog', 'replace', ['month', 'backlog']],
    ['now', NONE, 'replace', ['month']],
    ['now', 'month', 'add', both],
  ];
  for (const [from, to, mode, want] of cases) {
    const intent = dropOutcome({
      cardId: 'a',
      from,
      to,
      onCard: null,
      groupBy: 'priority',
      mode,
      selected: new Set(['a', 'b', 'c']),
      order: [],
      viewName: 'home',
    });
    assert.equal(intent.kind, 'facet');
    assert.ok(intent.kind === 'facet');
    // The endpoints travel, never the values — which is what makes one card and
    // twelve the same request.
    assert.deepEqual({ from: intent.from, to: intent.to, mode: intent.mode }, { from, to, mode });
    assert.deepEqual(intent.ids, ['a', 'b', 'c'], 'a selected card drags the selection');
    // And every one of them resolves through the same transform.
    for (const id of intent.ids) {
      assert.deepEqual(nextValues(both, intent.from, intent.to, intent.mode), want, `${id}: ${mode}`);
    }
  }
});

test('dragging an unselected card moves only that card', () => {
  const intent = dropOutcome({
    cardId: 'z',
    from: 'now',
    to: 'month',
    onCard: null,
    groupBy: 'priority',
    mode: 'replace',
    selected: new Set(['a', 'b']),
    order: [],
    viewName: 'home',
  });
  assert.ok(intent.kind === 'facet');
  assert.deepEqual(intent.ids, ['z']);
});

/**
 * A reorder splices into the column's stored order, and the index it is given has
 * to be an index into that same list. It used to be the position within one
 * lane's cell, which is a subset of the column once a secondary axis is in play —
 * so a matrix reorder wrote the card somewhere else. With no lanes the two
 * coincide, which is why it went unnoticed.
 */
test('a reorder lands where the pointer aimed, across lanes', () => {
  const order = ['a', 'b', 'c', 'd'];
  const at = (index: number, below: boolean) => {
    const intent = dropOutcome({
      cardId: 'd',
      from: 'now',
      to: 'now',
      onCard: { id: order[index]!, index, below },
      groupBy: 'priority',
      mode: 'replace',
      selected: new Set(),
      order,
      viewName: 'home',
    });
    assert.ok(intent.kind === 'reorder');
    return intent.ids;
  };
  assert.deepEqual(at(0, false), ['d', 'a', 'b', 'c'], 'above the first');
  assert.deepEqual(at(0, true), ['a', 'd', 'b', 'c'], 'below the first');
  assert.deepEqual(at(1, true), ['a', 'b', 'd', 'c'], 'below the second');
});

test('a drop with nowhere to put an order says so instead of vanishing', () => {
  const intent = dropOutcome({
    cardId: 'a',
    from: 'now',
    to: 'now',
    onCard: { id: 'b', index: 1, below: false },
    groupBy: 'priority',
    mode: 'replace',
    selected: new Set(),
    order: ['a', 'b'],
    viewName: undefined,
  });
  assert.deepEqual(intent, {
    kind: 'none',
    why: 'order has nowhere to live without a saved view',
  });
});

/** A single-valued relation moves rather than stacking; a multi-valued one adds. */
test('connecting two nodes moves a hierarchy edge and adds an ordinary one', () => {
  const facets = loadFacets(
    facetsFile('parent: { type: ref, single: true }\nblocks: { type: ref }\n'),
  );
  const valuesOf = (id: string) => (id === 'child' ? ['oldparent'] : []);

  // `parent` is the layout relation and single: dragging parent→child writes the
  // child, taking the parent it already had off.
  const up = connectOutcome({
    source: 'newparent',
    target: 'child',
    relation: 'parent',
    facets,
    layout: 'parent',
    valuesOf,
  });
  assert.ok(up.kind === 'facet');
  assert.deepEqual(up.ids, ['child']);
  assert.deepEqual(nextValues(['oldparent'], up.from, up.to, up.mode), ['newparent']);

  // `blocks` is multi-valued: the source owns it and the value is added.
  const across = connectOutcome({
    source: 'a',
    target: 'b',
    relation: 'blocks',
    facets,
    layout: 'parent',
    valuesOf: () => ['c'],
  });
  assert.ok(across.kind === 'facet');
  assert.deepEqual(across.ids, ['a']);
  assert.deepEqual(nextValues(['c'], across.from, across.to, across.mode), ['c', 'b']);

  // A relation that is not a reference facet cannot be drawn, so nothing happens.
  const bogus = connectOutcome({
    source: 'a',
    target: 'b',
    relation: 'priority',
    facets,
    layout: null,
    valuesOf: () => [],
  });
  assert.equal(bogus.kind, 'none');
});

/**
 * The self-blocking card that read `clear` on the axis while its own DTO said it
 * blocked itself, ten times over — the SQL closure applied neither of the two
 * rules `refsOf` applies, and was depth-capped at 10.
 */
test('a self-reference and a dangling one are dropped by every blocks answer', () => {
  const records = new Map(
    [
      recordOf('---\nid: loop\ntitle: Loops\nfacets: { blocks: [loop], status: [planning] }\n---\n'),
      recordOf('---\nid: ghost\ntitle: Ghost\nfacets: { blocks: [nowhere], status: [planning] }\n---\n'),
      recordOf('---\nid: real\ntitle: Real\nfacets: { blocks: [target], status: [planning] }\n---\n'),
      recordOf('---\nid: target\ntitle: Target\nfacets: { status: [planning] }\n---\n'),
      recordOf('---\nid: fin\ntitle: Finished\nfacets: { blocks: [target], status: [done] }\n---\n'),
    ].map((r) => [r.id, r]),
  );

  assert.deepEqual(unblocks('loop', records), [], 'a self-loop unblocks nothing, and terminates');
  assert.deepEqual(blockedBy('loop', records), [], 'and is blocked by nothing');
  assert.deepEqual(unblocks('ghost', records), [], 'a value naming no record is not a target');
  assert.deepEqual(unblocks('real', records), ['target']);

  // A finished blocker stops blocking; an unfinished one does not.
  assert.deepEqual(
    blockedBy('target', records).map((b) => [b.id, b.done]).sort(),
    [['fin', true], ['real', false]],
  );
  assert.ok(blockedSet(records).has('target'), 'one unfinished blocker is enough');
  assert.ok(!blockedSet(records).has('loop'), 'and a self-reference is not one');
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
test('grouping is one answer, and the empty-group policy is an argument', () => {
  const data = {
    ids: ['a', 'b'],
    axis: ['now', 'month', 'backlog'],
    groups: [
      // Deliberately out of axis order, and one empty.
      { value: 'backlog', ids: ['b'] },
      { value: 'month', ids: [] },
      { value: 'now', ids: ['a'] },
    ],
  } as unknown as Parameters<typeof groupsFor>[0];

  assert.deepEqual(
    groupsFor(data, { empties: 'keep' }).map((g) => g.value),
    ['now', 'month', 'backlog'],
    'ordered by the axis the server declared, not by arrival',
  );
  assert.deepEqual(
    groupsFor(data, { empties: 'drop' }).map((g) => g.value),
    ['now', 'backlog'],
    'a canvas band and a table section need something in them',
  );

  // Ungrouped: one nameless group holding everything, which every shape open-coded.
  const flat = { ids: ['a', 'b'], axis: [], groups: null } as unknown as Parameters<
    typeof groupsFor
  >[0];
  assert.deepEqual(groupsFor(flat, { empties: 'keep' }), [{ value: '', ids: ['a', 'b'] }]);
});

test('a value the axis does not declare sorts after the ones it does', () => {
  const data = {
    ids: [],
    axis: ['now'],
    groups: [
      { value: 'adhoc', ids: ['x'] },
      { value: 'now', ids: ['y'] },
    ],
  } as unknown as Parameters<typeof groupsFor>[0];
  assert.deepEqual(groupsFor(data, { empties: 'keep' }).map((g) => g.value), ['now', 'adhoc']);
});

/** Five places said it four ways, one of them by printing the wire form. */
test('the absence refinement has one wording', () => {
  assert.equal(labelFor(NONE), 'no value');
  assert.equal(labelFor('now'), 'now');
});
