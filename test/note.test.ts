import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, patchKey, serialize, split } from '../src/schema/frontmatter.ts';
import { parseNote, renderNote } from '../src/schema/note.ts';
import { clean, slugify, uniqueId } from '../src/schema/slug.ts';
import { LINK_KINDS, fallbackHref, parseLink } from '../src/schema/links.ts';
import { validate } from '../src/schema/validate.ts';
import { bucketOf, loadFacets, orderValues } from '../src/schema/facets.ts';
import { demoted, merged } from '../src/schema/merge.ts';
import type { Facets, Note } from '../src/schema/types.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join as pathJoin, } from 'node:path';
import { tmpdir } from 'node:os';
import { listNoteFiles } from '../src/schema/note.ts';
import { readAll } from '../src/index/indexer.ts';


/**
 * The note format: frontmatter round-trips, parsing, slugs, typed values and validation.
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

// ---------------------------------------------------------------- note parsing

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

test('a bad id costs the name, not the note', () => {
  // This used to be an error naming the slug rule, and the cost of that only
  // showed on a real imported vault: the note vanished from the app entirely and
  // only `pj check` said why. It now derives an id, which is exactly what a note
  // carrying no `id:` at all has always done. Writing an id is still validated —
  // leniency is for reading a file someone else's tool wrote.
  const res = parseNote('/f.md', '---\nid: Not A Slug\nkind: card\ntitle: T\n---\n');
  assert.ok(res.ok);
  assert.equal(res.rec.id, 'f');
  assert.equal(res.rec.title, 'T');
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
  // A session on this machine, the directory one worked in, and a file in the
  // vault: none of the three is a web page.
  claude: { raw: 'claude:local_abc', href: null },
  workspace: { raw: 'workspace:/wt/plat-wt-ship-it', href: null },
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

// ---------------------------------------------------------------- bare notes

/**
 * A markdown file is a note, and a note need say nothing about itself.
 *
 * This is what lets a folder of somebody's existing notes be *opened* rather than
 * imported. Every assertion here is about a file nobody wrote for projector.
 */
test('a file with no frontmatter is a note, named by its heading and its filename', () => {
  const res = parseNote('/vault/Reading Notes.md', '# Monday reading\n\nWe talked about the thing.\n');
  assert.ok(res.ok, 'no frontmatter is not a parse failure');
  assert.equal(res.rec.id, 'reading-notes', 'the filename, lowercased, dashes for the rest');
  assert.equal(res.rec.title, 'Monday reading', 'the leading heading');
  assert.deepEqual(res.rec.facets, {});
  assert.deepEqual(res.rec.links, []);
  // The body is the whole file, byte for byte — the heading included. Dropping it
  // is the *renderer's* business, and only when it duplicates the title.
  assert.equal(res.rec.body, '# Monday reading\n\nWe talked about the thing.\n');
});

test('a note names itself by its filename when the body has no leading heading', () => {
  // A heading further down is a section, not a title.
  const res = parseNote('/vault/kafka-retention.md', 'Some prose first.\n\n# Not the title\n');
  assert.ok(res.ok);
  assert.equal(res.rec.title, 'kafka-retention');
});

test('frontmatter that says nothing about identity still gets some', () => {
  // The case that matters: an Obsidian note with properties and no `id`. Requiring
  // one the moment a fence exists would reject exactly the vaults this is for.
  const res = parseNote('/vault/2026 review.md', '---\ntags: [year]\n---\n\n# The year\n');
  assert.ok(res.ok, `should parse: ${res.ok ? '' : res.errors.join('; ')}`);
  assert.equal(res.rec.id, '2026-review');
  assert.equal(res.rec.title, 'The year');
});

test('a derived id is always a legal id, whatever the filename was', () => {
  const id = (f: string) => {
    const res = parseNote(f, 'x');
    return res.ok ? res.rec.id : null;
  };
  assert.equal(id('/v/Meeting — 12 Aug (draft).md'), 'meeting-12-aug-draft');
  assert.equal(id('/v/__private__.md'), 'private', 'no leading or trailing dash');
  assert.equal(id('/v/日記.md'), 'note', 'a name with nothing to keep still gets one');
  // Every one of them satisfies the schema's own rule for a written id.
  for (const f of ['/v/Meeting — 12 Aug (draft).md', '/v/__private__.md', '/v/日記.md']) {
    assert.match(id(f)!, /^[a-z0-9][a-z0-9-]*$/);
  }
});

