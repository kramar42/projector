#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { existsSync, paths, resolveCliVault } from '../config.ts';
import { formatReport, probe, writeTemplate } from '../setup.ts';
import { jiraConfig } from '../sources/jira.ts';
import { forgetVault, initVault, listVaults, normalise, registerVault } from '../vault.ts';
import { SEED_FACETS, SEED_VIEWS } from '../server/seed.ts';
import { declaredFacets, loadFacets } from '../schema/facets.ts';
import { listNoteFiles } from '../schema/note.ts';
import { formatIssues, validate } from '../schema/validate.ts';
import { validateViews, validateVocabulary } from '../view/validate.ts';
import { readAll, reindex } from '../index/indexer.ts';
import { delegatedIndex } from './delegate.ts';
import { counts, search } from '../index/queries.ts';
import { ftsPrefixQuery } from '../index/query.ts';
import { SPEC_PARAMS, parseSpec, specToParams, withSavedOnly, type ViewSpec } from '../view/spec.ts';
import { queryPayload } from '../view/payload.ts';
import { findView, loadViewFiles, loadViews } from '../server/views.ts';
import { formatHistory, history, isRepo } from '../agent/history.ts';
import { readCached, refresh } from '../server/enrich.ts';
import { noteContext, renderContext } from '../agent/context.ts';
import {
  advance,
  candidateCount,
  channelNames,
  commitWatermark,
  DEFAULT_LIMIT,
  known,
  renderAdvance,
  renderStatus,
  statusOf,
  renderSweep,
  sweep,
} from '../intake/run.ts';
import { pollOnce } from '../server/poll.ts';
import { rejudge } from '../intake/rejudge.ts';
import {
  resetWatermark,
  suppress,
  suppressions,
  unsuppress,
} from '../intake/db.ts';
import { NotWorkable, plannedBriefing, planWork, startWork } from '../agent/work.ts';
import { BRIEFING_PROMPT, shellQuote } from '../agent/worktree.ts';
import { pickSession } from '../sources/claude.ts';
import { ago } from '../sources/run.ts';
import { createNote, deleteNote, mergeNotes, patchNote, patchFields } from '../server/mutate.ts';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------- flags

/** Report and stop. A CLI that half-applies a bad batch is worse than one that refuses. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * A token is a flag when it starts with a dash and then a letter.
 *
 * Not merely "starts with a dash": `--depth -1` has to keep its value, and a lone
 * `-` is a value too. How many dashes is not part of it — see `longName`.
 */
const FLAG = /^--?[a-z]/i;

/** `--group`, `-g` and `--gro` alike, with the dashes taken off. */
const typedName = (token: string): string => token.replace(/^--?/, '');

/**
 * Which flag a token names, allowing any unambiguous shortening of it.
 *
 * Two spellings, one rule: `-x` is `--x`, and a name may be cut to any prefix
 * that matches exactly one of the flags this command takes. So `-j`, `-js` and
 * `--json` are one flag, and every flag on every command shortens — including
 * the ones nobody thought to shorten.
 *
 * The alternative was a hand-kept table of letters, and a hand-kept copy of a
 * list the code already has is what `SPEC_PARAMS` exists to stop: there were
 * three of those, the CLI's was short by two entries, and `pj ls --shape canvas`
 * simply did not exist for as long as nobody looked. A prefix needs no table and
 * cannot fall behind one.
 *
 * Adding a flag later cannot silently redirect an abbreviation that already
 * works: at worst it makes it ambiguous, which is an error naming both
 * candidates. An exact name always wins, so a flag can never be shadowed by
 * being a prefix of a longer one either.
 */
function longName(token: string, known: readonly string[]): string {
  const typed = typedName(token);
  if (known.includes(typed)) return typed;
  const hits = known.filter((k) => k.startsWith(typed));
  if (hits.length === 1) return hits[0]!;
  const spell = (names: readonly string[]) => names.map((k) => '--' + k).join(' ');
  if (hits.length > 1) fail(`${token} could be ${spell(hits)} — type more of it`);
  return fail(
    known.length
      ? `unknown flag ${token}. This command takes: ${spell(known)}`
      : `unknown flag ${token}. This command takes none.`,
  );
}

/**
 * Split flags from positional arguments.
 *
 * `known` is required, and that is the point. An unrecognised flag used to be
 * dropped silently, so `pj set x --project '{}'` printed a success line and did
 * nothing — the sort of failure you only find by checking the file afterwards.
 * The fix shipped as an *optional* parameter, so `ls`, `vaults` and `enrich`
 * never took it, and `pj ls --json` was accepted and ignored right up until
 * `--json` became real. A command taking no flags passes `[]`; nothing opts out.
 */
