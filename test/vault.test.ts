import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { SEED_FACETS, SEED_VIEWS } from '../src/server/seed.ts';
import { BUILTIN_FACETS } from '../src/schema/facets.ts';
import {
  countNotes,
  initVault,
  looksLikeVault,
  normalise,
  resolveDoc,
  shippedVaults,
  suggestName,
} from '../src/vault.ts';
import { readAll } from '../src/index/indexer.ts';
import { listNoteFiles } from '../src/schema/note.ts';
import { split } from '../src/schema/frontmatter.ts';
import { loadFacets, orderValues } from '../src/schema/facets.ts';
import { validate } from '../src/schema/validate.ts';
import { isConfigured, paths, resolveCliVault, vaultAbove } from '../src/config.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join as pathJoin, resolve } from 'node:path';
import { tmpdir } from 'node:os';


/**
 * Vaults — recognising one, naming one, and the files a fresh one is seeded with.
 *
 * Split out of a 1,306-line `model.test.ts` that had become the catch-all: anything
 * not obviously about the query compiler, a view spec or intake landed there, and
 * knowing what was covered meant reading all of it.
 */

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
  assert.equal(suggestName('/Users/k/Code/projector/vaults/tutorial'), 'tutorial');
  assert.equal(suggestName('/Users/k/second-brain'), 'second-brain');
});

test('doc refs resolve against the vault, and absolutely when absolute', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'pj-vault-'));
  mkdirSync(paths(dir).config, { recursive: true });
  writeFileSync(pathJoin(dir, 'inside.md'), '# in');
  const outside = pathJoin(dir, '..', `pj-outside-${process.pid}.md`);
  writeFileSync(outside, '# out');

  assert.equal(resolveDoc('inside.md', dir).path, pathJoin(dir, 'inside.md'));
  // A doc outside the vault is reached with `../` — relative means relative to
  // the vault, not to the note file.
  assert.equal(resolveDoc(`../${basename(outside)}`, dir).path, resolve(outside));
  assert.equal(resolveDoc(outside, dir).path, resolve(outside));
  // A miss reports what it tried, so the message can say where it looked.
  const miss = resolveDoc('nope.md', dir);
  assert.equal(miss.path, null);
  assert.deepEqual(miss.tried, [pathJoin(dir, 'nope.md')]);

  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { force: true });
});

/**
 * The two halves of "is this a vault", and why they are not the same question.
 *
 * A folder of markdown can be *opened* as one — that is the whole point of the
 * layout — but it cannot be *found* as one by walking up, or `pj set` run inside
 * any repository would take that repository for its vault. Only `.projector/`,
 * which somebody made by opening a vault, answers the second question.
 */
test('markdown is enough to open a folder as a vault, and never enough to walk up to one', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'pj-vault-'));
  try {
    assert.equal(looksLikeVault(dir), false, 'an empty folder is nobody’s vault');

    // A README is a note like any other file, so a folder holding only one is a
    // folder of markdown — there is no exempted filename left.
    writeFileSync(pathJoin(dir, 'README.md'), '# Notes\n', 'utf8');
    assert.equal(looksLikeVault(dir), true, 'markdown is a vault you can open');
    assert.equal(isConfigured(dir), false, 'but nobody has opened it');
    assert.equal(vaultAbove(dir), null, 'so standing in it finds nothing');

    // Opening it is what leaves the marker, and the marker is what the walk-up
    // reads.
    mkdirSync(paths(dir).config, { recursive: true });
    assert.equal(isConfigured(dir), true);
    assert.equal(vaultAbove(pathJoin(dir, 'deep', 'er')), dir, 'from anywhere below');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI picks a vault explicitly, or unambiguously, or asks', () => {
  // The registry is the subject here, so the env seam that outranks it is cleared
  // — otherwise a `PROJECTOR_DATA` exported in the shell answers every case.
  delete process.env.PROJECTOR_DATA;
  const one = [{ path: '/v/one', name: 'one' }];
  const two = [...one, { path: '/v/two', name: 'two' }];

  // An explicit flag wins over everything. What the flag was spelled as is the
  // CLI's business — see cli.test.ts, which spells it four ways.
  assert.deepEqual(resolveCliVault('/v/x', two), { root: '/v/x' });
  // One registered vault needs no flag.
  assert.deepEqual(resolveCliVault(null, one), { root: '/v/one' });

  // A registered *name* is the first reading of the flag, and beats a folder of
  // that name in the working directory — `pj -v two` used to mean `./two`, so
  // running it one level above a vault's folder silently acted on a directory
  // that was not there. The name is exact: a near miss is a path, not a guess at
  // which vault was meant.
  assert.deepEqual(resolveCliVault('two', two), { root: '/v/two' });
  assert.deepEqual(resolveCliVault('tw', two), { root: resolve(process.cwd(), 'tw') });
  // With nothing registered under that name it is a path, which is what keeps
  // `--vault ../elsewhere` pointing at a vault the app has never opened.
  assert.deepEqual(resolveCliVault('two', []), { root: resolve(process.cwd(), 'two') });
  // Several, with no choice made, must ask rather than guess.
  const ambiguous = resolveCliVault(null, two);
  assert.ok('error' in ambiguous && /--vault/.test(ambiguous.error));
  // None at all says how to get one.
  const none = resolveCliVault(null, []);
  assert.ok('error' in none && /no vault/.test(none.error));
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
  // `project` is built-in, so the seed must *not* declare it — a declaration
  // would be inert, which is why the name is reserved.
  assert.equal(facets.project, undefined, 'project is built-in, not seeded');
  // Reference facets declare no values, and every relation is one.
  for (const name of ['parent', 'blocked_by']) {
    assert.equal(facets[name]!.type, 'ref', `${name} should be a reference facet`);
    assert.equal(facets[name]!.values, undefined, `${name} should declare no values`);
  }
  for (const view of SEED_VIEWS) {
    const y = parse(view.body) as Record<string, unknown>;
    assert.ok(y.shape, `${view.path} states its shape`);
    assert.ok(y.title, `${view.path} has a title`);
  }
  // The set itself, by name. MANUAL.md counts these in prose, and a count that
  // moves by deciding rather than by working is one a test should hold instead
  // of a reader.
  assert.deepEqual(
    SEED_VIEWS.map((v) => v.path).sort(),
    ['due.yaml', 'everything.yaml', 'home.yaml', 'intake.yaml', 'projects.yaml', 'unblocked.yaml', 'week.yaml'],
  );
});