/**
 * A folder's README is the folder.
 *
 * This is the whole of what makes a project a folder: `platform/README.md` is the
 * note `platform`, so the folder name *is* the id and there is no second name to
 * keep in step with it (C11). Without the rule every README in the vault derives
 * `readme`, and a vault with three project folders has three notes claiming one
 * id — two of which `readAll` drops.
 */
test('a README takes the name of its folder, and the vault root one does not', () => {
  const root = '/vault';
  const id = (f: string) => {
    const res = parseNote(f, '# Hello\n', root);
    return res.ok ? res.rec.id : null;
  };
  assert.equal(id('/vault/platform/README.md'), 'platform');
  assert.equal(id('/vault/Identity and Access/README.md'), 'identity-and-access', 'slugged like any other name');
  assert.equal(id('/vault/README.md'), 'readme', "the vault's own front page keeps its filename");
  // Every other filename is unaffected, README rule or not.
  assert.equal(id('/vault/platform/notes.md'), 'notes');
});

test('a folder README with no heading is titled by its folder too', () => {
  const res = parseNote('/vault/platform/README.md', 'just prose\n', '/vault');
  assert.ok(res.ok);
  assert.equal(res.rec.title, 'platform');
});

test('a stated id still wins over the folder', () => {
  const res = parseNote('/vault/platform/README.md', '---\nid: infra\n---\n', '/vault');
  assert.ok(res.ok);
  assert.equal(res.rec.id, 'infra');
});

test('without a root, a README is just a file called README', () => {
  // The signature is what carries the rule, so a caller with no vault in hand —
  // `pj log`, reading blobs out of git — cannot accidentally get folder ids for
  // paths that were never measured against a vault.
  const res = parseNote('/vault/platform/README.md', 'x');
  assert.ok(res.ok);
  assert.equal(res.rec.id, 'readme');
});

/**
 * `AGENTS.md` is configuration, and configuration is not a note.
 *
 * It holds a project's instructions, which were a `project:` key until they got
 * their own file — and a key in the frontmatter block was never a note either.
 * Indexed, every project folder would contribute a note called `agents`, all of
 * them claiming one id, and the instructions would be both a note body and
 * inherited config: the one thing C11 forbids.
 */
test('AGENTS.md is not a note, anywhere in the vault', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-walk-'));
  mkdirSync(pathJoin(root, 'platform'));
  writeFileSync(pathJoin(root, 'AGENTS.md'), 'how this vault is kept', 'utf8');
  writeFileSync(pathJoin(root, 'platform', 'AGENTS.md'), 'how platform work is done', 'utf8');
  writeFileSync(pathJoin(root, 'platform', 'README.md'), '# Platform\n', 'utf8');
  writeFileSync(pathJoin(root, 'platform', 'design.md'), '# Design\n', 'utf8');

  assert.deepEqual(
    listNoteFiles(root).map((f) => f.slice(root.length + 1)).sort(),
    ['platform/README.md', 'platform/design.md'],
  );
  const { notes, duplicates } = readAll(root);
  assert.deepEqual([...notes.keys()].sort(), ['design', 'platform']);
  assert.deepEqual(duplicates, [], 'two folders with a README are not two notes called readme');
});

/**
 * The walk honours .gitignore — a subset of it: what git would never name, the
 * vault never indexes. A repo dropped into a vault (or a vault opened over a
 * workspace) contributes its documents, not its node_modules.
 */
test('CLAUDE.md is configuration, not content — anywhere, symlinked or not', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-claude-'));
  writeFileSync(pathJoin(root, 'CLAUDE.md'), 'reader-named AGENTS.md', 'utf8');
  writeFileSync(pathJoin(root, 'CLAUDE.local.md'), 'private half', 'utf8');
  writeFileSync(pathJoin(root, 'real.md'), '# real\n', 'utf8');
  assert.deepEqual(
    listNoteFiles(root).map((f) => f.slice(root.length + 1)),
    ['real.md'],
  );
});

