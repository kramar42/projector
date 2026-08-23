import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BUILTIN_FACETS, loadFacets } from '../src/schema/facets.ts';
import { SEED_FACETS, SEED_VIEWS } from '../src/server/seed.ts';
import { initVault } from '../src/vault.ts';
import { reindex } from '../src/index/indexer.ts';
import { validate } from '../src/schema/validate.ts';
import { validateViews, validateVocabulary } from '../src/view/validate.ts';
import { declaredFacets } from '../src/schema/facets.ts';
import { loadViews, viewFiles } from '../src/server/views.ts';
import { queryPayload } from '../src/view/payload.ts';
import { parseSpec } from '../src/view/spec.ts';
import { PSEUDO } from '../src/index/query.ts';
import { LINK_KINDS } from '../src/schema/links.ts';
import { channelNames } from '../src/intake/run.ts';

/**
 * The constraint the whole model rests on: **no facet is special.**
 *
 * A vault declares its own axes, so a facet named in the engine is an axis one
 * vault gets for free and every other vault cannot have. Seven of them were —
 * `parent`, `project`, `blocks`, `status`, `priority`, `waiting_on`, `due` — each
 * carrying behaviour that read as general and was not. The prose said the
 * constraint held; nothing checked it, and it did not.
 *
 * These are what check it. The first is a grep with an argument attached to
 * every exception; the second builds a vault with no vocabulary at all and asks
 * whether it still works.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(e.name)) out.push(path);
    }
  };
  walk(SRC);
  return out;
}

/** Prose is where a facet *should* be named; only code is checked. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every exception, with the reason it is one. There is no wildcard: a new
 * offender fails this test, and adding a line here is a decision somebody makes
 * on purpose rather than a check quietly getting looser.
 *
 * All three are foreign vocabularies that happen to collide. Jira has fields
 * called `status` and `priority` and a status category called `done`; React Flow
 * has a handle `type="source"`; and `pj intake status` is a subcommand.
 */
const ALLOWED: { file: string; word: string; why: string }[] = [
  { file: 'enrich/jira.ts', word: 'priority', why: "Jira's field name, in a Jira fetcher" },
  { file: 'enrich/jira.ts', word: 'done', why: "Jira's statusCategory key" },
  { file: 'intake/jira.ts', word: 'status', why: "Jira's field name, in a Jira sweep" },
  { file: 'sources/jira.ts', word: 'status', why: "Jira's field name, in a Jira client" },
  { file: 'cli/pj.ts', word: 'status', why: '`pj intake status` — a subcommand, not an axis' },
  { file: 'web/views/CanvasView.tsx', word: 'source', why: "React Flow's handle type" },
];

test('no facet a vault declares is named in the code that serves every vault', () => {
  // The seeded vocabulary is the reference: it is what ships, so it is what a
  // reader would reasonably assume the engine knows about. Built-ins are exempt
  // by definition — being known by name is what makes them built in.
  const seeded = loadFacets(seedFile());

  // The app's *own* vocabularies, which a vault's values are free to collide
  // with: a `source` facet listing `jira` and `git` is naming the link kinds and
  // intake channels this app already has, and code saying `'jira'` is talking
  // about those rather than about somebody's axis.
  const ours = new Set<string>([
    ...LINK_KINDS,
    ...channelNames(),
    ...Object.values(PSEUDO).flatMap((p) => p.values(seeded)),
  ]);

  const words = new Set<string>();
  for (const [name, def] of Object.entries(seeded)) {
    if (name in BUILTIN_FACETS) continue;
    words.add(name);
    // Values too, and this is the half that matters most: `isClosed` read
    // `'done'` rather than `status`, so a check on names alone would have called
    // that code clean.
    for (const v of def.values) if (!ours.has(v)) words.add(v);
  }
  assert.ok(words.size > 15, 'the seeded vocabulary should be worth checking against');

  // Two spellings, because the first version of this test only knew one. A
  // literal is `'parent'`; a property access is `rec.facets.parent`, which reads
  // as ordinary field access and is exactly how `parentsOf` survived a sweep
  // that had already been run by hand three times.
  const alt = [...words].join('|');
  const pattern = new RegExp(
    `['"\`](${alt})['"\`]` + `|\\bfacets\\.(${alt})\\b` + `|\\bfacets\\[['"\`](${alt})['"\`]\\]`,
    'g',
  );
  const offences: string[] = [];
  for (const file of sourceFiles()) {
    const rel = file.slice(SRC.length + 1);
    code(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(pattern)) {
          const word = (m[1] ?? m[2] ?? m[3])!;
          if (ALLOWED.some((a) => a.file === rel && a.word === word)) continue;
          offences.push(`  src/${rel}:${i + 1}  "${word}"  ${line.trim().slice(0, 80)}`);
        }
      });
  }

  assert.deepEqual(
    offences,
    [],
    'a facet named in code is an axis one vault gets and the rest cannot have.\n' +
      'Read it off the vocabulary instead — a declared property, not a name:\n' +
      offences.join('\n'),
  );
});

function seedFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), 'projector-seed-')), 'facets.yaml');
  writeFileSync(f, SEED_FACETS, 'utf8');
  return f;
}

// ---------------------------------------------------------------- the bare vault

/**
 * A vault with records and views and **no vocabulary at all**.
 *
 * The other direction of the same constraint. The grep above proves no facet is
 * named; this proves the absence of every facet is a state the app can be in —
 * which is the claim that made `project` a built-in and moved triage policy into
 * a view, and which was false in three places before those changes: every card
 * drew a `no project` warning, `triage` reported three gaps nothing could fill,
 * and no write of any kind was accepted.
 *
 * Built as a fixture rather than asserted piecemeal, because the failure mode is
 * a surface nobody thought to check — so the test loads it the way the app does,
 * end to end.
 */
function bareVault(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'projector-bare-'));
  initVault(root, SEED_FACETS, SEED_VIEWS);
  // Seeded, then emptied: this is the vault somebody made and then deleted the
  // vocabulary from, not one the app has never touched.
  writeFileSync(join(root, 'facets.yaml'), '# nothing declared here yet\n', 'utf8');
  // The seeded views all name axes this vault no longer has, so they go too.
  // What is left is one view naming nothing but a shape.
  for (const { file } of viewFiles(root)) rmSync(file);
  writeFileSync(
    join(root, 'views', 'home.yaml'),
    'shape: board\ntitle: Everything\nsort: [updated:desc]\n',
    'utf8',
  );

  const card = (id: string, body: string) =>
    writeFileSync(
      join(root, 'cards', `${id}.md`),
      `---\nid: ${id}\ntitle: ${id}\ncreated: 2026-08-01\nupdated: 2026-08-01\n---\n\n${body}\n`,
      'utf8',
    );
  card('plain', 'A record with no facets, which is now every record.');
  writeFileSync(
    join(root, 'cards', 'linked.md'),
    '---\nid: linked\ntitle: linked\nlinks: [jira:PROJ-1]\ncreated: 2026-08-01\nupdated: 2026-08-01\n---\n\nA link, so the `linked` axis has something.\n',
    'utf8',
  );
  writeFileSync(
    join(root, 'cards', 'owner.md'),
    '---\nid: owner\ntitle: owner\nproject: {}\ncreated: 2026-08-01\nupdated: 2026-08-01\n---\n\nA project block, which is not a facet.\n',
    'utf8',
  );

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a vault with records, views and no vocabulary is a working vault', () => {
  const { root, cleanup } = bareVault();
  try {
    const facets = loadFacets(join(root, 'facets.yaml'));
    // The built-ins, and nothing else. This is the whole vocabulary.
    assert.deepEqual(Object.keys(facets), Object.keys(BUILTIN_FACETS));

    const { db, records, unreadable, duplicates } = reindex(root);
    assert.equal(records.size, 3);

    // `pj check` is silent. It used to warn once per card about a missing
    // project, in a vault that has no notion of projects.
    const issues = [
      ...validateVocabulary(declaredFacets(join(root, 'facets.yaml')), 'facets.yaml'),
      ...validate(records, facets, root, { unreadable, duplicates }),
      ...validateViews(
        viewFiles(root).map(({ name, file }) => ({
          spec: loadViews(root).find((v) => v.name === name)!,
          file,
        })),
        facets,
      ),
    ];
    assert.deepEqual(issues, [], `a bare vault should be valid:\n${issues.map((i) => i.message).join('\n')}`);

    // And it answers a query, with the computed axes and no stored ones.
    const payload = queryPayload(
      { facets, db, records, views: loadViews(root), today: '2026-08-20' },
      parseSpec({}),
    );
    assert.equal(payload.total, 3);
    // The computed axes and no stored one. `blocked` is still offered and holds
    // one value: nothing declares blocking, so every record is `clear`. An axis
    // that cannot divide anything is arguably not worth a rail row, but that is
    // true of `type` in some vaults too and is a separate question from this one.
    assert.deepEqual(
      payload.counts.map((c) => c.facet),
      ['type', 'blocked', 'triage', 'staleness', 'linked'],
    );
    assert.deepEqual(
      payload.counts.find((c) => c.facet === 'blocked')!.values.map((v) => v.value),
      ['clear'],
    );

    // `triage` is empty rather than permanently red: no facet is expected, so no
    // card is missing one. That absence is the point of `expected:`.
    const triage = payload.counts.find((c) => c.facet === 'triage')!;
    assert.deepEqual(
      triage.values.map((v) => v.value),
      ['complete'],
      'nothing is expected, so every card is complete',
    );
  } finally {
    cleanup();
  }
});