test('a new vault is seeded with a vocabulary and views, and no prose', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-seed-'));
  try {
    initVault(root, SEED_FACETS, SEED_VIEWS);
    assert.ok(existsSync(paths(root).facets));
    assert.ok(existsSync(paths(root).notes));
    assert.ok(existsSync(paths(root).views));
    // No note-conventions README. That text was a copy of the `pj-about` skill,
    // which an agent already has — and two places stating the format is one
    // place to drift out of date.
    assert.equal(existsSync(pathJoin(paths(root).notes, 'README.md')), false);
    // A seeded vault is a vault, and an empty one.
    assert.ok(looksLikeVault(root));
    assert.equal(countNotes(root), 0);
    // Everything it wrote is under one directory, so the root is still only ever
    // what you put there.
    assert.deepEqual(
      readdirSync(root).filter((f) => f !== '.gitignore'),
      ['.projector'],
      'seeding leaves nothing at the root but the ignore file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A folder of somebody's notes, opened.
 *
 * The three properties that make this *opening* rather than importing: nothing is
 * moved, every markdown file is a note including the README, and the config
 * arrives beside them rather than around them.
 */
test('opening a folder of markdown adds a .projector and touches nothing else', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-adopt-md-'));
  try {
    writeFileSync(pathJoin(root, 'README.md'), '# My notes\n', 'utf8');
    writeFileSync(pathJoin(root, 'kafka.md'), '# Kafka\n', 'utf8');
    mkdirSync(pathJoin(root, 'archive'));
    writeFileSync(pathJoin(root, 'archive', 'old.md'), '# Old\n', 'utf8');
    const before = readFileSync(pathJoin(root, 'README.md'), 'utf8');

    initVault(root, SEED_FACETS, SEED_VIEWS);

    // The vocabulary and views it needs to open onto something.
    assert.ok(existsSync(paths(root).facets), 'a folder of markdown is seeded, not left blank');
    assert.ok(existsSync(pathJoin(paths(root).views, 'home.yaml')));

    // Three notes: the README is one of them, and so is the one in a subfolder.
    assert.equal(countNotes(root), 3, 'no exempted filename, and any depth');
    assert.equal(readFileSync(pathJoin(root, 'README.md'), 'utf8'), before, 'nothing rewritten');
    assert.equal(existsSync(pathJoin(root, 'notes')), false, 'and nothing moved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- what ships

/**
 * A fresh clone opens onto something, without a committed registry.
 *
 * `vaults.json` cannot be committed and be correct: its entries are absolute
 * paths, so one checked in would name the machine it came from. An absent
 * registry *means* the tutorial vault instead, resolved against `appRoot` when it
 * is read — right in every clone, and never written until you open something.
 */
test('an unconfigured install knows about the vault that ships with it', () => {
  const shipped = shippedVaults();
  // The tutorial, and only the tutorial. `vaults/coverage` ships too, but it is a
  // fixture for whoever is looking at the app — not the thing a stranger opens.
  assert.equal(shipped.length, 1, 'exactly one, and it is in the repository');
  assert.equal(basename(shipped[0]!.path), 'tutorial');
  assert.equal(shipped[0]!.name, 'tutorial');
  assert.ok(isConfigured(shipped[0]!.path), 'and it is a vault, not an empty folder');

  // `PROJECTOR_VAULTS` opts out: pointing the registry elsewhere says the list is
  // mine, and a test asserting "no vaults yet" should not have to know what the
  // repository ships with.
  process.env.PROJECTOR_VAULTS = '/nonexistent/vaults.json';
  try {
    assert.deepEqual(shippedVaults(), []);
  } finally {
    delete process.env.PROJECTOR_VAULTS;
  }
});

test('the tutorial vault is a working vault, not a folder of samples', () => {
  const root = shippedVaults()[0]!.path;
  const { notes, unreadable, duplicates } = readAll(paths(root).notes);
  assert.deepEqual(unreadable, [], 'every file in it parses');
  assert.deepEqual(duplicates, [], 'and no two notes claim one id');
  assert.ok(notes.size >= 8, 'enough of a tour to be worth opening');

  // The two things the layout claims, asserted against the vault a stranger sees
  // first: a note with no frontmatter at all, and a README that is a note.
  const bare = [...notes.values()].filter((r) => !r.body.startsWith('---'));
  assert.ok(
    bare.some((r) => r.id === 'getting-started'),
    'it demonstrates a note that says nothing about itself',
  );
  assert.ok(
    [...notes.values()].some((r) => basename(r.file) === 'README.md'),
    'and a README that is a note like any other file',
  );

  /*
   * And it models nothing `pj check` objects to.
   *
   * The tutorial is the vault a stranger opens before reading anything, so every
   * shape in it is a recommendation whether or not it was meant as one. It taught
   * one it should not have: two notes named `personal-site` in both `parent` and
   * `project`, which is one edge stored twice — while the project note's own prose,
   * three lines away, described the shape that avoids it. Nothing caught that,
   * because the validator had nothing to say about relations until it did.
   *
   * Zero warnings and not just zero errors, deliberately: a warning is the
   * validator's word for "valid, and probably not what you meant", which is
   * exactly the register a tutorial must not be in. `vaults/coverage` is held to
   * the opposite standard on purpose — it carries a dangling doc link and repo
   * paths that do not resolve, because those are states the app has to draw.
   */
  const facets = loadFacets(paths(root).facets);
  const issues = validate(notes, facets, root, { unreadable, duplicates });
  assert.deepEqual(
    issues.map((i) => `${basename(i.file)} [${i.field}]: ${i.message}`),
    [],
    'the vault a stranger sees first should model nothing the validator warns about',
  );
});

/**
 * The coverage vault's dates are committed but derived, and this is what keeps
 * `bun run redate` able to reach them.
 *
 * Every date in it names the band it demonstrates in a comment beside it, which
 * is how the re-dater knows where to put it back without a table of note ids. A
 * date written without that comment is invisible to the re-dater: it will sit
 * there going stale while everything around it moves, and the column it was
 * meant to fill quietly empties. That is the failure the fixture exists to
 * prevent, reappearing inside the fixture itself.
 *
 * Deliberately date-independent. Asserting that the buckets are *currently*
 * populated would make the suite fail with the calendar rather than with a
 * defect; running the re-dater is what makes that true, and it says so itself.
 */
test('every date in the coverage vault says which band it is demonstrating', () => {
  const root = 'vaults/coverage';
  const DUE = ['overdue', 'today', 'week', 'later'];
  const WHEN = ['fresh', 'week', 'month', 'older'];
  const claimed = new Set<string>();

  for (const file of listNoteFiles(paths(root).notes)) {
    const { yaml } = split(readFileSync(file, 'utf8'));
    for (const line of (yaml ?? '').split('\n')) {
      const m = /^(\s*)(due|created|updated):\s*\[?"?\d{4}-\d{2}-\d{2}/.exec(line);
      if (!m) continue;
      const band = /#\s*(\w+)\s*$/.exec(line)?.[1];
      assert.ok(band, `${basename(file)}: "${line.trim()}" has no band comment — redate cannot move it`);
      const legal = m[2] === 'due' ? DUE : WHEN;
      assert.ok(legal.includes(band!), `${basename(file)}: "${band}" is not a ${m[2]} band`);
      claimed.add(`${m[2] === 'due' ? 'due' : 'when'}:${band}`);
    }
  }

  // And every band still has a note, so none of them can be quietly dropped.
  for (const b of DUE) assert.ok(claimed.has(`due:${b}`), `no note demonstrates due ${b}`);
  for (const b of WHEN) assert.ok(claimed.has(`when:${b}`), `no note demonstrates staleness ${b}`);
});

/**
 * The bands the re-dater knows are the buckets the vault declares.
 *
 * Two files decide what `due` means — `facets.yaml` names the buckets, and
 * `redate.mjs` picks a date inside each. Add a bucket to one and not the other
 * and the fixture stops covering a column without anything failing.
 */
test('the coverage vault declares exactly the due buckets the re-dater fills', () => {
  // Asked through `orderValues`, which is what the board asks — so this is the
  // column order a person sees, not a re-reading of the file.
  assert.deepEqual(orderValues(loadFacets(paths('vaults/coverage').facets).due, []), [
    'overdue',
    'today',
    'week',
    'later',
  ]);
});

test('the seeded vocabulary covers every facet the seeded views use', () => {
  const facets = parse(SEED_FACETS) as Record<string, unknown>;
  const computed = new Set(['type', 'blocked', 'triage', 'due', 'staleness']);
  // A built-in is in every vault's vocabulary without the file saying so, which
  // is the whole point of it being built in. `intake` is the first one a seeded
  // view filters on; `project` had only ever appeared in a `show` list, which
  // this loop does not read.
  const builtin = new Set(Object.keys(BUILTIN_FACETS));
  for (const view of SEED_VIEWS) {
    const y = parse(view.body) as { filter?: Record<string, unknown>; groupBy?: string[]; chips?: string[] };
    for (const name of [...Object.keys(y.filter ?? {}), ...(y.groupBy ?? []), ...(y.chips ?? [])]) {
      assert.ok(
        name in facets || computed.has(name) || builtin.has(name),
        `${view.path} uses unknown facet "${name}"`,
      );
    }
  }
});



test('seeding a fresh vault is not the same act as adopting one', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-adopt-'));
  try {
    // Fresh: the starter vocabulary and views go in.
    initVault(root, SEED_FACETS, SEED_VIEWS);
    assert.ok(existsSync(paths(root).facets));
    assert.ok(existsSync(pathJoin(paths(root).views, 'home.yaml')));

    // Now the vault decides it wants neither. Both absences are meaningful: no
    // vocabulary is a vault carrying the built-ins alone, and a deleted view is
    // a view somebody deleted.
    rmSync(paths(root).facets);
    rmSync(pathJoin(paths(root).views, 'home.yaml'));

    // Re-running `--create` over it must not put them back. It used to, because
    // "the file is missing" and "this vault is new" were the same test while a
    // vault could not do without them.
    initVault(root, SEED_FACETS, SEED_VIEWS);
    assert.equal(existsSync(paths(root).facets), false, 'no vocabulary was re-seeded');
    assert.equal(existsSync(pathJoin(paths(root).views, 'home.yaml')), false, 'and no view');

    // And the folder is still a working vault: `notes/` is what says so.
    assert.ok(looksLikeVault(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a folder with somebody else\'s files is refused, not adopted', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-notavault-'));
  try {
    writeFileSync(pathJoin(root, 'thesis.docx'), 'not a vault', 'utf8');
    assert.throws(() => initVault(root, SEED_FACETS, SEED_VIEWS), /not empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an existing .gitignore is appended to, not skipped and not clobbered', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-ignore-'));
  try {
    // A vault that is already a git repository — which is every adopted one, and
    // the case that used to get nothing at all, because the file existed.
    writeFileSync(pathJoin(root, '.gitignore'), '__pycache__/\n*.pyc\n', 'utf8');
    writeFileSync(pathJoin(root, 'a-note.md'), '# A note\n', 'utf8');
    initVault(root, SEED_FACETS, SEED_VIEWS);

    const out = readFileSync(pathJoin(root, '.gitignore'), 'utf8');
    assert.match(out, /^__pycache__\/\n\*\.pyc\n/, 'what was there is still there, first');
    for (const line of ['.projector/*.db*', '*.tmp-*', '.DS_Store']) {
      assert.ok(out.includes(line), `${line} was added`);
    }

    // Idempotent: adopting twice does not stack a second copy.
    initVault(root, SEED_FACETS, SEED_VIEWS);
    assert.equal(
      readFileSync(pathJoin(root, '.gitignore'), 'utf8'),
      out,
      'a second adoption changes nothing',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a vault that already ignores one of the lines gets only the rest', () => {
  const root = mkdtempSync(pathJoin(tmpdir(), 'pj-ignore-'));
  try {
    writeFileSync(pathJoin(root, '.gitignore'), '.DS_Store\n', 'utf8');
    writeFileSync(pathJoin(root, 'a-note.md'), '# A note\n', 'utf8');
    initVault(root, SEED_FACETS, SEED_VIEWS);
    const out = readFileSync(pathJoin(root, '.gitignore'), 'utf8');
    assert.equal(out.match(/\.DS_Store/g)?.length, 1, 'not repeated');
    assert.ok(out.includes('.projector/*.db*'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
