import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, patchKey, serialize, split } from '../src/schema/frontmatter.ts';
import { parseNote, renderNote } from '../src/schema/note.ts';
import { clean, slugify, uniqueId } from '../src/schema/slug.ts';
import { LINK_KINDS, fallbackHref, parseLink } from '../src/schema/links.ts';
import { validate } from '../src/schema/validate.ts';
import { bucketOf, loadFacets, orderValues } from '../src/schema/facets.ts';
import type { Note } from '../src/schema/types.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join as pathJoin, } from 'node:path';
import { tmpdir } from 'node:os';


/**
 * The card format: frontmatter round-trips, parsing, slugs, typed values and validation.
 *
 * Split out of a 1,306-line `model.test.ts` that had become the catch-all: anything
 * not obviously about the query compiler, a view spec or intake landed there, and
 * knowing what was covered meant reading all of it.
 */

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
  const res = parseNote('/f.md', `---\nid: x\nkind: card\ntitle: T\n---\n${original}`);
  assert.ok(res.ok);
  assert.equal(res.rec.body, original);
  assert.equal(split(renderNote(res.rec)).body, original);
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
  const res = parseNote('/f.md', '---\nid: x\ntitle: T\nfacets: { invented: [a] }\n---\n');
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
  const res = parseNote('/f.md', CARD);
  assert.ok(res.ok);
  assert.deepEqual(res.rec.facets.status, ['active']);
  assert.deepEqual(res.rec.facets.priority, ['now']);
});

test('links are parsed into kind and ref', () => {
  const res = parseNote('/f.md', CARD);
  assert.ok(res.ok);
  assert.deepEqual(
    res.rec.links.map((l) => l.kind),
    ['jira', 'url'],
  );
});

test('a bad id is reported, not thrown', () => {
  const res = parseNote('/f.md', '---\nid: Not A Slug\nkind: card\ntitle: T\n---\n');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.errors.join(' '), /slug/);
});

test('render then parse round-trips', () => {
  const res = parseNote('/f.md', CARD);
  assert.ok(res.ok);
  const again = parseNote('/f.md', renderNote({ ...res.rec }));
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

/**
 * One example per declared kind, keyed off `LINK_KINDS` itself — so a kind added
 * tomorrow fails here until someone has decided where it opens, rather than
 * silently rendering as dead text the way `slack` did.
 */
const HREF_CASES: Record<(typeof LINK_KINDS)[number], { raw: string; href: string | null }> = {
  jira: { raw: 'jira:PROJ-303', href: 'https://acme.atlassian.net/browse/PROJ-303' },
  'gh:pr': { raw: 'gh:pr:Org/repo#4', href: 'https://github.com/Org/repo/pull/4' },
  'gh:branch': { raw: 'gh:branch:Org/repo@main', href: 'https://github.com/Org/repo/tree/main' },
  'gh:commit': { raw: 'gh:commit:Org/repo@abc123', href: 'https://github.com/Org/repo/commit/abc123' },
  // A session on this machine and a file in the vault: neither is a web page.
  claude: { raw: 'claude:local_abc', href: null },
  doc: { raw: 'doc:a/b.md', href: null },
  // The ref is already the permalink — no fetcher, and no special case either.
  slack: { raw: 'slack:https://acme.slack.com/archives/C1/p123', href: 'https://acme.slack.com/archives/C1/p123' },
  url: { raw: 'https://example.com/x', href: 'https://example.com/x' },
};

test('every declared link kind has a decided answer for where it opens', () => {
  assert.deepEqual(
    Object.keys(HREF_CASES).sort(),
    [...LINK_KINDS].sort(),
    'a kind was added or removed without deciding its href',
  );
  for (const kind of LINK_KINDS) {
    const c = HREF_CASES[kind];
    assert.equal(fallbackHref(parseLink(c.raw), 'https://acme.atlassian.net'), c.href, kind);
  }
});

test('a link opens without any fetcher having run', () => {
  // The defect this exists for: the panel made a label clickable only when
  // enrichment supplied a url, so a kind with no fetcher was permanently dead.
  const noFetcher = ['slack', 'url'] as const;
  for (const kind of noFetcher) {
    assert.ok(fallbackHref(parseLink(HREF_CASES[kind].raw), null), `${kind} must not need enrichment`);
  }
});

test('a Jira ref has no href when no Jira host is configured', () => {
  assert.equal(fallbackHref(parseLink('jira:PROJ-303'), null), null);
  assert.equal(
    fallbackHref(parseLink('jira:PROJ-303'), 'https://acme.atlassian.net/'),
    'https://acme.atlassian.net/browse/PROJ-303',
    'a trailing slash on the configured host does not double up',
  );
});

test('a malformed ref yields no href rather than a broken one', () => {
  assert.equal(fallbackHref(parseLink('gh:pr:Org/repo'), null), null, 'no PR number');
  assert.equal(fallbackHref(parseLink('gh:branch:Org/repo@'), null), null, 'no rev');
  assert.equal(fallbackHref(parseLink('slack:not-a-url'), null), null);
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


// ---------------------------------------------------------------- kind and due

test('a note declares no class of thing; only id and title are required', () => {
  const bare = parseNote('/c.md', '---\nid: c\ntitle: C\n---\n');
  assert.ok(bare.ok);
  assert.deepEqual(bare.rec.facets, {});
  // `kind` used to live here, asserting card-vs-node. What it gated is read off
  // the note now: no `status` keeps it off a status-filtered board, and being
  // named as a `parent` is what makes it a container.
  assert.equal('kind' in bare.rec.facets, false);
});

test('a yaml date in a facet round-trips as a date, not a timestamp', () => {
  const res = parseNote('/d.md', '---\nid: d\ntitle: D\nfacets: { due: [2026-09-01] }\n---\n');
  assert.ok(res.ok);
  // Storage is uniform — the file holds a string and the *type* governs what it
  // means — so a YAML date must not arrive as an ISO timestamp.
  assert.deepEqual(res.rec.facets.due, ['2026-09-01']);
  assert.match(renderNote({ ...res.rec }), /due: \[2026-09-01\]/);
});

// ---------------------------------------------------------------- validation

function facetsFile(body: string): string {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'projector-facets-'));
  const f = pathJoin(dir, 'facets.yaml');
  writeFileSync(f, body, 'utf8');
  return f;
}

function recordOf(text: string): Note {
  const res = parseNote('/x.md', text);
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

