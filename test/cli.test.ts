import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../src/config.ts';
import { settingsPath } from '../src/settings.ts';
import { readAll } from '../src/index/indexer.ts';
import { connectorAnswer, connectorEvents, place, WORK_REPO } from './fixture.ts';

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
const FAKE = new URL('./fake-kernel', import.meta.url).pathname;

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
      ['search', 'x'], ['vaults'], ['intake'], ['context', 'alpha'],
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
    // And `apply` is what a bare `pj intake` does now. Read as a channel name, it
    // is refused before anything is fetched.
    for (const gone of ['apply', 'poll']) {
      const r = run([...base, gone]);
      assert.equal(r.code, 1, `pj intake ${gone} is gone`);
      assert.match(r.out, new RegExp(`unknown channel\\(s\\): ${gone}`), r.out);
    }

    const listed = run([...base, 'declined']);
    assert.match(listed.out, /git:example/);

    // A person's decline names no connector event, so taking it back lifts it
    // and says when the item returns, rather than promising it now.
    const restored = run([...base, 'restore', 'git:example']);
    assert.equal(restored.code, 0, restored.out);
    assert.match(restored.out, /git:example — no longer declined; it returns when its source next moves/);

    // The cursor is the kernel's now: the commands that moved one are gone, and
    // read as channel names they are refused before anything is read.
    for (const gone of ['advance', 'cursor', 'reset', 'commit']) {
      const r = run([...base, gone]);
      assert.equal(r.code, 1, `pj intake ${gone} is gone`);
      assert.match(r.out, new RegExp(`unknown channel\\(s\\): ${gone}`), r.out);
    }
  } finally {
    v.cleanup();
  }
});

/**
 * `pj intake` is the pass; `--dry-run` is the preview.
 *
 * Driven against `test/fake-kernel`, answering connector events shaped like the
 * real connectors' and placed in the last hour, with judging off, so the
 * spawned CLI reads something real and spends nothing: every candidate is kept,
 * which is the write path with an empty verdict. The fake records what the pass
 * sends, and answers the next pass's cursor from it, as the kernel does.
 */