test('.projector/ignore masks notes by pattern, from the vault root', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-mask-'));
  mkdirSync(pathJoin(root, '.projector'));
  writeFileSync(pathJoin(root, '.projector', 'ignore'), '_index.md\ndrafts/\n', 'utf8');
  mkdirSync(pathJoin(root, 'docs', 'deep'), { recursive: true });
  writeFileSync(pathJoin(root, 'docs', '_index.md'), '# hugo\n', 'utf8');
  writeFileSync(pathJoin(root, 'docs', 'deep', '_index.md'), '# hugo deep\n', 'utf8');
  writeFileSync(pathJoin(root, 'docs', 'page.md'), '# page\n', 'utf8');
  mkdirSync(pathJoin(root, 'drafts'));
  writeFileSync(pathJoin(root, 'drafts', 'wip.md'), '# wip\n', 'utf8');
  assert.deepEqual(
    listNoteFiles(root).map((f) => f.slice(root.length + 1)),
    ['docs/page.md'],
  );
});

test('git-ignored markdown is not a note', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'projector-ignore-'));
  writeFileSync(pathJoin(root, '.gitignore'), 'node_modules/\n*.draft.md\n/top-only.md\n', 'utf8');
  writeFileSync(pathJoin(root, 'kept.md'), '# kept\n', 'utf8');
  writeFileSync(pathJoin(root, 'top-only.md'), '# anchored out\n', 'utf8');
  writeFileSync(pathJoin(root, 'plan.draft.md'), '# draft\n', 'utf8');
  mkdirSync(pathJoin(root, 'repo', 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(pathJoin(root, 'repo', 'node_modules', 'pkg', 'CHANGELOG.md'), '# junk\n', 'utf8');
  writeFileSync(pathJoin(root, 'repo', 'README.md'), '# repo\n', 'utf8');
  mkdirSync(pathJoin(root, 'repo', 'dist'));
  writeFileSync(pathJoin(root, 'repo', 'dist', 'out.md'), '# built\n', 'utf8');
  writeFileSync(pathJoin(root, 'repo', '.gitignore'), 'dist/\n', 'utf8');
  // the root's anchored /top-only.md must not reach into subfolders
  writeFileSync(pathJoin(root, 'repo', 'top-only.md'), '# not anchored here\n', 'utf8');

  assert.deepEqual(
    listNoteFiles(root).map((f) => f.slice(root.length + 1)).sort(),
    ['kept.md', 'repo/README.md', 'repo/top-only.md'],
  );
});