function argFlags(
  argv: string[],
  known: readonly string[],
  booleans: readonly string[] = [],
): { flags: Map<string, string[]>; rest: string[] } {
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (FLAG.test(a)) {
      const key = longName(a, known);
      // A boolean never consumes what follows it. Otherwise `--remove jira:FOO-1`
      // reads the ref as the flag's value and the positional list comes back
      // empty — the flag parsed, the argument vanished, and the error message is
      // about the wrong thing.
      if (booleans.includes(key)) {
        flags.set(key, [...(flags.get(key) ?? []), 'true']);
        continue;
      }
      const next = argv[i + 1];
      // `--set project=` has to reach the command as an empty string, since that
      // is how it says "delete this key" — so only another flag ends a flag.
      if (next === undefined || FLAG.test(next)) {
        flags.set(key, [...(flags.get(key) ?? []), 'true']);
      } else {
        flags.set(key, [...(flags.get(key) ?? []), next]);
        i++;
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

// ---------------------------------------------------------------- the vault

/**
 * Which vault this invocation acts on: `--vault`, then `PROJECTOR_DATA`, then the
 * single registered vault if there is exactly one. There is no built-in default
 * and no directory name assumed.
 */
/**
 * `--vault <path>` may appear anywhere, including before the command, so it is
 * read and removed from the argument list before the command is read.
 *
 * That makes it the one flag resolved without knowing the command, so it is
 * matched against itself alone: `-v` is the vault everywhere, and `ls --view` and
 * `intake --verbose` shorten to `-vie` and `-ve` instead. The value is read here
 * and handed on, rather than `resolveCliVault` scanning argv for `--vault` a
 * second time — an abbreviation would have walked straight past that scan and
 * quietly acted on a different vault than the one named.
 */
const rawArgs = process.argv.slice(2);
const vaultAt = rawArgs.findIndex((a) => FLAG.test(a) && 'vault'.startsWith(typedName(a)));
const vaultGiven = vaultAt === -1 ? null : (rawArgs[vaultAt + 1] ?? null);
if (vaultAt !== -1 && (vaultGiven === null || FLAG.test(vaultGiven))) {
  fail(`${rawArgs[vaultAt]} needs a path${vaultGiven ? `, and ${vaultGiven} is a flag` : ''}`);
}
const cliArgs = vaultAt === -1 ? rawArgs : [...rawArgs.slice(0, vaultAt), ...rawArgs.slice(vaultAt + 2)];
const [rawCmd, ...rawArgv] = cliArgs;

/**
 * A resolved vault that is not there is refused here rather than downstream.
 *
 * Every reader treats a missing folder as an empty one: `reindex` walks nothing,
 * so `search` and `ls` print zero matches and exit 0. A `--vault` naming a folder
 * that is not there was therefore indistinguishable from a vault with nothing in
 * it — the one failure a full vault and a typo report identically. Existence is
 * the only test applied: an empty folder is a legitimate target for a first note,
 * so the guard catches the mistake without inventing a rule about what a vault
 * must already contain.
 */
function vaultOrExit(): string {
  const registered = listVaults().filter((v) => v.exists);
  const res = resolveCliVault(vaultGiven, registered);
  if ('error' in res) {
    console.error(res.error);
    process.exit(1);
  }
  if (!existsSync(res.root)) {
    const named = registered.map((v) => v.name);
    console.error(
      `no vault at ${res.root}` +
        (vaultGiven && vaultGiven !== res.root ? ` — ${vaultGiven} is not a registered name` : '') +
        (named.length ? `.\nRegistered: ${named.join(', ')}` : '.'),
    );
    process.exit(1);
  }
  return res.root;
}

/**
 * `pj vaults` manages the registry, so requiring a vault first is circular.
 */
const NO_VAULT_NEEDED = new Set(['vaults', '']);
/**
 * Help resolves a vault but never dies for want of one.
 *
 * `--help` was missing from the set above, so it resolved *and exited 1* — and
 * the one thing the skills invoke it for is finding out which vault an
 * invocation would act on, which is precisely the ambiguous case that exits.
 * Naming the vault is the useful half, so the header still does it when the
 * answer is unambiguous and says why when it is not.
 */
const HELP_CMDS = new Set(['help', '--help', '-h']);
const asking = HELP_CMDS.has(rawCmd ?? '');
const soft = asking ? resolveCliVault(vaultGiven, listVaults().filter((v) => v.exists)) : null;
const root = asking
  ? soft && 'root' in soft
    ? soft.root
    : ''
  : NO_VAULT_NEEDED.has(rawCmd ?? '')
    ? ''
    : vaultOrExit();
const p = paths(root || '/nonexistent');

const vaultNote = root
  ? `  (vault: ${root})`
  : soft && 'error' in soft
    ? `  (no vault chosen: ${soft.error.split('\n')[0]!.replace(/:$/, '')})`
    : '';

const HELP = `pj — projector CLI${vaultNote}

  pj ls [--view <name>] [--group <facet>[,<facet>]] [--filter f=v,v]
     [--sort key:dir] [--q text] [--focus <id> --via <reference facet>
     --dir out|in|both --depth n] [--shape s]
     [--show f,f]
     [--json]                                      list notes, grouped
  pj log [--since "1 week ago"]                        what changed, from git history
  pj add <title> [--id slug] [--facet f=v ...]
         [--link ref ...] [--fingerprint fp]
         [--body text]                                 create a note
  pj link <id> <ref> [...] [--remove]
         [--session [id]] [--cwd dir]                       add or remove links; --session names the
                                                       live Claude session working here
  pj check                                             validate every note file and saved view
  pj audit [--json]                                    run the views that assert expect: empty
  pj reindex                                           rebuild the index, and report what it holds
  pj search <query>                                    full-text search, most relevant first
  pj enrich [<ref>...] [--all] [--force]               resolve link enrichment and print it

  pj intake [<channel>...] [--since iso] [--limit n]
     [--json] [--verbose]                              what has happened elsewhere, since last time
  pj intake status [--json]                            per channel: cursor, last run, counts
  pj intake commit --advance [--channel c]
     [--captured n]                                    move the cursor(s) the last sweep proposed
  pj intake commit --channel c --cursor v
     [--seen n] [--captured n]                         or say where by hand
  pj intake known <fingerprint>...                     which notes already carry these refs
  pj intake poll                                       sweep, judge, and write what deserves a note
  pj intake rejudge [--limit n]                        run the pass again over what is still unjudged
  pj intake suppress <fp>... --reason <why>             record a "not a note", so sweeps stop offering it
  pj intake suppressed [--channel c] [--q text] [--limit n] [--json]
                                                       what a judgement hid, and why
  pj intake unsuppress <fp>...                         offer it again
  pj intake reset [--channel c]                        forget a cursor, back to the default window

  pj context <id> [--json]                             everything known about a note, assembled
  pj set <id>... [--title t] [--facet f=v] [--add f=v]
         [--remove f=v] [--set path=yaml ...]          scripted edits, for skills
  pj merge <id>... --into <id>                         fold notes into one, keeping its facets
  pj rm <id>...                                        delete, dropping references to it
  pj work <id> [--dry-run] [--no-open] [--new]         multi-repo worktree workspace + briefing;
                                                       reopens a session already working there

  pj setup [--json]                                    what this vault can reach, and what is missing
  pj setup --init                                      write .projector/config.yaml and gitignore it

  pj vaults                                            list known vaults
  pj vaults add <path> [--name n] [--create]           open a folder as a vault
  pj vaults forget <path>                              stop tracking it (folder untouched)

  --vault <path>                                       act on a specific vault

Every flag shortens. One dash or two, cut to any prefix that names one flag of
the command: -j is --json, -g is --group, -fi and -fo separate --filter from
--focus, and an ambiguous one says which flags it could have meant. -v is
--vault everywhere, since that one is read before the command is — so --view
is -vie and --verbose is -ve.
`;

function ensureData(): void {
  mkdirSync(p.notes, { recursive: true });
  mkdirSync(p.assets, { recursive: true });
  mkdirSync(p.views, { recursive: true });
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ---------------------------------------------------------------- commands

/**
 * `pj ls` runs the same compiler the sidebar does, and returns the same payload.
 *
 * The CLI has had `--filter f=v,v --group <facet>` since P0 — the web app is what
 * caught up. Sharing the compiler is what keeps them from drifting: a saved view
 * is a name both a human and an agent can say, and it means the same thing to
 * both.
 *
 * `--json` closes the other half. Without it this command could only *print*, so
 * every question an agent needed as data grew a verb of its own — `next`,
 * `untriaged`, `search` — and each new verb was a second implementation to drift.
 * Two of those are saved views now, which is what they always were.
 *
 * No `--limit`: at 191 notes nothing needs truncating, and a cap that has no
 * users is a cap whose interaction with grouping nobody is checking.
 */
/**
 * The index a read command works from: a live server's word when one is
 * watching this vault (see cli/delegate.ts), the exact local walk otherwise.
 */
async function currentIndex() {
  return (await delegatedIndex(root)) ?? reindex(root);
}

async function cmdLs(argv: string[]): Promise<void> {
  const { flags } = argFlags(argv, [
    ...SPEC_PARAMS, 'filter', 'json',
  ], ['json']);
  const facets = loadFacets(p.facets);
  const { db, notes } = await currentIndex();

  const params: Record<string, string> = {};
  const named = flags.get('view')?.[0];
  let saved: ViewSpec | null = null;
  if (named) {
    saved = findView(root, named) ?? null;
    if (!saved) {
      console.error(`no view "${named}"`);
      process.exit(1);
    }
    Object.assign(params, specToParams(saved));
  }
  for (const spec of flags.get('filter') ?? []) {
    const [facet, values] = spec.split('=');
    if (facet && values !== undefined) params[`f.${facet}`] = values;
  }
  // Every spec parameter, from the one list that says what a spec is made of —
  // which is how `--shape` and `--show` arrive: they were
  // missing from a hand-kept copy, so the CLI could not ask for a canvas.
  for (const key of SPEC_PARAMS) {
    if (key === 'view') continue;
    const v = flags.get(key)?.[0];
    if (v && v !== 'true') params[key] = v;
  }

  // The saved view's file-only halves — its composition and its curated order —
  // which the query round-trip does not carry. See `withSavedOnly`.
  const spec = withSavedOnly(parseSpec(params), saved);
  spec.name = named;

  // The same assembly the web app receives, from the same module (C9). A second
  // shape for the CLI is how the two surfaces would start disagreeing about the
  // answer, having been made unable to disagree about the question.
  const payload = queryPayload(
    { facets, db, notes, views: loadViews(root), jiraBase: jiraConfig(root)?.url ?? null },
    spec,
    saved,
  );

  if (flags.has('json')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const title = (id: string) => payload.notes[id]?.title ?? '';
  const mark = (id: string) => {
    const note = payload.notes[id];
    // A container is a note something points at, not a kind it declares.
    return note?.isProject ? 'P' : (note?.refCount ?? 0) > 0 ? '+' : ' ';
  };
  const line = (id: string) => `   ${mark(id)} ${pad(id, 32)} ${title(id)}`;

  if (!payload.groups) {
    for (const id of payload.ids) console.log(`${pad(id, 34)} ${title(id)}`);
    console.log(`\n${payload.total} note(s) of ${payload.universe}`);
    return;
  }

  const axes = spec.query.groupBy ?? [];
  // A composition has columns without an axis, so it says what it is instead of
  // naming the grouping it does not have.
  console.log(
    spec.lists?.length
      ? `# ${spec.lists.length} list(s)\n`
      : `# grouped by ${axes.join(' \u00d7 ')}\n`,
  );
  for (const g of payload.groups) {
    console.log(`## ${g.lane ? `${g.lane} / ` : ''}${g.value} (${g.ids.length})`);
    for (const id of g.ids) console.log(line(id));
    console.log('');
  }
  const extra = payload.placements - payload.total;
  console.log(
    `${payload.total} note(s) of ${payload.universe} in ${payload.groups.length} group(s)` +
      (extra > 0 ? ` — ${extra} appear in more than one group` : ''),
  );
}

function cmdAdd(argv: string[]): void {
  const { flags, rest } = argFlags(argv, ['id', 'facet', 'link', 'body', 'fingerprint']);
  const title = rest.join(' ').trim();
  if (!title) {
    console.error('pj add <title>');
    process.exit(1);
  }
  ensureData();
  const facets: Record<string, string[]> = {};
  for (const spec of flags.get('facet') ?? []) {
    const [f, v] = spec.split('=');
    if (f && v) facets[f] = v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const fingerprint = flags.get('fingerprint')?.[0];
  const res = createNote(root, {
    title,
    id: flags.get('id')?.[0],
    facets,
    links: flags.get('link') ?? [],
    body: flags.get('body')?.[0],
    fingerprint,
  });
  if (res.existed) {
    // A sweep run twice converges instead of refilling the inbox.
    console.log(`skipped — fingerprint already on ${res.id}`);
    return;
  }
  // Notes land at the vault root (`paths().notes` is the root); the `cards/`
  // prefix this used to print was a directory that never existed.
  console.log(`created ${res.id}.md (id: ${res.id})`);
}

/**
 * The one place a note's `links` array is written.
 *
 * Three commands used to do this. `unlink` was `link`'s inverse with the same
 * body, and `link-session` differed only in where the ref came from — the cwd
 * rather than the argument list — which makes `--session` a way of *naming* a
 * ref, not a separate operation.
 *
 * It writes through `patchNote`, which is the other half of collapsing them.
 * `link` and `unlink` wrote frontmatter directly and so never bumped `updated`,
 * while `link-session` went through the gate and did: attaching a Jira issue left
 * a note reading as untouched since 2020, and README is explicit that `updated`
 * "only ever says that *something* changed". One write path, one answer.
 *
 * A ref that is not there is an error rather than a no-op on `--remove`:
 * `pj link x --remove jira:FOO-1` reporting success while doing nothing is how
 * you find out a month later that the link is still on the other note.
 *
 * Which session `--session` means is answered in three tiers, most reliable
 * first: the process tree (the session that ran this command, which is almost
 * always the answer and cannot be ambiguous), then the working directory, then an
 * id you name. The middle tier refuses rather than guesses — two sessions in one
 * directory used to resolve to whichever started last, silently, and a link on
 * the wrong note looks exactly like a link on the right one.
 */
function cmdLink(argv: string[]): void {
  const { flags, rest } = argFlags(argv, ['remove', 'session', 'cwd', 'fingerprint'], ['remove']);
  const [id, ...given] = rest;
  if (!id) fail('pj link <id> <ref>... [--fingerprint fp] [--remove] [--session [id]] [--cwd dir]');

  const refs = [...given];
  if (flags.has('session')) {
    // `--session` alone asks; `--session <id>` names one. `--cwd` searches a
    // directory instead of the process tree.
    const named = flags.get('session')?.[0];
    const cwd = flags.get('cwd')?.[0];
    const pick = pickSession({
      ...(named && named !== 'true' ? { id: named } : {}),
      ...(cwd && cwd !== 'true' ? { cwd } : {}),
    });
    if (!pick.found) {
      if (pick.reason === 'ambiguous') {
        fail(
          `several live sessions could be meant here — name one:\n` +
            pick.candidates
              .map((s) => `  pj link ${id} --session ${s.sessionId}   (${s.name ?? 'unnamed'}, ${s.cwd})`)
              .join('\n'),
        );
      }
      if (named && named !== 'true') fail(`no live Claude session with id "${named}"`);
      fail(
        cwd && cwd !== 'true'
          ? `no live Claude session working in ${cwd}`
          : `no live Claude session found — run this from inside one, or pass --session <id>`,
      );
    }
    refs.push(`claude:${pick.found.sessionId}`);
  }
  const prints = flags.get('fingerprint') ?? [];
  if (!refs.length && !prints.length) fail('pj link <id> <ref>... — nothing to add or remove');

  const { notes } = readAll(p.notes);
  const rec = notes.get(id);
  if (!rec) fail(`no note with id "${id}"`);
  const existing = rec.links.map((l) => l.raw);

  // A swept message that extends a note instead of becoming one has no file to
  // leave its fingerprint on, so it leaves it here. Written before the links so
  // a refused fingerprint — one another note already answers for — stops the
  // whole command rather than leaving a link behind that says the message was
  // handled when the sweep will hand it to you again tomorrow.
  if (prints.length) {
    const mode = flags.has('remove') ? 'remove' : 'add';
    try {
      patchNote(root, id, { absorb: { values: prints, mode } });
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    const verb = mode === 'remove' ? 'no longer answers for' : 'answers for';
    console.log(`${id}: ${verb} ${prints.join(', ')}`);
    if (!refs.length) return;
  }

  if (flags.has('remove')) {
    const missing = refs.filter((r) => !existing.includes(r));
    if (missing.length) {
      fail(`${id} does not link ${missing.join(', ')}.\nIt links: ${existing.join(', ') || '(nothing)'}`);
    }
    const kept = existing.filter((l) => !refs.includes(l));
    patchNote(root, id, { links: kept });
    console.log(`${id}: removed ${refs.length}, ${kept.length} link(s) left`);
    return;
  }

  const already = refs.filter((r) => existing.includes(r));
  const merged = [...existing];
  for (const r of refs) if (!merged.includes(r)) merged.push(r);
  if (merged.length === existing.length) {
    console.log(`${id} already links ${already.join(', ')}`);
    return;
  }
  patchNote(root, id, { links: merged });
  console.log(`${id}: ${merged.length} link(s)` + (already.length ? ` (${already.length} already there)` : ''));
}

function cmdCheck(): void {
  const facets = loadFacets(p.facets);
  const { notes, unreadable, duplicates } = readAll(p.notes);
  const issues = [
    // Before the notes, because a facet wearing a reserved name is a fault in
    // the vocabulary itself — every note checked against it is checked against
    // an axis that will not answer.
    ...validateVocabulary(declaredFacets(p.facets), p.facets),
    ...validate(notes, facets, root, { unreadable, duplicates }),
    // A view is checked against the same vocabulary its notes are. Until it was,
    // a filter naming a deleted facet matched nothing and reported success.
    ...validateViews(loadViewFiles(root), facets),
  ];
  console.log(formatIssues(issues, root));
  if (issues.some((i) => i.severity === 'error')) process.exit(1);
}

/**
 * Run this vault's filing rules: every saved view that declares `expect`.
 *
 * Deliberately *not* part of `pj check`. That command answers "is this vault
 * loadable and internally consistent", which has the same right answer in every
 * vault; this one answers "am I working the way I said I would", which is a
 * vault's own policy. Fused, a dangling reference and twelve untidy notes would
 * leave by the same exit code with nothing to tell them apart — and the
 * validator has already had this argument once, when the "no project" warning
 * moved out of it and into the view that asks the question.
 *
 * A rule is one view file, which is the same file the board draws as a column.
 * So there is no second place to declare one, and no rule that is checked but
 * cannot be opened and drained.
 */
async function cmdAudit(argv: string[]): Promise<void> {
  const { flags } = argFlags(argv, ['json'], ['json']);
  const facets = loadFacets(p.facets);
  const { db, notes } = await currentIndex();
  const views = loadViews(root);

  const rules = views.filter((v) => v.expect);
  const results = rules.map((v) => {
    const payload = queryPayload({ facets, db, notes, views }, v, v);
    return { name: v.name ?? '', title: v.title ?? v.name ?? '', ids: payload.ids };
  });

  if (flags.has('json')) {
    console.log(JSON.stringify({ rules: results }, null, 2));
    if (results.some((r) => r.ids.length)) process.exit(1);
    return;
  }

  if (!rules.length) {
    console.log('no rules — a view declares one with `expect: empty`');
    return;
  }

  for (const r of results) {
    const held = r.ids.length;
    console.log(`${held ? 'BROKEN ' : 'ok     '} ${pad(r.name, 24)} ${held || ''} ${r.title}`);
    // The notes themselves, because a rule that only reports a number sends you
    // to a second command to find out what it means.
    for (const id of r.ids) console.log(`           ${id}`);
  }
  const broken = results.filter((r) => r.ids.length);
  console.log(
    `\n${rules.length - broken.length} of ${rules.length} rule(s) hold`,
  );
  if (broken.length) process.exit(1);
}

/**
 * Rebuild the index, and report what it holds.
 *
 * The report iterates `counts()` rather than naming its keys. It used to name
 * them, and P7 renamed three — `cards`, `nodes` and `edges` became `containers`
 * and `relations` when relations became facets — so this printed `undefined`
 * three times for four commits. Nothing caught it: no skill calls it and no test
 * covered it, and `pj stats` survived the same commit only because it already
 * looped. That is the whole argument for one command here instead of two, and for
 * this one being the looping one.
 */
function cmdReindex(): void {
  // A command named reindex must actually reindex — never answer from the gate.
  const { db, unreadable } = reindex(root, { force: true });
  const c = counts(db, loadFacets(p.facets));
  console.log(`indexed ${c.notes} note(s)`);
  for (const [k, v] of Object.entries(c)) {
    if (k === 'notes') continue;
    console.log(`  ${pad(k, 14)} ${v}`);
  }
  console.log(`  ${pad('files', 14)} ${listNoteFiles(p.notes).length}`);
  if (unreadable.length) console.log(`${unreadable.length} file(s) could not be parsed — run pj check`);
}

/**
 * Ranked full-text search.
 *
 * `pj ls --q` answers the same "which notes match this text" and answers it the
 * same way now — same sanitiser, same notes. What it cannot do is order by
 * relevance: the comparator ranks a note by its own facet values, and a match
 * score belongs to the result set rather than to any note in it. So this stays,
 * as the ranked spelling, and pj-work resolving "which note did they mean" gets
 * the best match first rather than the most recently touched.
 *
 * It used to pass raw input straight to FTS5 — `pj search 'foo('` died with a
 * syntax error — and to truncate at `search()`'s default of 25 while printing 25
 * as the total.
 */
async function cmdSearch(argv: string[]): Promise<void> {
  const { rest } = argFlags(argv, []);
  const raw = rest.join(' ').trim();
  if (!raw) fail('pj search <query>');
  const q = ftsPrefixQuery(raw);
  if (q === null) {
    console.log(`no searchable words in "${raw}"`);
    return;
  }
  const { db } = await currentIndex();
  const rows = search(db, q);
  for (const r of rows) console.log(`${pad(r.id, 34)} ${r.title}`);
  console.log(`\n${rows.length} match(es), most relevant first`);
}

// ---------------------------------------------------------------- dispatch

const cmd = rawCmd;
const argv = rawArgv;
try {
  switch (cmd) {
    case 'ls':
      await cmdLs(argv);
      break;
    case 'log': {
      const { flags } = argFlags(argv, ['since']);
      if (!isRepo(root)) {
        console.error(
          'this vault is not a git repository — `pj log` reads the history git already keeps',
        );
        process.exit(1);
      }
      console.log(formatHistory(history(root, flags.get('since')?.[0] ?? '1 week ago')));
      break;
    }
    case 'add': {
      cmdAdd(argv);
      break;
    }
    case 'link':
      cmdLink(argv);
      break;
    case 'check':
      argFlags(argv, []);
      cmdCheck();
      break;
    case 'audit':
      await cmdAudit(argv);
      break;
    case 'reindex':
      argFlags(argv, []);
      cmdReindex();
      break;
    case 'search':
      await cmdSearch(argv);
      break;

    case 'vaults': {
      const { flags, rest } = argFlags(argv, ['name', 'create'], ['create']);
      const [sub, given] = rest;
      if (!sub || sub === 'list') {
        const vaults = listVaults();
        if (!vaults.length) {
          console.log('no vaults yet — `pj vaults add <path>`, or open one in the app');
          break;
        }
        for (const v of vaults) {
          const state = v.exists ? `${v.notes} note(s)` : 'MISSING';
          console.log(`${pad(v.name, 20)} ${pad(state, 14)} ${v.path}`);
        }
        break;
      }
      if (sub === 'add') {
        if (!given) {
          console.error('pj vaults add <path> [--name n] [--create]');
          process.exit(1);
        }
        const path = normalise(given);
        if (flags.has('create')) initVault(path, SEED_FACETS, SEED_VIEWS);
        const entry = registerVault(path, flags.get('name')?.[0]);
        console.log(`${entry.name}  ${entry.path}`);
        break;
      }
      if (sub === 'forget') {
        if (!given) {
          console.error('pj vaults forget <path>');
          process.exit(1);
        }
        console.log(forgetVault(given) ? `forgot ${normalise(given)}` : 'not tracked');
        break;
      }
      console.error(`unknown: pj vaults ${sub}`);
      process.exit(1);
    }
    case 'enrich': {
      const { flags, rest } = argFlags(argv, ['all', 'force'], ['all', 'force']);
      const { notes } = readAll(p.notes);
      const refs = rest.length
        ? rest
        : flags.has('all')
          ? [...new Set([...notes.values()].flatMap((r) => r.links.map((l) => l.raw)))]
          : [];
      if (!refs.length) {
        console.error('pj enrich <ref>... | pj enrich --all');
        process.exit(1);
      }
      // Kick off the fetches, wait for the queue to drain, then report.
      await refresh({ dataRoot: root }, refs, flags.has('force'));
      for (const item of readCached(root, refs)) {
        const d = item.data;
        const badges = (d?.badges ?? []).map((b) => b.label).join(' ');
        console.log(
          `${pad(item.state, 12)} ${pad(d?.label ?? '—', 22)} ${(d?.title ?? item.error ?? item.reason ?? '').slice(0, 62)}` +
            (badges ? `  [${badges}]` : ''),
        );
      }
      break;
    }
    /**
     * A sweep proposes; it never captures and never advances a cursor. Both are
     * separate deliberate steps — `pj add`/`pj link` for the first, `pj intake
     * commit` for the second — because a run that fetched is not a run that was
     * resolved, and an abandoned sweep must not swallow what it listed.
     */
    case 'intake': {
      const { flags, rest } = argFlags(argv, [
        'since',
        'limit',
        'json',
        'verbose',
        'channel',
        'cursor',
        'seen',
        'captured',
        'advance',
        'reason',
        'title',
        'q',
      ], ['json', 'verbose', 'advance']);
      const [sub, ...channels] = rest;

      if (sub === 'status') {
        console.log(flags.has('json') ? JSON.stringify(statusOf(root), null, 2) : renderStatus(root));
        break;
      }

      if (sub === 'commit') {
        const channel = flags.get('channel')?.[0];
        if (channel && !channelNames().includes(channel)) {
          fail(`unknown channel "${channel}" — have ${channelNames().join(', ')}`);
        }

        // `--advance` promotes what the sweep recorded, for every channel that has
        // something to promote. The cursor and `seen` were pj's own numbers; the
        // agent was copying them between two processes by hand.
        if (flags.has('advance')) {
          const capturedRaw = flags.get('captured')?.[0];
          const res = advance(root, {
            ...(channel ? { channel } : {}),
            ...(capturedRaw && capturedRaw !== 'true' ? { captured: Number(capturedRaw) } : {}),
          });
          console.log(renderAdvance(res));
          // Nothing to promote anywhere is a mistake worth noticing — a sweep was
          // meant to come first.
          if (!res.moved.length) process.exit(1);
          break;
        }

        if (!channel) fail('pj intake commit --advance | --channel <c> [--cursor <v>]');
        const w = commitWatermark(root, channel, flags.get('cursor')?.[0] ?? null, {
          seen: Number(flags.get('seen')?.[0] ?? 0),
          captured: Number(flags.get('captured')?.[0] ?? 0),
        });
        console.log(`${w.channel} cursor ${w.cursor ?? '(unchanged, none)'} — ran at ${w.ranAt}`);
        break;
      }

      if (sub === 'known') {
        if (!channels.length) fail('pj intake known <fingerprint-or-ref>...');
        for (const row of known(root, channels)) {
          console.log(`${pad(row.ref, 46)} ${row.cards.length ? row.cards.join(', ') : '—'}`);
        }
        break;
      }

      /**
       * The other half of resolving a sweep. `pj add` records a yes; this records
       * a no, so the next sweep stops offering it and the reason survives to be
       * read back. Without it a decline left nothing behind but a moved cursor.
       */
      /**
       * A sweep that judges and writes, run once by hand.
       *
       * The same tick the server runs on a timer — same classifier, same
       * suppressions, same cursor rule — so a vault that does not want a server
       * running is not a vault that has to do this by conversation instead.
       */
      if (sub === 'poll') {
        const res = await pollOnce(root);
        if (res.held) {
          console.log(`held — ${res.held}. Nothing written, no cursor moved.`);
          process.exit(1);
        }
        for (const u of res.unreachable) console.log(`${pad(u.channel, 10)} not fetched — ${u.reason}`);
        for (const id of res.created) console.log(`${pad('new', 10)} ${id}`);
        console.log(
          `${res.created.length} note(s), ${res.declined} declined, ${res.skipped} already known` +
            (res.advanced.length ? ` — cursor moved for ${res.advanced.join(', ')}` : ''),
        );
        break;
      }

      /**
       * Run the pass again over what is still unjudged.
       *
       * The migration path for cards written by a thinner version of the pass,
       * and the way a changed `classify.md` reaches the queue without emptying it
       * by hand. It rewrites; it never deletes — a card it would no longer keep is
       * named, and removing one is `pj rm`, which records the decline.
       */
      if (sub === 'rejudge') {
        const res = await rejudge(root, {
          ...(flags.get('limit')?.[0] ? { limit: Number(flags.get('limit')![0]) } : {}),
        });
        if (res.held) {
          console.log(`held — ${res.held}. Nothing was rewritten.`);
          process.exit(1);
        }
        for (const c of res.changed) console.log(`${pad('rewrote', 10)} ${pad(c.id, 34)} ${c.title.slice(0, 60)}`);
        for (const w of res.wouldDrop) {
          console.log(`${pad('stale?', 10)} ${pad(w.id, 34)} ${w.reason.slice(0, 60)}`);
        }
        console.log(
          `${res.changed.length} rewritten, ${res.same} unchanged` +
            (res.wouldDrop.length
              ? ` — ${res.wouldDrop.length} the pass would no longer keep; remove with pj rm, which records the decline`
              : ''),
        );
        break;
      }

      if (sub === 'suppress') {
        const reason = flags.get('reason')?.[0];
        if (!channels.length || !reason) {
          fail('pj intake suppress <fingerprint>... --reason <why> [--channel c] [--title t]');
        }
        for (const fp of channels) {
          const s = suppress(root, {
            fingerprint: fp,
            reason: reason!,
            ...(flags.get('channel')?.[0] ? { channel: flags.get('channel')![0]! } : {}),
            ...(flags.get('title')?.[0] ? { title: flags.get('title')![0]! } : {}),
          });
          console.log(`suppressed ${s.fingerprint} — ${s.reason}`);
        }
        break;
      }

      /**
       * The pile a threshold hides, kept readable on purpose: getting the order
       * wrong costs some scrolling and suppressing wrongly costs the item, so the
       * only thing that makes a threshold safe to raise is being able to read what
       * it swallowed.
       */
      if (sub === 'suppressed') {
        const page = suppressions(root, {
          ...(flags.get('channel')?.[0] ? { channel: flags.get('channel')![0]! } : {}),
          ...(flags.get('q')?.[0] ? { q: flags.get('q')![0]! } : {}),
          ...(flags.get('limit')?.[0] ? { limit: Number(flags.get('limit')![0]) } : {}),
        });
        const rows = page.rows;
        if (flags.has('json')) {
          console.log(JSON.stringify(page, null, 2));
          break;
        }
        if (!rows.length) {
          console.log(page.total ? 'nothing matching' : 'nothing suppressed');
          break;
        }
        for (const r of rows) {
          console.log(
            `${pad(r.decidedBy === 'model' ? 'model' : 'you', 6)} ${pad(r.channel ?? '—', 8)} ${pad((r.title ?? r.fingerprint).slice(0, 44), 46)} ${r.reason}`,
          );
        }
        // The pile only grows, so a page that stops has to say so — otherwise the
        // last line reads as the end of the list.
        console.log(
          `${rows.length} of ${page.total}${page.more ? ' — more behind this page; narrow with --q or raise --limit' : ''}`,
        );
        break;
      }

      if (sub === 'unsuppress') {
        if (!channels.length) fail('pj intake unsuppress <fingerprint>...');
        for (const fp of channels) {
          const back = unsuppress(root, fp);
          console.log(
            back
              ? `${fp} — back in the next sweep` +
                  // Naming it because it is a side effect on a different table
                  // than the one the command is about, and because it is what
                  // makes the first half of the sentence true.
                  (back.rewound ? ` (${back.rewound}'s cursor reset, so it is in reach again)` : '')
              : `${fp} — was not suppressed`,
          );
        }
        break;
      }

      if (sub === 'reset') {
        const channel = flags.get('channel')?.[0];
        const n = resetWatermark(root, channel);
        console.log(
          n
            ? `forgot ${n} cursor(s)${channel ? ` for ${channel}` : ''} — the next sweep uses the default window`
            : 'nothing to forget',
        );
        break;
      }

      // No subcommand: the positional arguments are channel names.
      const only = sub ? [sub, ...channels] : [];
      const sinceRaw = flags.get('since')?.[0];
      const since = sinceRaw ? new Date(sinceRaw) : undefined;
      if (since && !Number.isFinite(since.getTime())) fail(`--since "${sinceRaw}" is not a date`);

      const result = await sweep(root, {
        only,
        since,
        limit: Number(flags.get('limit')?.[0] ?? DEFAULT_LIMIT),
      });
      if (result.unknown.length && !result.reports.length) {
        fail(`unknown channel(s): ${result.unknown.join(', ')} — have ${channelNames().join(', ')}`);
      }
      if (flags.has('json')) {
        console.log(JSON.stringify({ candidates: candidateCount(result), ...result }, null, 2));
        break;
      }
      console.log(renderSweep(result, { verbose: flags.has('verbose') }));
      break;
    }

    case 'context': {
      const { flags, rest } = argFlags(argv, ['json'], ['json']);
      const ctx = noteContext(rest[0] ?? '', root);
      if (!ctx) {
        console.error(`no note with id "${rest[0] ?? ''}"`);
        process.exit(1);
      }
      console.log(flags.has('json') ? JSON.stringify(ctx, null, 2) : renderContext(ctx));
      break;
    }

    case 'set': {
      const { flags, rest } = argFlags(argv, ['title', 'facet', 'add', 'remove', 'set']);
      if (!rest.length) {
        console.error(
          'pj set <id>... [--title t] [--facet f=v] [--add f=v] [--remove f=v]\n' +
            '                [--set path=yaml]',
        );
        process.exit(1);
      }
      const { notes } = readAll(p.notes);
      for (const id of rest) if (!notes.has(id)) fail(`no note with id "${id}"`);

      const split = (spec: string): [string, string[]] => {
        const i = spec.indexOf('=');
        const f = i === -1 ? spec : spec.slice(0, i);
        const v = i === -1 ? '' : spec.slice(i + 1);
        return [f, v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []];
      };
      const sets: Record<string, string> = {};
      for (const spec of flags.get('set') ?? []) {
        const i = spec.indexOf('=');
        if (i === -1) fail(`--set needs path=value, got "${spec}"`);
        sets[spec.slice(0, i)] = spec.slice(i + 1);
      }

      // Every id gets the same edit, so a bulk move is one invocation rather
      // than one process per note re-reading the whole vault.
      for (const id of rest) {
        const rec = notes.get(id)!;
        const facets: Record<string, string[]> = { ...rec.facets };
        for (const spec of flags.get('facet') ?? []) {
          const [f, v] = split(spec);
          if (v.length) facets[f] = v;
          else delete facets[f];
        }
        for (const spec of flags.get('add') ?? []) {
          const [f, v] = split(spec);
          facets[f] = [...new Set([...(facets[f] ?? []), ...v])];
        }
        for (const spec of flags.get('remove') ?? []) {
          const [f, v] = split(spec);
          const kept = (facets[f] ?? []).filter((x) => !v.includes(x));
          if (kept.length) facets[f] = kept;
          else delete facets[f];
        }
        const title = flags.get('title')?.[0];
        const touchesFacets = flags.has('facet') || flags.has('add') || flags.has('remove');
        if (title || touchesFacets) {
          patchNote(root, id, {
            ...(title ? { title } : {}),
            ...(touchesFacets ? { facets } : {}),
          });
        }
        if (Object.keys(sets).length) patchFields(root, id, sets);

        const after = noteContext(id, root)!;
        console.log(
          `${id}: ${Object.entries(after.facets).map(([k, v]) => `${k}=${v.join(',')}`).join(' ') || '(no facets)'}`,
        );
      }
      break;
    }

    case 'merge': {
      const { flags, rest } = argFlags(argv, ['into']);
      const into = flags.get('into')?.[0];
      if (!into || !rest.length) fail('pj merge <id>... --into <id>');
      /**
       * The survivor keeps its own facets; the rest bring their body, links,
       * references and capture fingerprints across and their files are removed.
       * One call, because the whole of it has to be checked before any of it is
       * written — see `mergeNotes`.
       */
      const res = mergeNotes(root, into, rest);
      console.log(
        `merged ${res.merged} note(s) into ${into}` +
          (res.repointed ? `, repointing ${res.repointed} reference(s)` : ''),
      );
      break;
    }

    case 'rm': {
      const { rest } = argFlags(argv, []);
      if (!rest.length) {
        console.error('pj rm <id>...');
        process.exit(1);
      }
      // Through `deleteNote`, which drops every reference pointing at the note.
      // Removing the file by hand leaves them dangling, which `pj check` then
      // reports — the reason this command exists.
      for (const id of rest) {
        const { removedEdges } = deleteNote(root, id);
        console.log(`removed ${id}${removedEdges ? ` and ${removedEdges} reference(s) to it` : ''}`);
      }
      break;
    }

    case 'work': {
      const { flags, rest } = argFlags(
        argv,
        ['dry-run', 'no-open', 'new'],
        ['dry-run', 'no-open', 'new'],
      );
      const id = rest[0];
      const ctx = id ? noteContext(id, root) : null;
      if (!ctx) {
        console.error('pj work <id> [--dry-run] [--no-open] [--new]');
        process.exit(1);
      }
      /**
       * Deciding and doing are both `agent/work.ts` now, because the app reaches
       * the same act through `POST /api/note/:id/work` and the two must not be
       * able to disagree about which branch, which directory or which link. What
       * is left here is printing.
       */
      let plan;
      try {
        plan = planWork(ctx, root);
      } catch (err) {
        if (!(err instanceof NotWorkable)) throw err;
        console.error(err.message);
        process.exit(1);
      }

      console.log(`workspace  ${plan.workspace}`);
      console.log(`branch     ${plan.branch}`);
      for (const r of plan.repos) console.log(`repo       ${r.path}${r.base ? ` @ ${r.base}` : ''}`);

      if (flags.has('dry-run')) {
        console.log('\n--- AGENT_BRIEFING.md (dry run) ---\n');
        console.log(plannedBriefing(ctx, plan));
        break;
      }

      let started;
      try {
        started = startWork(ctx, plan, root, { fresh: flags.has('new') });
      } catch (err) {
        if (!(err instanceof NotWorkable)) throw err;
        console.error(`\n${err.message}`);
        process.exit(1);
      }
      for (const r of started.results) {
        console.log(`  ${r.error ? '✗' : r.created ? '+' : '='} ${pad(r.name, 26)} ${r.error ?? r.path}`);
      }
      console.log(`\nwrote ${started.briefingPath}`);
      // Worth a line either way. Silence about the recorded workspace would make
      // the one thing this writes into the vault the one thing it does not say.
      if (started.recordError) console.error(`could not record it on ${ctx.id}: ${started.recordError}`);
      else console.log(started.recorded ? `recorded on ${ctx.id}` : `already recorded on ${ctx.id}`);

      const { opening } = started;
      if (opening.how !== 'new') {
        const s = opening.session;
        console.log(`\n${s.state} here: session ${s.uuid.slice(0, 8)}, last active ${ago(s.lastAt)}`);
        if (s.opening) console.log(`  ${s.opening}`);
      }
      /**
       * A live session the desktop app cannot be pointed at — started from a
       * terminal — is the one case with nothing to open. Saying so and stopping
       * is the point: opening a second session beside it is exactly the silent
       * duplication this is here to prevent, and `--new` is how you ask for it.
       */
      if (opening.how === 'running') {
        console.log(`\nalready running here, and not the app's to reopen.\nStart another alongside it with --new.`);
        break;
      }

      if (flags.has('no-open')) {
        console.log(`not opening the app (--no-open)\n  ${opening.link}`);
        break;
      }
      /**
       * The desktop app, not a terminal.
       *
       * A note already opens its past sessions in the app — `enrich/claudeSession.ts`
       * mints a `claude://` link for every one it can — so the session that is
       * about to exist opens the same way, rather than in a second place with its
       * own idea of what a session is. `open` hands the URL to whatever registered
       * the scheme; the fallback below is the CLI, for a machine with no app.
       */
      try {
        execFileSync('open', [opening.link], { stdio: ['ignore', 'ignore', 'pipe'] });
        console.log(opening.how === 'reopen' ? 'reopened it in Claude' : 'opened the workspace in Claude');
      } catch (err) {
        console.error(`could not open the app: ${(err as Error).message}`);
        console.log(
          opening.how === 'reopen'
            ? `run it yourself:\n  claude --resume ${opening.session.uuid}`
            : `run it yourself:\n  cd ${shellQuote(started.workspace)} && claude ${shellQuote(BRIEFING_PROMPT)}`,
        );
      }
      break;
    }

    case 'setup': {
      const { flags } = argFlags(
        argv,
        ['json', 'init', 'channels', 'no-enrich'],
        ['json', 'init', 'no-enrich'],
      );
      if (flags.has('init')) {
        const channels = (flags.get('channels')?.[0] ?? 'claude,git,jira,slack,gmail')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        const res = writeTemplate(root, channels, !flags.has('no-enrich'));
        console.log(res.written ? `wrote ${res.path}` : `left ${res.path} alone: ${res.reason}`);
        if (!res.written) process.exitCode = 1;
        break;
      }
      const report = await probe(root);
      if (flags.has('json')) console.log(JSON.stringify(report, null, 2));
      else console.log(formatReport(report));
      break;
    }

    // Asking for help is not a failed command, so it exits 0; a typo still does not.
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.log(HELP);
      if (cmd) process.exitCode = 1;
  }
} catch (err) {
  console.error(`pj ${cmd}: ${(err as Error).message}`);
  process.exit(1);
}
