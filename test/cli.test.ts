import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { readAll } from '../src/index/indexer.ts';

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
    writeFileSync(join(paths(root).notes, `${id}.md`), body, 'utf8');
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
      join(paths(v.root).notes, 'beta.md'),
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
      ['set', 'alpha'], ['rm', 'alpha'], ['work', 'alpha'],
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
 * Every flag shortens to any prefix that names one of them, one dash or two. The
 * risk in that is a prefix quietly resolving to the wrong flag, so the two cases
 * asserted hardest are the ones that must not: an ambiguous prefix, and `-v`,
 * which is read before the command is and so is the vault even on a command with
 * `--view` and `--via` of its own.
 */
test('a flag shortens to any prefix that names exactly one', () => {
  const v = vault();
  try {
    // One dash or two, whole or cut short: four spellings of the same flag.
    for (const spelling of [['--vault'], ['-vault'], ['--vau'], ['-v']]) {
      const r = run([...spelling, v.root, 'ls']);
      assert.match(r.out, /2 note\(s\) of 2/, `${spelling[0]} should name the vault: ${r.out}`);
    }
    assert.match(run(['-v', v.root, 'ls', '-g', 'priority']).out, /## now \(1\)/);
    assert.deepEqual(JSON.parse(run(['-v', v.root, 'ls', '-j']).out).ids.sort(), ['alpha', 'beta']);

    // `ls` takes --shape, --show and --sort, so `-s` is none of them, and saying
    // which three it could have been is the whole point of refusing.
    const ambiguous = run(['-v', v.root, 'ls', '-s', 'title']);
    assert.equal(ambiguous.code, 1);
    for (const flag of ['--shape', '--show', '--sort']) {
      assert.match(ambiguous.out, new RegExp(flag), ambiguous.out);
    }

    // A prefix of nothing is still just an unknown flag.
    assert.match(run(['-v', v.root, 'ls', '-z']).out, /unknown flag -z/);
    // And the vault flag with no path is refused rather than eating the command.
    const bare = run(['ls', '-v']);
    assert.equal(bare.code, 1);
    assert.match(bare.out, /-v needs a path/, bare.out);
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

// ---------------------------------------------------------------- dispatch

/**
 * `--help` was missing from the set of commands that need no vault, so it
 * resolved one first — and died with "several vaults are registered" in exactly
 * the case the skills invoke it for.
 */
test('help prints without a vault, and says which one it would use', () => {
  const v = vault();
  try {
    // Two registered and none named: resolution is ambiguous, help must still print.
    const two = join(v.root, 'other');
    mkdirSync(paths(two).config, { recursive: true });
    writeFileSync(paths(two).facets, 'status: { values: [planning] }\n', 'utf8');
    run(['vaults', 'add', v.root], { PROJECTOR_VAULTS: v.registry });
    run(['vaults', 'add', two], { PROJECTOR_VAULTS: v.registry });

    for (const form of ['help', '--help', '-h']) {
      const r = run([form], { PROJECTOR_VAULTS: v.registry });
      assert.equal(r.code, 0, `pj ${form} should exit 0`);
      assert.match(r.out, /pj — projector CLI/);
      assert.match(r.out, /no vault chosen/, 'it says why rather than dying');
      assert.match(r.out, /pj ls/, 'and still lists the commands');
    }

    // One registered: the header names it.
    const one = join(v.root, 'solo.json');
    run(['vaults', 'add', v.root], { PROJECTOR_VAULTS: one });
    assert.match(run(['--help'], { PROJECTOR_VAULTS: one }).out, /\(vault: /);
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
    assert.match(bogus.out, /pj ls/, 'it shows what it does understand');

    // Naming nothing at all is a request for help, and exits 0.
    const bare = run(['--vault', v.root], env);
    assert.equal(bare.code, 0, 'asking for nothing is not an error');
    assert.match(bare.out, /pj ls/);

    // Without a resolvable vault, a command that needs one fails on that first —
    // before dispatch, so no help is printed. That is the vault error's job.
    const noVault = run(['nonsuch'], env);
    assert.equal(noVault.code, 1);
    assert.doesNotMatch(noVault.out, /pj ls/, 'the vault error stands alone');
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
    assert.match(run(['-v', 'by-name-only', 'ls'], env).out, /2 note\(s\)/);
    assert.match(run(['--vault', 'by-name-only', 'search', 'first'], env).out, /1 match\(es\)/);
    // A path still works, for a vault the app has never opened.
    assert.match(run(['-v', v.root, 'ls'], env).out, /2 note\(s\)/);

    // A near miss is not quietly resolved to the vault it resembles, and not
    // quietly resolved to nothing either.
    const typo = run(['-v', 'by-name-onlyy', 'ls'], env);
    assert.equal(typo.code, 1, typo.out);
    assert.match(typo.out, /no vault at/);
    assert.match(typo.out, /by-name-only/, 'the registered names are the hint');
    assert.doesNotMatch(typo.out, /note\(s\)/, 'it must not report an empty vault');
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
