#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, resolveCliVault, resolvePath } from '../config.ts';
import { forgetVault, initVault, listVaults, normalise, registerVault } from '../vault.ts';
import { SEED_FACETS, SEED_VIEWS } from '../server/seed.ts';
import { loadFacets } from '../schema/facets.ts';
import { listCardFiles } from '../schema/card.ts';
import { formatIssues, validate, validateViews } from '../schema/validate.ts';
import { readAll, reindex } from '../index/indexer.ts';
import { counts, search } from '../index/queries.ts';
import { ftsPrefixQuery } from '../index/query.ts';
import { SPEC_PARAMS, parseSpec, specToParams, type ViewSpec } from '../view/spec.ts';
import { queryPayload } from '../view/payload.ts';
import { findView, loadViews, viewFiles } from '../server/views.ts';
import { formatHistory, history, isRepo } from '../agent/history.ts';
import { readCached, refresh } from '../server/enrich.ts';
import { cardContext, renderContext } from '../agent/context.ts';
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
import { resetWatermark } from '../intake/db.ts';
import { buildBriefing } from '../agent/briefing.ts';
import { branchFor, prepareWorkspace, terminalScript, workspacePath } from '../agent/worktree.ts';
import { sessionForCwd } from '../sources/claude.ts';
import { createCard, deleteCard, patchCard, patchFields } from '../server/mutate.ts';
import { execFileSync } from 'node:child_process';

/**
 * Which vault this invocation acts on: `--vault`, then `PROJECTOR_DATA`, then the
 * single registered vault if there is exactly one. There is no built-in default
 * and no directory name assumed.
 */
/**
 * `--vault <path>` may appear anywhere, including before the command, so it is
 * removed from the argument list before the command is read.
 */
const rawArgs = process.argv.slice(2);
const vaultFlagAt = rawArgs.indexOf('--vault');
const cliArgs =
  vaultFlagAt === -1 ? rawArgs : [...rawArgs.slice(0, vaultFlagAt), ...rawArgs.slice(vaultFlagAt + 2)];
const [rawCmd, ...rawArgv] = cliArgs;