test('a bare note keeps its identity when it is written down', () => {
  // What `patchAll` materialises has to be what the reader was already using, or
  // the first write renames the note and orphans every reference to it.
  const res = parseNote('/vault/Reading Notes.md', '# Monday reading\n\nbody\n');
  assert.ok(res.ok);
  const written = renderNote({ ...res.rec, facets: {}, links: [] });
  const reread = parseNote('/vault/Reading Notes.md', written);
  assert.ok(reread.ok);
  assert.equal(reread.rec.id, res.rec.id, 'the same id, not a fresh one');
  assert.equal(reread.rec.title, res.rec.title);
  // And it survives the rename that a derived id would not have.
  const moved = parseNote('/vault/renamed.md', written);
  assert.ok(moved.ok);
  assert.equal(moved.rec.id, 'reading-notes');
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

test('a single-valued facet holding two values is an error, not a note in two columns', () => {
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

/**
 * The one migration this change needs, made loud.
 *
 * `instructions:` parses and is then ignored, which is the worst way for a format
 * to move: the vault loads, the board draws, and members quietly stop inheriting
 * the rules they are meant to work under. So the key is kept in the schema for the
 * sole purpose of being rejected here, with the path to write instead.
 */
test('instructions left in the frontmatter are an error naming where they go', () => {
  const facets = loadFacets(facetsFile('status: { values: [done] }\n'));
  const stale = parseNote(
    '/data/platform/README.md',
    '---\nid: platform\nproject:\n  instructions: |\n    - a rule\n---\n',
  );
  assert.ok(stale.ok);
  const issues = validate(new Map([['platform', stale.rec]]), facets, '/data');
  const moved = issues.filter((i) => i.field === 'project.instructions');
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.severity, 'error');
  assert.match(moved[0]!.message, /move them to platform\/AGENTS\.md$/, 'vault-relative, like the file column beside it');

  // A flat project has no folder to put the file in, so the fix is the move that
  // makes one — and the message says so rather than naming the vault's own file.
  const flat = parseNote('/data/platform.md', '---\nid: platform\nproject:\n  instructions: x\n---\n');
  assert.ok(flat.ok);
  const atRoot = validate(new Map([['platform', flat.rec]]), facets, '/data')
    .filter((i) => i.field === 'project.instructions');
  assert.equal(atRoot.length, 1);
  assert.match(atRoot[0]!.message, /platform\/AGENTS\.md, and this note to platform\/README\.md/);

  // A project block without it is clean.
  const ok = parseNote('/data/platform/README.md', '---\nid: platform\nproject:\n  jira: PROJ\n---\n');
  assert.ok(ok.ok);
  assert.equal(
    validate(new Map([['platform', ok.rec]]), facets, '/data').filter((i) => i.severity === 'error').length,
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


// ---------------------------------------------------------------- merging

/**
 * Folding notes together.
 *
 * The composition only — `mergeNotes` in `test/mutate.test.ts` covers what it
 * takes a vault to do. What is asserted here is the asymmetry that makes a merge
 * a merge: the survivor keeps its classification, and what the absorbed notes
 * bring is what nothing else can recover.
 */
const MERGE_FACETS: Facets = {
  priority: { label: 'Priority', type: 'label', values: ['now', 'month'], open: false, single: true },
  tech: { label: 'Tech', type: 'label', values: [], open: true, single: false },
  parent: { label: 'Part of', type: 'ref', values: [], open: true, single: true },
  project: { label: 'Project', type: 'ref', values: [], open: true, single: false },
};

const note = (id: string, extra: Partial<Note> = {}): Note => ({
  id,
  title: id.toUpperCase(),
  facets: {},
  links: [],
  body: '',
  file: `/tmp/${id}.md`,
  ...extra,
});

test('a merge keeps the survivor’s labels and combines only its references', () => {
  const out = merged(
    note('keep', { facets: { priority: ['now'], tech: ['kafka'], project: ['project-a'] } }),
    [note('gone', { facets: { priority: ['month'], tech: ['temporal'], project: ['project-b'] } })],
    MERGE_FACETS,
  );
  // The absorbed note's own answers to "how urgent" and "what stack" are gone,
  // because two answers is not one note.
  assert.deepEqual(out.facets.priority, ['now']);
  assert.deepEqual(out.facets.tech, ['kafka']);
  // Its memberships are not answers, they are edges, and edges add up.
  assert.deepEqual(out.facets.project, ['project-a', 'project-b']);
});

test('a single-valued reference keeps the survivor’s, and adopts one only where it had none', () => {
  const held = merged(
    note('keep', { facets: { parent: ['a'] } }),
    [note('gone', { facets: { parent: ['b'] } })],
    MERGE_FACETS,
  );
  assert.deepEqual(held.facets.parent, ['a']);

  const adopted = merged(
    note('keep'),
    [note('gone', { facets: { parent: ['b'] } })],
    MERGE_FACETS,
  );
  // Merging a note into one with no container should leave the result where the
  // absorbed note was, rather than nowhere.
  assert.deepEqual(adopted.facets.parent, ['b']);
});

/**
 * The case every "merge this into its parent" hits, and the one that would
 * otherwise be refused by `checkFacets` at the moment of writing: a reference
 * naming a note that is being collapsed names the result, and the result cannot
 * reference itself.
 */
test('a reference naming a collapsed note is dropped, not rewritten', () => {
  const out = merged(
    note('keep', { facets: { project: ['keep', 'project-a'] } }),
    [note('gone', { facets: { project: ['keep', 'gone'] } })],
    MERGE_FACETS,
  );
  assert.deepEqual(out.facets.project, ['project-a']);
});

test('a merge combines links without repeating one', () => {
  const out = merged(
    note('keep', { links: [parseLink('jira:PROJ-1'), parseLink('doc:x')] }),
    [note('gone', { links: [parseLink('jira:PROJ-1'), parseLink('slack:https://s/1')] })],
    MERGE_FACETS,
  );
  assert.deepEqual(out.links, ['jira:PROJ-1', 'doc:x', 'slack:https://s/1']);
});

test('a merged body is the survivor’s prose, then one section per absorbed note', () => {
  const out = merged(
    note('keep', { title: 'Keep', body: '\nWhat I knew.\n' }),
    [
      note('one', { title: 'First thing', body: '\nSomething else.\n' }),
      note('two', { title: 'Second thing' }),
    ],
    MERGE_FACETS,
  );
  assert.equal(
    out.body,
    '\nWhat I knew.\n\n## First thing\n\nSomething else.\n\n## Second thing\n',
  );
});

/**
 * An absorbed note's headings belong *under* the section that names it. A note
 * with an empty body still gets its heading: most notes in a real vault are a
 * title and nothing else, and the heading is then the whole record that anything
 * was folded in at all.
 */
test('an absorbed note’s own headings are pushed one level deeper', () => {
  const out = merged(
    note('keep', { body: '' }),
    [note('gone', { title: 'Gone', body: '\n## Its own section\n\ntext\n' })],
    MERGE_FACETS,
  );
  assert.equal(out.body, '\n## Gone\n\n### Its own section\n\ntext\n');
});

test('a fenced block is not a heading, however many hashes it starts with', () => {
  const body = ['# real', '```bash', '# a comment', '```', '###### floor'].join('\n');
  assert.equal(
    demoted(body),
    ['## real', '```bash', '# a comment', '```', '###### floor'].join('\n'),
  );
  // `#tag` is not a heading either — CommonMark wants the space.
  assert.equal(demoted('#tag'), '#tag');
});

/**
 * A note's fingerprint is what stops a capture sweep proposing it twice, and a
 * merge deletes the file that held it. The survivor answers for it instead, or
 * everything ever merged comes back on the next sweep as new.
 */
test('the survivor answers for every fingerprint it absorbs, and never for its own twice', () => {
  const out = merged(
    note('keep', { source_fingerprint: 'jira:PROJ-1' }),
    [
      note('gone', { source_fingerprint: 'slack:C1/1', absorbed_fingerprints: ['todo:old'] }),
      note('also', { source_fingerprint: 'jira:PROJ-1' }),
    ],
    MERGE_FACETS,
  );
  assert.deepEqual(out.absorbed, ['slack:C1/1', 'todo:old']);
});

test('a foreign date stamp costs the field, not the note', () => {
  // What five years of Logseq exports actually carry: a millisecond stamp under
  // a key this app also uses. Rejecting the note over it hid a quarter of a real
  // vault while the app reported itself as working.
  const res = parseNote('/x/wCQkv.md', '---\ncreated: 20210330234143398\ntags: type/report\n---\n\nбыл дома\n');
  assert.ok(res.ok, 'the note parses');
  // ISO 8601 basic is still ISO 8601: the date is read, the time after it dropped.
  assert.equal(res.rec.created, '2021-03-30');
  assert.equal(res.rec.id, 'wcqkv');
});

test('a date it cannot read is absent rather than wrong', () => {
  const res = parseNote('/x/n.md', '---\ncreated: sometime last spring\n---\n');
  assert.ok(res.ok);
  assert.equal(res.rec.created, undefined);
});

test('both ISO forms read the same, and a real date still round-trips', () => {
  for (const [written, read] of [
    ['2026-08-27', '2026-08-27'],
    ['20260827', '2026-08-27'],
    ['2026-08-27T14:03:00Z', '2026-08-27'],
  ]) {
    const res = parseNote('/x/n.md', `---\nupdated: "${written}"\n---\n`);
    assert.ok(res.ok);
    assert.equal(res.rec.updated, read, written);
  }
});

test('a slug-shaped id is still the note’s own', () => {
  const res = parseNote('/x/whatever.md', '---\nid: kept-as-written\n---\n');
  assert.ok(res.ok);
  assert.equal(res.rec.id, 'kept-as-written');
});
