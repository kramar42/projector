import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { readAll } from '../src/index/indexer.ts';
import { place } from './fixture.ts';

/**
 * The CLI, run as a binary.
 *
 * 845 lines and no test until now, and the three bugs it shipped were each in a
 * layer a unit test does not reach: `reindex` interpolated `counts()` keys that a
 * rename had removed and printed `undefined` three times (a *render* bug);
 * `ls`, `vaults` and `enrich` called the flag parser without a known-list, so a
 * typo was dropped in silence (a *wiring* bug); and `--help` resolved a vault
 * before printing, so it died in the one case it exists for (a *dispatch* bug).
 *
 * Unit-testing `argFlags` would have caught none of the three. Spawning does,
 * because argv and stdout *are* this module's interface. It costs ~140 ms a call,
 * which is the price of testing the thing rather than a part of it.
 */

const CLI = new URL('../src/cli/pj.ts', import.meta.url).pathname;

interface Run {
  out: string;
  code: number;
}

function vault(): { root: string; registry: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pj-cli-'));
  mkdirSync(paths(root).config, { recursive: true });
  writeFileSync(
    paths(root).facets,
    'status: { label: Status, values: [planning, active, done], open: false, single: true }\n' +
      'priority: { label: Priority, values: [now, later], open: false, single: true }\n' +
      'parent: { label: Part of, type: ref, single: true }\n',
    'utf8',
  );
  const card = (id: string, body: string) =>
    writeFileSync(place(root, `${id}.md`), body, 'utf8');
  card('alpha', '---\nid: alpha\ntitle: Alpha\nfacets: { status: [planning], priority: [now] }\n---\nfirst\n');
  card('beta', '---\nid: beta\ntitle: Beta\nfacets: { status: [active] }\n---\nsecond\n');
  // The registry is redirected so `pj vaults` cannot touch the real one.
  const registry = join(root, 'registry.json');
  return { root, registry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * The CLI reads its vault from the environment, so the suite has to start from a
 * known-empty one. Inheriting `process.env` wholesale meant a `PROJECTOR_DATA`
 * exported in the shell that ran the tests preempted the vault each test builds,
 * and the three tests about *resolving* a vault failed for a reason no assertion
 * mentioned. Every seam the CLI honours is dropped here; the test names what it
 * wants.
 */
const SEAMS = ['PROJECTOR_DATA', 'PROJECTOR_VAULTS', 'PROJECTOR_WORKSPACES'];

function run(args: string[], env: Record<string, string> = {}): Run {
  const clean = { ...process.env };
  for (const key of SEAMS) delete clean[key];
  try {
    // `process.execPath`, not 'node': this spawns the CLI under whichever runtime
    // is running the suite, so `bun test` exercises the CLI on Bun rather than
    // quietly shelling out to a Node that a Bun-only machine may not even have.
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...clean, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}

// ---------------------------------------------------------------- rendering

/**
 * `pj reindex` named `counts()`'s keys, and P7 renamed three of them. It printed
 * `undefined card(s), undefined node(s) … undefined edge(s)` for four commits,
 * because no caller and no test ever looked.
 */
test('reindex reports real numbers, never the word undefined', () => {
  const v = vault();
  try {
    const r = run(['--vault', v.root, 'reindex']);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.out, /undefined/, r.out);
    assert.match(r.out, /indexed 2 note\(s\)/);
    // Every line after the first is a name and a number.
    for (const line of r.out.trim().split('\n').slice(1)) {
      assert.match(line, /^\s{2}\S+\s+\d+$/, `"${line}" should be a label and a count`);
    }
  } finally {
    v.cleanup();
  }
});

test('ls prints what it found, and --json is the payload the app receives', () => {
  const v = vault();
  try {
    const plain = run(['--vault', v.root, 'ls']);
    assert.match(plain.out, /2 note\(s\) of 2/);
    assert.match(plain.out, /alpha/);

    const json = JSON.parse(run(['--vault', v.root, 'ls', '--json']).out);
    assert.deepEqual(json.ids.sort(), ['alpha', 'beta']);
    assert.equal(json.notes.alpha.title, 'Alpha');
    // The keys the web client depends on.
    for (const key of ['spec', 'savedSpec', 'notes', 'ids', 'groups', 'counts', 'total', 'rollups']) {
      assert.ok(key in json, `--json must carry ${key}`);
    }
  } finally {
    v.cleanup();
  }
});

test('grouping prints one section per declared value, empty ones included', () => {
  const v = vault();
  try {
    const r = run(['--vault', v.root, 'ls', '--group', 'priority']);
    assert.match(r.out, /## now \(1\)/);
    // `later` is declared and carried by nobody; it is still a group.
    assert.match(r.out, /## later \(0\)/);
    assert.match(r.out, /in \d+ group\(s\)/);
  } finally {
    v.cleanup();
  }
});

test('mv renames an id and repoints references', () => {
  const v = vault();
  try {
    writeFileSync(
      place(v.root, 'beta.md'),
      '---\nid: beta\ntitle: Beta\nfacets: { parent: [alpha] }\n---\nsecond\n',
      'utf8',
    );
    const r = run(['--vault', v.root, 'mv', 'alpha', 'gamma']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /renamed alpha to gamma/);
    assert.ok(readAll(paths(v.root).notes).notes.has('gamma'));
    assert.deepEqual(readAll(paths(v.root).notes).notes.get('beta')?.facets.parent, ['gamma']);
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- wiring

/**
 * A mistyped flag used to be dropped in silence, so `pj ls --grup priority`
 * reported success and returned an ungrouped list. Every command refuses one now,
 * and a command that takes none says so.
 */
test('every command refuses a flag it does not know', () => {
  const v = vault();
  try {
    const commands = [
      ['ls'], ['log'], ['add', 'x'], ['link', 'alpha', 'jira:A-1'], ['check'], ['reindex'],
      ['search', 'x'], ['vaults'], ['enrich', 'jira:A-1'], ['intake'], ['context', 'alpha'],
      ['set', 'alpha'], ['rm', 'alpha'], ['work', 'alpha'], ['did'], ['mcp'],
      ['accept', 'alpha'], ['decline', 'alpha', '--reason', 'x'],
    ];
    for (const cmd of commands) {
      const r = run(['--vault', v.root, ...cmd, '--nonsense'], { PROJECTOR_VAULTS: v.registry });
      assert.match(r.out, /unknown flag --nonsense/, `pj ${cmd[0]} accepted it: ${r.out.slice(0, 120)}`);
      assert.equal(r.code, 1, `pj ${cmd[0]} should exit 1`);
    }
  } finally {
    v.cleanup();
  }
});

/**
 * The command's printed spelling is its interface. Prefixes and short aliases
 * used to be convenient until the root help had to teach punctuation instead of
 * the workflow; exact long flags make both scripts and help unsurprising.
 */
test('flags use their exact long spelling', () => {
  const v = vault();
  try {
    assert.match(run(['--vault', v.root, 'ls', '--group', 'priority']).out, /## now \(1\)/);
    assert.deepEqual(JSON.parse(run(['--vault', v.root, 'ls', '--json']).out).ids.sort(), ['alpha', 'beta']);

    for (const spelling of ['-v', '-g', '-j', '-h']) {
      const r = run(['--vault', v.root, 'ls', spelling]);
      assert.equal(r.code, 1, `${spelling} should fail`);
      assert.match(r.out, /short flags are not supported/, r.out);
    }
    const prefix = run(['--vault', v.root, 'ls', '--gro', 'priority']);
    assert.equal(prefix.code, 1);
    assert.match(prefix.out, /unknown flag --gro/, prefix.out);
  } finally {
    v.cleanup();
  }
});

test('a boolean flag does not swallow the argument after it', () => {
  const v = vault();
  try {
    // `--remove` is boolean: the ref must stay a positional, not become its value.
    run(['--vault', v.root, 'link', 'alpha', 'jira:A-1']);
    const r = run(['--vault', v.root, 'link', 'alpha', '--remove', 'jira:A-1']);
    assert.match(r.out, /removed 1/, r.out);
    assert.equal(r.code, 0);
  } finally {
    v.cleanup();
  }
});

test('canonical intake verbs reach the existing intake operations', () => {
  const v = vault();
  try {
    const base = ['--vault', v.root, 'intake'];
    const declined = run([...base, 'declined']);
    assert.equal(declined.code, 0, declined.out);
    assert.match(declined.out, /nothing declined/);

    // Saying no is one verb now, at the top level; the intake spelling is gone.
    const decline = run(['--vault', v.root, 'decline', 'git:example', '--reason', 'not work']);
    assert.equal(decline.code, 0, decline.out);
    assert.match(decline.out, /declined git:example — not work/);
    assert.equal(run([...base, 'decline', 'git:other', '--reason', 'x']).code, 1, 'pj intake decline is gone');

    const listed = run([...base, 'declined']);
    assert.match(listed.out, /git:example/);

    const restored = run([...base, 'restore', 'git:example']);
    assert.equal(restored.code, 0, restored.out);
    assert.match(restored.out, /back in the next sweep/);

    const cursor = run([...base, 'cursor', 'set', '--channel', 'git', '--cursor', 'abc']);
    assert.equal(cursor.code, 0, cursor.out);
    assert.match(cursor.out, /git cursor abc/);

    const reset = run([...base, 'cursor', 'reset', '--channel', 'git']);
    assert.equal(reset.code, 0, reset.out);
    assert.match(reset.out, /forgot 1 cursor/);
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- dispatch

/**
 * Help is a read of the CLI interface, never of a vault. The root is deliberately
 * short, and each command grows its own details without requiring a configured
 * vault or an accidental command run.
 */
test('help is progressive, and prints without a vault', () => {
  const v = vault();
  try {
    // Two registered and none named: resolution is ambiguous, help must still print.
    const two = join(v.root, 'other');
    mkdirSync(paths(two).config, { recursive: true });
    writeFileSync(paths(two).facets, 'status: { values: [planning] }\n', 'utf8');
    run(['vaults', 'add', v.root], { PROJECTOR_VAULTS: v.registry });
    run(['vaults', 'add', two], { PROJECTOR_VAULTS: v.registry });

    for (const form of ['help', '--help']) {
      const r = run([form], { PROJECTOR_VAULTS: v.registry });
      assert.equal(r.code, 0, `pj ${form} should exit 0`);
      assert.match(r.out, /pj — projector CLI/);
      assert.match(r.out, /no vault chosen/, 'it says why rather than dying');
      assert.match(r.out, /Work with notes/, 'and still groups the commands');
      assert.match(r.out, /pj help intake/, 'and points to detailed help');
    }
    assert.equal(
      run(['help'], { PROJECTOR_VAULTS: v.registry }).out,
      run(['--help'], { PROJECTOR_VAULTS: v.registry }).out,
      'pj help and pj --help are the same help',
    );

    for (const form of [['help', 'intake'], ['--help', 'intake'], ['intake', '--help']]) {
      const r = run(form, { PROJECTOR_VAULTS: v.registry });
      assert.equal(r.code, 0, `pj ${form.join(' ')} should exit 0`);
      assert.match(r.out, /Usage: pj intake/);
      assert.match(r.out, /pj intake apply/);
      assert.doesNotMatch(r.out, /Work with notes/, 'intake help does not repeat the root');
    }
    const advanced = run(['help', 'intake', 'advanced'], { PROJECTOR_VAULTS: v.registry });
    assert.equal(advanced.code, 0);
    assert.match(advanced.out, /pj intake cursor set/);

    // One registered: the header names it.
    const one = join(v.root, 'solo.json');
    run(['vaults', 'add', v.root], { PROJECTOR_VAULTS: one });
    assert.match(run(['--help'], { PROJECTOR_VAULTS: one }).out, /\(vault: /);

    const short = run(['-h'], { PROJECTOR_VAULTS: one });
    assert.equal(short.code, 1);
    assert.match(short.out, /short flags are not supported/);
  } finally {
    v.cleanup();
  }
});

test('an unknown command prints help and fails; no command prints help and does not', () => {
  const v = vault();
  try {
    const env = { PROJECTOR_VAULTS: v.registry };

    // With a vault, an unknown command reaches the dispatch and falls through to
    // help — and still exits 1, because a typo is not a request for help.
    const bogus = run(['--vault', v.root, 'nonsuch'], env);
    assert.equal(bogus.code, 1);
    assert.match(bogus.out, /\n  ls\s+list notes/, 'it shows what it does understand');

    // Naming nothing at all is a request for help, and exits 0.
    const bare = run(['--vault', v.root], env);
    assert.equal(bare.code, 0, 'asking for nothing is not an error');
    assert.match(bare.out, /\n  ls\s+list notes/);

    // Without a resolvable vault, a command that needs one fails on that first —
    // before dispatch, so no help is printed. That is the vault error's job.
    const noVault = run(['nonsuch'], env);
    assert.equal(noVault.code, 1);
    assert.doesNotMatch(noVault.out, /\n  ls\s+list notes/, 'the vault error stands alone');
  } finally {
    v.cleanup();
  }
});

test('a deleted command stays deleted', () => {
  const v = vault();
  try {
    for (const gone of ['next', 'untriaged', 'stats', 'show', 'project', 'unlink', 'link-session']) {
      const r = run(['--vault', v.root, gone, 'alpha']);
      assert.equal(r.code, 1, `pj ${gone} should be gone`);
    }
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- the registry

/** Only possible because `PROJECTOR_VAULTS` exists; without it this edits the real list. */
test('vaults add and forget round-trip through the registry', () => {
  const v = vault();
  try {
    const env = { PROJECTOR_VAULTS: v.registry };
    assert.match(run(['vaults'], env).out, /no vaults yet/);

    run(['vaults', 'add', v.root, '--name', 'scratch'], env);
    const listed = run(['vaults'], env);
    assert.match(listed.out, /scratch/);
    assert.match(listed.out, /2 note\(s\)/);

    assert.match(run(['vaults', 'forget', v.root], env).out, /forgot/);
    assert.match(run(['vaults'], env).out, /no vaults yet/);
    assert.match(run(['vaults', 'forget', v.root], env).out, /not tracked/);
  } finally {
    v.cleanup();
  }
});

test('a single registered vault is used without --vault', () => {
  const v = vault();
  try {
    const env = { PROJECTOR_VAULTS: v.registry };
    run(['vaults', 'add', v.root], env);
    assert.match(run(['ls'], env).out, /2 note\(s\)/, 'unambiguous means no flag needed');
  } finally {
    v.cleanup();
  }
});

/**
 * `--vault` names a vault or a path, and a vault that is not there is an error.
 *
 * Both halves of one bug. The flag was a path only, so naming a vault the way the
 * registry names it resolved against the working directory instead, where no such
 * folder was — and since every reader treats a missing folder as an empty one,
 * `ls` and `search` printed no matches and exited 0. The name is now the first
 * reading, and a resolved root that is not on disk is refused, so neither the
 * wrong vault nor a typo can go on looking like an empty one.
 */
test('--vault takes a registered name, and a vault that is not there is refused', () => {
  const v = vault();
  try {
    const env = { PROJECTOR_VAULTS: v.registry };
    // A name that is deliberately not a directory relative to the test's working
    // directory: reaching the notes proves the registry answered, not the path.
    run(['vaults', 'add', v.root, '--name', 'by-name-only'], env);
    assert.match(run(['--vault', 'by-name-only', 'ls'], env).out, /2 note\(s\)/);
    assert.match(run(['--vault', 'by-name-only', 'search', 'first'], env).out, /1 match\(es\)/);
    // A path still works, for a vault the app has never opened.
    assert.match(run(['--vault', v.root, 'ls'], env).out, /2 note\(s\)/);

    // A near miss is not quietly resolved to the vault it resembles, and not
    // quietly resolved to nothing either.
    const typo = run(['--vault', 'by-name-onlyy', 'ls'], env);
    assert.equal(typo.code, 1, typo.out);
    assert.match(typo.out, /no vault at/);
    assert.match(typo.out, /by-name-only/, 'the registered names are the hint');
    assert.doesNotMatch(typo.out, /note\(s\)/, 'it must not report an empty vault');
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- writes

/**
 * Accepting a card from the shell is the board's `+`: emptying `intake` files the
 * card where a note like it lives. `editFacets` used to drop the emptied axis, so
 * `patchNote` saw a map that merely omitted it — which is deliberately not a
 * judgement — and the card stayed in `inbox/` while the command exited 0.
 */
test('set emptying intake accepts a card out of the inbox, by either spelling', () => {
  const v = vault();
  try {
    const card = (id: string) =>
      writeFileSync(place(v.root, `inbox/${id}.md`), `---\nid: ${id}\ntitle: ${id}\n---\nnew\n`, 'utf8');
    card('one');
    card('two');
    const at = (id: string) => readAll(paths(v.root).notes).notes.get(id)!.file.slice(v.root.length + 1);

    const r = run(['--vault', v.root, 'set', 'one', '--facet', 'intake=']);
    assert.equal(r.code, 0, r.out);
    assert.equal(at('one'), 'notes/one.md', '--facet intake= files the card');
    assert.equal(readAll(paths(v.root).notes).notes.get('one')!.facets.intake, undefined);

    assert.equal(run(['--vault', v.root, 'set', 'two', '--remove', 'intake=unjudged']).code, 0);
    assert.equal(at('two'), 'notes/two.md', '--remove intake=unjudged files it too');

    // An edit that does not name intake judges nothing.
    card('three');
    assert.equal(run(['--vault', v.root, 'set', 'three', '--facet', 'status=active']).code, 0);
    assert.equal(at('three'), 'inbox/three.md');
  } finally {
    v.cleanup();
  }
});

/**
 * The inbox verbs, from the shell. `accept` files a card — moving one of its own
 * to its place, folding an `extends` card into its target — and `decline` is the
 * one no: the card goes and the reason is recorded where the judge reads it.
 */
test('accept files a card and decline refuses one, with its reason in the declined pile', () => {
  const v = vault();
  try {
    const inbox = (id: string, fm: string) =>
      writeFileSync(place(v.root, `inbox/${id}.md`), `---\nid: ${id}\ntitle: ${id}\n${fm}---\nnew\n`, 'utf8');
    const at = (id: string) => readAll(paths(v.root).notes).notes.get(id)?.file.slice(v.root.length + 1);
    inbox('own', 'facets: { status: [active] }\n');
    inbox('change', 'facets: { status: [done], priority: [later], extends: [alpha] }\nsource_fingerprint: jira:A-1\n');
    inbox('noise', 'source_fingerprint: slack:C1/1\n');

    const own = run(['--vault', v.root, 'accept', 'own']);
    assert.equal(own.code, 0, own.out);
    assert.match(own.out, /accepted own → notes\/own\.md/);
    assert.equal(at('own'), 'notes/own.md');

    const fold = run(['--vault', v.root, 'accept', 'change', '--only', 'status']);
    assert.equal(fold.code, 0, fold.out);
    assert.match(fold.out, /folded change into alpha, taking status/);
    const alpha = readAll(paths(v.root).notes).notes.get('alpha')!;
    assert.deepEqual(alpha.facets.status, ['done']);
    assert.deepEqual(alpha.facets.priority, ['now'], '--only left priority alone');
    assert.ok(alpha.absorbed_fingerprints?.includes('jira:A-1'));
    assert.equal(at('change'), undefined);

    assert.equal(run(['--vault', v.root, 'decline', 'noise']).code, 1, 'a decline needs its reason');
    const no = run(['--vault', v.root, 'decline', 'noise', '--reason', 'answered in the thread']);
    assert.equal(no.code, 0, no.out);
    assert.match(no.out, /declined noise \(slack:C1\/1\) — answered in the thread/);
    assert.equal(at('noise'), undefined);
    assert.match(run(['--vault', v.root, 'intake', 'declined']).out, /noise\s.*answered in the thread/);

    const notCard = run(['--vault', v.root, 'decline', 'beta', '--reason', 'x']);
    assert.equal(notCard.code, 1);
    assert.match(notCard.out, /not a card — use pj rm to delete a note/);
    assert.equal(run(['--vault', v.root, 'accept', 'beta']).code, 1, 'nor can a note be accepted twice');
  } finally {
    v.cleanup();
  }
});

/** `--facet` named twice for one axis means both values, on `add` as on `set`. */
test('a repeated --facet accumulates on add and on set', () => {
  const v = vault();
  try {
    writeFileSync(
      paths(v.root).facets,
      'status: { label: Status, values: [planning, active, done], open: false, single: true }\n' +
        'priority: { label: Priority, values: [now, later], open: false, single: true }\n' +
        'tag: { label: Tag, open: true }\n',
      'utf8',
    );
    const added = run(['--vault', v.root, 'add', 'Both', '--id', 'both', '--facet', 'tag=a', '--facet', 'tag=b,c']);
    assert.equal(added.code, 0, added.out);
    assert.deepEqual(readAll(paths(v.root).notes).notes.get('both')!.facets.tag, ['a', 'b', 'c']);

    const set = run(['--vault', v.root, 'set', 'alpha', '--facet', 'tag=x', '--facet', 'tag=y']);
    assert.equal(set.code, 0, set.out);
    assert.deepEqual(readAll(paths(v.root).notes).notes.get('alpha')!.facets.tag, ['x', 'y']);
  } finally {
    v.cleanup();
  }
});

/**
 * `created` and `updated` are the local calendar date. They were the UTC one, so
 * at 00:10 CEST a note was stamped yesterday. The zone is picked so that local and
 * UTC dates differ whatever the hour the suite runs at: UTC+14 once UTC is past
 * noon, UTC−12 before it.
 */
test('add and mv stamp the local date, not the UTC one', () => {
  const v = vault();
  try {
    const pastNoon = new Date().getUTCHours() >= 12;
    const [TZ, offset] = pastNoon ? ['Etc/GMT-14', 14] : ['Etc/GMT+12', -12];
    const local = new Date(Date.now() + offset * 3_600_000).toISOString().slice(0, 10);
    assert.notEqual(local, new Date().toISOString().slice(0, 10), 'the zone has to straddle a date line');

    assert.equal(run(['--vault', v.root, 'add', 'Stamped', '--id', 'stamped'], { TZ }).code, 0);
    const text = readFileSync(place(v.root, 'stamped.md'), 'utf8');
    assert.match(text, new RegExp(`created: ${local}`), text);
    assert.match(text, new RegExp(`updated: ${local}`), text);

    assert.equal(run(['--vault', v.root, 'mv', 'alpha', 'gamma'], { TZ }).code, 0);
    assert.match(readFileSync(place(v.root, 'gamma.md'), 'utf8'), new RegExp(`updated: ${local}`));
  } finally {
    v.cleanup();
  }
});

// ---------------------------------------------------------------- exit codes

test('check exits 1 on an error and 0 on warnings alone', () => {
  const v = vault();
  try {
    assert.equal(run(['--vault', v.root, 'check']).code, 0, 'a sound vault passes');

    // A view naming an axis the vocabulary does not have.
    mkdirSync(paths(v.root).views, { recursive: true });
    writeFileSync(join(paths(v.root).views, 'broken.yaml'), 'shape: board\nfilter:\n  kind: [task]\n', 'utf8');
    const bad = run(['--vault', v.root, 'check']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /no facet or computed axis "kind"/);
  } finally {
    v.cleanup();
  }
});

test('a command naming a note that does not exist fails rather than inventing one', () => {
  const v = vault();
  try {
    for (const cmd of [['context', 'ghost'], ['set', 'ghost', '--facet', 'status=done'], ['rm', 'ghost']]) {
      const r = run(['--vault', v.root, ...cmd]);
      assert.equal(r.code, 1, `pj ${cmd[0]} ghost should fail`);
      assert.match(r.out, /ghost/);
    }
  } finally {
    v.cleanup();
  }
});