function vaultOrExit(): string {
  const res = resolveCliVault(process.argv, listVaults().filter((v) => v.exists));
  if ('error' in res) {
    console.error(res.error);
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
const soft = asking ? resolveCliVault(process.argv, listVaults().filter((v) => v.exists)) : null;
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
     [--show f,f] [--uncategorised end|start|hide]
     [--json]                                      list records, grouped
  pj log [--since "1 week ago"]                        what changed, from git history
  pj add <title> [--id slug] [--parent id]
         [--facet f=v ...] [--link ref ...]
         [--fingerprint fp] [--body text]              create a record
  pj link <id> <ref> [...] [--remove]
         [--session] [--cwd dir]                       add or remove links; --session names the
                                                       live Claude session working here
  pj check                                             validate every card file and saved view
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
  pj intake known <fingerprint>...                     which cards already carry these refs
  pj intake reset [--channel c]                        forget a cursor, back to the default window

  pj context <id> [--json]                             everything known about a card, assembled
  pj set <id>... [--title t] [--facet f=v] [--add f=v]
         [--remove f=v] [--parent id|none]
         [--set path=yaml ...]                         scripted edits, for skills
  pj rm <id>...                                        delete, dropping references to it
  pj work <id> [--dry-run] [--no-open]                 multi-repo worktree workspace + briefing

  pj vaults                                            list known vaults
  pj vaults add <path> [--name n] [--create]           open a folder as a vault
  pj vaults forget <path>                              stop tracking it (folder untouched)

  --vault <path>                                       act on a specific vault
`;

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
/** Report and stop. A CLI that half-applies a bad batch is worse than one that refuses. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function argFlags(
  argv: string[],
  known: readonly string[],
  booleans: readonly string[] = [],
): { flags: Map<string, string[]>; rest: string[] } {
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!known.includes(key)) {
        console.error(
          known.length
            ? `unknown flag --${key}. This command takes: ${known.map((k) => '--' + k).join(' ')}`
            : `unknown flag --${key}. This command takes none.`,
        );
        process.exit(1);
      }
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
      // is how it says "delete this key" — so only a `--flag` ends a flag.
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, [...(flags.get(key) ?? []), 'true']);
      } else {
        flags.set(key, [...(flags.get(key) ?? []), next]);
        i++;
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

function ensureData(): void {
  mkdirSync(p.cards, { recursive: true });
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
 * No `--limit`: at 191 records nothing needs truncating, and a cap that has no
 * users is a cap whose interaction with grouping nobody is checking.
 */
function cmdLs(argv: string[]): void {
  const { flags } = argFlags(argv, [
    ...SPEC_PARAMS, 'filter', 'json',
  ], ['json']);
  const facets = loadFacets(p.facets);
  const { db, records } = reindex(root);

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
  // which is how `--shape`, `--show` and `--uncategorised` arrive: they were
  // missing from a hand-kept copy, so the CLI could not ask for a canvas.
  for (const key of SPEC_PARAMS) {
    if (key === 'view') continue;
    const v = flags.get(key)?.[0];
    if (v && v !== 'true') params[key] = v;
  }

  const spec = parseSpec(params);
  spec.name = named;

  // The same assembly the web app receives, from the same module (C9). A second
  // shape for the CLI is how the two surfaces would start disagreeing about the
  // answer, having been made unable to disagree about the question.
  const payload = queryPayload({ facets, db, records, views: loadViews(root) }, spec, saved);

  if (flags.has('json')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const title = (id: string) => payload.cards[id]?.title ?? '';
  const mark = (id: string) => {
    const card = payload.cards[id];
    // A container is a record something points at, not a kind it declares.
    return card?.isProject ? 'P' : (card?.childCount ?? 0) > 0 ? '+' : ' ';
  };
  const line = (id: string) => `   ${mark(id)} ${pad(id, 32)} ${title(id)}`;

  if (!payload.groups) {
    for (const id of payload.ids) console.log(`${pad(id, 34)} ${title(id)}`);
    console.log(`\n${payload.total} record(s) of ${payload.universe}`);
    return;
  }

  const axes = spec.query.groupBy ?? [];
  console.log(`# grouped by ${axes.join(' \u00d7 ')}\n`);
  for (const g of payload.groups) {
    console.log(`## ${g.lane ? `${g.lane} / ` : ''}${g.value} (${g.ids.length})`);
    for (const id of g.ids) console.log(line(id));
    console.log('');
  }
  const extra = payload.placements - payload.total;
  console.log(
    `${payload.total} record(s) of ${payload.universe} in ${payload.groups.length} group(s)` +
      (extra > 0 ? ` — ${extra} appear in more than one group` : ''),
  );
}

function cmdAdd(argv: string[]): void {
  const { flags, rest } = argFlags(argv, ['id', 'parent', 'facet', 'link', 'body', 'fingerprint']);
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
  const res = createCard(root, {
    title,
    id: flags.get('id')?.[0],
    parent: flags.get('parent')?.[0],
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
  console.log(`created cards/${res.id}.md (id: ${res.id})`);
}

/**
 * The one place a card's `links` array is written.
 *
 * Three commands used to do this. `unlink` was `link`'s inverse with the same
 * body, and `link-session` differed only in where the ref came from — the cwd
 * rather than the argument list — which makes `--session` a way of *naming* a
 * ref, not a separate operation.
 *
 * It writes through `patchCard`, which is the other half of collapsing them.
 * `link` and `unlink` wrote frontmatter directly and so never bumped `updated`,
 * while `link-session` went through the gate and did: attaching a Jira issue left
 * a card reading as untouched since 2020, and README is explicit that `updated`
 * "only ever says that *something* changed". One write path, one answer.
 *
 * A ref that is not there is an error rather than a no-op on `--remove`:
 * `pj link x --remove jira:FOO-1` reporting success while doing nothing is how
 * you find out a month later that the link is still on the other card.
 */
function cmdLink(argv: string[]): void {
  const { flags, rest } = argFlags(argv, ['remove', 'session', 'cwd'], ['remove', 'session']);
  const [id, ...given] = rest;
  if (!id) fail('pj link <id> <ref>... [--remove] [--session] [--cwd dir]');

  const refs = [...given];
  if (flags.has('session')) {
    const cwd = flags.get('cwd')?.[0];
    const dir = cwd && cwd !== 'true' ? cwd : process.cwd();
    const found = sessionForCwd(dir, process.pid);
    if (!found) fail(`no live Claude session found working in ${dir}`);
    refs.push(`claude:${found.sessionId}`);
  }
  if (!refs.length) fail('pj link <id> <ref>... — nothing to add or remove');

  const { records } = readAll(p.cards);
  const rec = records.get(id);
  if (!rec) fail(`no record with id "${id}"`);
  const existing = rec.links.map((l) => l.raw);

  if (flags.has('remove')) {
    const missing = refs.filter((r) => !existing.includes(r));
    if (missing.length) {
      fail(`${id} does not link ${missing.join(', ')}.\nIt links: ${existing.join(', ') || '(nothing)'}`);
    }
    const kept = existing.filter((l) => !refs.includes(l));
    patchCard(root, id, { links: kept });
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
  patchCard(root, id, { links: merged });
  console.log(`${id}: ${merged.length} link(s)` + (already.length ? ` (${already.length} already there)` : ''));
}

function cmdCheck(): void {
  const facets = loadFacets(p.facets);
  const { records, unreadable, duplicates } = readAll(p.cards);
  const issues = [
    ...validate(records, facets, root, { unreadable, duplicates }),
    // A view is checked against the same vocabulary its cards are. Until it was,
    // a filter naming a deleted facet matched nothing and reported success.
    ...validateViews(
      viewFiles(root).map(({ name, file }) => ({ spec: findView(root, name)!, file })),
      facets,
    ),
  ];
  console.log(formatIssues(issues, root));
  if (issues.some((i) => i.severity === 'error')) process.exit(1);
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
  const { db, unreadable } = reindex(root);
  const c = counts(db);
  console.log(`indexed ${c.records} record(s)`);
  for (const [k, v] of Object.entries(c)) {
    if (k === 'records') continue;
    console.log(`  ${pad(k, 14)} ${v}`);
  }
  console.log(`  ${pad('files', 14)} ${listCardFiles(p.cards).length}`);
  if (unreadable.length) console.log(`${unreadable.length} file(s) could not be parsed — run pj check`);
}

/**
 * Ranked full-text search.
 *
 * `pj ls --q` answers the same "which records match this text" and answers it the
 * same way now — same sanitiser, same records. What it cannot do is order by
 * relevance: the comparator ranks a record by its own facet values, and a match
 * score belongs to the result set rather than to any record in it. So this stays,
 * as the ranked spelling, and pj-work resolving "which card did they mean" gets
 * the best match first rather than the most recently touched.
 *
 * It used to pass raw input straight to FTS5 — `pj search 'foo('` died with a
 * syntax error — and to truncate at `search()`'s default of 25 while printing 25
 * as the total.
 */
function cmdSearch(argv: string[]): void {
  const { rest } = argFlags(argv, []);
  const raw = rest.join(' ').trim();
  if (!raw) fail('pj search <query>');
  const q = ftsPrefixQuery(raw);
  if (q === null) {
    console.log(`no searchable words in "${raw}"`);
    return;
  }
  const { db } = reindex(root);
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
      cmdLs(argv);
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
    case 'reindex':
      argFlags(argv, []);
      cmdReindex();
      break;
    case 'search':
      cmdSearch(argv);
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
          const state = v.exists ? `${v.cards} card(s)` : 'MISSING';
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
      const { records } = readAll(p.cards);
      const refs = rest.length
        ? rest
        : flags.has('all')
          ? [...new Set([...records.values()].flatMap((r) => r.links.map((l) => l.raw)))]
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
          `${pad(item.state, 12)} ${pad(d?.label ?? '—', 22)} ${(d?.title ?? item.error ?? item.note ?? '').slice(0, 62)}` +
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
      const ctx = cardContext(rest[0] ?? '', root);
      if (!ctx) {
        console.error(`no record with id "${rest[0] ?? ''}"`);
        process.exit(1);
      }
      console.log(flags.has('json') ? JSON.stringify(ctx, null, 2) : renderContext(ctx));
      break;
    }

    case 'set': {
      const { flags, rest } = argFlags(argv, ['title', 'facet', 'add', 'remove', 'parent', 'set']);
      if (!rest.length) {
        console.error(
          'pj set <id>... [--title t] [--facet f=v] [--add f=v] [--remove f=v]\n' +
            '                [--parent id|none] [--set path=yaml]',
        );
        process.exit(1);
      }
      const { records } = readAll(p.cards);
      for (const id of rest) if (!records.has(id)) fail(`no record with id "${id}"`);

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
      // than one process per card re-reading the whole vault.
      for (const id of rest) {
        const rec = records.get(id)!;
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
        // `--parent` is `--facet parent=` spelled the way it reads.
        const parent = flags.get('parent')?.[0];
        if (parent !== undefined) {
          if (parent === 'none') delete facets.parent;
          else facets.parent = [parent];
        }

        const title = flags.get('title')?.[0];
        const touchesFacets =
          flags.has('facet') || flags.has('add') || flags.has('remove') || flags.has('parent');
        if (title || touchesFacets) {
          patchCard(root, id, {
            ...(title ? { title } : {}),
            ...(touchesFacets ? { facets } : {}),
          });
        }
        if (Object.keys(sets).length) patchFields(root, id, sets);

        const after = cardContext(id, root)!;
        console.log(
          `${id}: ${Object.entries(after.facets).map(([k, v]) => `${k}=${v.join(',')}`).join(' ') || '(no facets)'}`,
        );
      }
      break;
    }

    case 'rm': {
      const { rest } = argFlags(argv, []);
      if (!rest.length) {
        console.error('pj rm <id>...');
        process.exit(1);
      }
      // Through `deleteCard`, which drops every reference pointing at the record.
      // Removing the file by hand leaves them dangling, which `pj check` then
      // reports — the reason this command exists.
      for (const id of rest) {
        const { removedEdges } = deleteCard(root, id);
        console.log(`removed ${id}${removedEdges ? ` and ${removedEdges} reference(s) to it` : ''}`);
      }
      break;
    }

    case 'work': {
      const { flags, rest } = argFlags(argv, ['dry-run', 'no-open'], ['dry-run', 'no-open']);
      const id = rest[0];
      const ctx = id ? cardContext(id, root) : null;
      if (!ctx) {
        console.error('pj work <id>');
        process.exit(1);
      }
      const jiraKeys = ctx.links.filter((l) => l.kind === 'jira').map((l) => l.ref);
      const branch = branchFor(ctx.id, { template: ctx.project?.branch, jiraKeys });
      // Required, with no fallback. `pj work` creates real worktrees on disk, and a
      // guessed parent directory puts them somewhere the user did not choose and
      // will not think to look. Being told is cheap; being surprised is not.
      const workspaces = process.env.PROJECTOR_WORKSPACES;
      if (!workspaces) {
        console.error(
          'PROJECTOR_WORKSPACES is not set — `pj work` needs to be told where worktrees go.\n' +
            '  export PROJECTOR_WORKSPACES=~/Code/wt',
        );
        process.exit(1);
      }
      const parentDir = resolvePath(workspaces, process.cwd());
      const workspace = workspacePath(parentDir, ctx.project?.key ?? 'no-project', branch);
      const repos = ctx.project?.repos ?? [];

      if (!repos.length) {
        console.error(
          `"${ctx.id}" has no repos: its project declares none, or it has no project.\n` +
            `Add repos to the project record's frontmatter, then try again.`,
        );
        process.exit(1);
      }

      console.log(`workspace  ${workspace}`);
      console.log(`branch     ${branch}`);
      for (const r of repos) console.log(`repo       ${r.path}${r.base ? ` @ ${r.base}` : ''}`);

      if (flags.has('dry-run')) {
        const briefing = buildBriefing({
          ctx,
          workspace,
          branch,
          repos: repos.map((r) => ({ name: r.path.split('/').pop()!, path: r.path, created: false, error: null })),
        });
        console.log('\n--- AGENT_BRIEFING.md (dry run) ---\n');
        console.log(briefing);
        break;
      }

      const results = prepareWorkspace(workspace, repos, branch);
      for (const r of results) {
        console.log(`  ${r.error ? '✗' : r.created ? '+' : '='} ${pad(r.name, 26)} ${r.error ?? r.path}`);
      }
      if (!results.some((r) => !r.error)) {
        console.error('\nno worktree could be created; not launching');
        process.exit(1);
      }

      const briefing = buildBriefing({ ctx, workspace, branch, repos: results });
      const briefingPath = join(workspace, 'AGENT_BRIEFING.md');
      writeFileSync(briefingPath, briefing, 'utf8');
      console.log(`\nwrote ${briefingPath}`);

      if (flags.has('no-open')) {
        console.log('not opening a terminal (--no-open)');
        break;
      }
      try {
        execFileSync('osascript', ['-e', terminalScript(workspace, 'Read AGENT_BRIEFING.md and follow it exactly.')], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        console.log('opened a Terminal running claude there');
      } catch (err) {
        console.error(`could not open Terminal: ${(err as Error).message}`);
        console.log(`run it yourself:\n  cd ${workspace} && claude "Read AGENT_BRIEFING.md and follow it exactly."`);
      }
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