test('pj intake files into inbox/ and records it in the kernel; --dry-run files and records nothing', () => {
  const v = vault();
  const k = mkdtempSync(join(tmpdir(), 'pj-cli-kernel-'));
  try {
    writeFileSync(join(k, 'connector-events-since.json'), JSON.stringify(connectorAnswer(connectorEvents(new Date()))), 'utf8');
    writeFileSync(
      place(v.root, 'projects', 'widget', 'README.md'),
      `---\nid: widget\ntitle: Widget\nproject:\n  repos:\n    - path: ${WORK_REPO}\n---\n\nb\n`,
      'utf8',
    );
    const config = `classify:\n  enabled: false\nkernel:\n  enabled: true\n  bin: ${FAKE}\n`;
    writeFileSync(settingsPath(v.root), config, 'utf8');
    const batches = join(k, 'batches');
    const env = { PROJECTOR_VAULTS: v.registry, FAKE_KERNEL_QUERIES: k, FAKE_KERNEL_BATCHES: batches };
    const base = ['--vault', v.root, 'intake'];
    const inbox = () => (existsSync(join(v.root, 'inbox')) ? readdirSync(join(v.root, 'inbox')) : []);
    const status = () => run([...base, 'status', '--json'], env).out;

    const before = status();
    const waiting = JSON.parse(before) as { ok: boolean; channels: { channel: string; cursor: string | null; waiting: number }[] };
    assert.ok(waiting.ok);
    assert.deepEqual(waiting.channels.map((c) => [c.channel, c.cursor, c.waiting]), [
      ['claude', null, 3],
      ['git', null, 2],
      ['jira', null, 2],
      ['slack', null, 2],
      ['gmail', null, 1],
    ], 'status asks the kernel what waits behind each cursor');

    const preview = run([...base, '--dry-run'], env);
    assert.equal(preview.code, 0, preview.out);
    assert.match(preview.out, /Wire the webhook retries/, 'the preview lists the candidates');
    assert.match(preview.out, /gathered by bin\/kernel sync claude-code/);
    assert.deepEqual(inbox(), [], 'and files nothing');
    assert.equal(existsSync(batches), false, 'and records nothing in the kernel');
    assert.equal(status(), before, 'so status reads as it did');

    // The preview's own flags shape a preview; without --dry-run they are refused
    // rather than ignored.
    for (const flag of [['--since', '2026-01-01'], ['--limit', '3'], ['--json'], ['--verbose']]) {
      const r = run([...base, ...flag], env);
      assert.equal(r.code, 1, `${flag[0]} without --dry-run should fail`);
      assert.match(r.out, /--dry-run/, r.out);
    }
    assert.deepEqual(inbox(), [], 'and a refused run read nothing');

    const pass = run(base, env);
    assert.equal(pass.code, 0, pass.out);
    assert.match(pass.out, /^new\s+\S+/m, 'a pass names each card it wrote');
    assert.match(pass.out, /10 recorded in the kernel/);
    assert.equal(inbox().length, 5, 'one card per candidate, judging being off');
    const after = JSON.parse(status()) as typeof waiting;
    assert.ok(after.channels.every((c) => c.cursor && c.waiting === 0), 'every cursor moved past what it judged');

    const again = run(base, env);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /^claude +read 0, judged 0$/m);
    assert.equal(inbox().length, 5, 'running twice writes nothing twice');

    // With the kernel block off there is nothing to read, and it says so.
    writeFileSync(settingsPath(v.root), 'classify:\n  enabled: false\n', 'utf8');
    const off = run(base, env);
    assert.equal(off.code, 1);
    assert.match(off.out, /nothing read — the kernel block is off for this vault, so intake has nothing to read/);
  } finally {
    rmSync(k, { recursive: true, force: true });
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
      assert.match(r.out, /pj intake --dry-run/);
      assert.doesNotMatch(r.out, /intake apply/, '`pj intake` is the tick; there is no apply');
      assert.doesNotMatch(r.out, /pj intake advance/, 'promoting a preview is recovery, not the workflow');
      assert.doesNotMatch(r.out, /Work with notes/, 'intake help does not repeat the root');
    }
    const root = run(['help'], { PROJECTOR_VAULTS: v.registry }).out;
    assert.doesNotMatch(root, /intake apply/);
    assert.doesNotMatch(root, /^\s+(enrich|audit)\s/m, 'enrich and audit folded into context and check');
    const check = run(['help', 'check'], { PROJECTOR_VAULTS: v.registry }).out;
    assert.match(check, /expect: empty/, 'check help says it runs the rules');
    assert.match(check, /non-zero/, 'and that a broken rule fails it');
    assert.match(run(['help', 'context'], { PROJECTOR_VAULTS: v.registry }).out, /--fresh/);
    const advanced = run(['help', 'intake', 'advanced'], { PROJECTOR_VAULTS: v.registry });
    assert.equal(advanced.code, 0);
    assert.match(advanced.out, /pj intake known/);
    assert.doesNotMatch(advanced.out, /pj intake (cursor|advance)/, 'the cursor is the kernel’s');
    assert.doesNotMatch(advanced.out, /\bpoll\b/, 'apply is gone, and so is its old spelling');

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
    // `enrich` is `context --fresh` and `audit` is the second half of `check`.
    for (const gone of ['next', 'untriaged', 'stats', 'show', 'project', 'unlink', 'link-session', 'enrich', 'audit']) {
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

/**
 * `pj check` absorbed `pj audit`: validity first, then the vault's rules — every
 * view declaring `expect: empty` — each under its own heading, so a dangling
 * reference and an unprioritised note still read as different things. A broken
 * rule fails the command, as `pj audit` did: a rule is a rule.
 */
test('check runs the rules after validity, under their own heading, and a broken one fails it', () => {
  const v = vault();
  try {
    const none = run(['--vault', v.root, 'check']);
    assert.equal(none.code, 0, none.out);
    assert.match(none.out, /^Validity\n/);
    assert.match(none.out, /^Rules\n.*no rules/m, 'a vault with no rule says so rather than staying silent');

    mkdirSync(paths(v.root).views, { recursive: true });
    writeFileSync(
      join(paths(v.root).views, 'unprioritised.yaml'),
      "shape: table\ntitle: Unprioritised\nexpect: empty\nfilter: { priority: ['(none)'] }\n",
      'utf8',
    );
    const broken = run(['--vault', v.root, 'check']);
    assert.equal(broken.code, 1, 'a broken rule fails check, as it failed audit');
    assert.ok(broken.out.indexOf('Validity') < broken.out.indexOf('Rules'), 'validity first, then the rules');
    assert.match(broken.out, /0 error\(s\), 0 warning\(s\)|no problems found/, 'validity itself is clean');
    assert.match(broken.out, /BROKEN\s+unprioritised\s+1 Unprioritised/);
    assert.match(broken.out, /^\s+beta$/m, 'naming the note that breaks it');
    assert.match(broken.out, /0 of 1 rule\(s\) hold/);

    const json = JSON.parse(run(['--vault', v.root, 'check', '--json']).out);
    assert.equal(json.errors, 0);
    assert.deepEqual(json.rules, [{ name: 'unprioritised', title: 'Unprioritised', ids: ['beta'] }]);

    run(['--vault', v.root, 'set', 'beta', '--facet', 'priority=later']);
    const held = run(['--vault', v.root, 'check']);
    assert.equal(held.code, 0, held.out);
    assert.match(held.out, /ok\s+unprioritised/);
    assert.match(held.out, /1 of 1 rule\(s\) hold/);
  } finally {
    v.cleanup();
  }
});

/** `pj enrich` folded in: nobody resolves a link except to read a note. */
test('context --fresh re-resolves the note\'s links before printing them', () => {
  const v = vault();
  try {
    writeFileSync(place(v.root, 'assets/alpha/spec.md'), '# Written down\n', 'utf8');
    run(['--vault', v.root, 'link', 'alpha', 'doc:assets/alpha/spec.md']);

    const cached = JSON.parse(run(['--vault', v.root, 'context', 'alpha', '--json']).out);
    assert.equal(cached.links[0].enrichment.state, 'missing', 'a plain context never fetches');

    const before = Date.now();
    const fresh = run(['--vault', v.root, 'context', 'alpha', '--fresh', '--json']);
    assert.equal(fresh.code, 0, fresh.out);
    const link = JSON.parse(fresh.out).links[0].enrichment;
    assert.equal(link.state, 'fresh');
    assert.equal(link.data.title, 'Written down');
    assert.ok(link.fetchedAt >= before, 'fetched by this call');

    assert.match(run(['--vault', v.root, 'context', 'alpha', '--fresh']).out, /Written down/);
    const ghost = run(['--vault', v.root, 'context', 'ghost', '--fresh']);
    assert.equal(ghost.code, 1);
    assert.match(ghost.out, /no note with id "ghost"/);
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
