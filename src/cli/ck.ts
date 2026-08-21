#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths, resolveCliVault, resolvePath } from '../config.ts';
import { forgetVault, initVault, listVaults, normalise, registerVault } from '../vault.ts';
import { SEED_FACETS, SEED_README, SEED_VIEWS } from '../server/seed.ts';
import { loadFacets } from '../schema/facets.ts';
import { listCardFiles, renderCard, writeCardFile } from '../schema/card.ts';
import { formatIssues, validate } from '../schema/validate.ts';
import { parseLink } from '../schema/links.ts';
import { patchKey } from '../schema/frontmatter.ts';
import { readFileSync } from 'node:fs';
import { readAll, reindex } from '../index/indexer.ts';
import { kindOf, resolveProject } from '../index/project.ts';
import { counts, nextUp, search, unblocks, valuesFor } from '../index/queries.ts';
import { runQuery } from '../index/query.ts';
import { parseSpec, specToParams } from '../view/spec.ts';
import { findView } from '../server/views.ts';
import { importTrello } from '../import/trello.ts';
import { importTodo } from '../import/todo.ts';
import { formatHistory, history, isRepo } from '../agent/history.ts';
import { readCached, refresh } from '../server/enrich.ts';
import { cardContext, renderContext, untriaged } from '../agent/context.ts';
import { buildBriefing } from '../agent/briefing.ts';
import { branchFor, prepareWorkspace, terminalScript, workspacePath } from '../agent/worktree.ts';
import { sessionForCwd } from '../agent/session.ts';
import { createCard, patchCard } from '../server/mutate.ts';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { slugify, uniqueId } from '../import/slug.ts';

/**
 * Which vault this invocation acts on: `--vault`, then `COCKPIT_DATA`, then the
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

// `ck vaults` manages the registry and so must not require a vault itself.
const NO_VAULT_NEEDED = new Set(['vaults', 'help', '']);
const root = NO_VAULT_NEEDED.has(rawCmd ?? '') ? '' : vaultOrExit();
const p = paths(root || '/nonexistent');

const HELP = `ck — cockpit CLI${root ? `  (vault: ${root})` : ''}

  ck ls [--view <name>] [--group <facet>[,<facet>]] [--filter f=v,v]
     [--sort key:dir] [--q text] [--focus <id> --via parent|member-of|blocks
     --dir down|up|both --depth n] [--nodes]        list records, grouped
  ck show <id>                                         one record in full
  ck next                                              actionable cards: open and unblocked
  ck log [--since "1 week ago"]                        what changed, from git history
  ck add <title> [--parent id] [--facet f=v ...]
         [--link ref ...] [--due YYYY-MM-DD]
         [--fingerprint fp] [--body text]              create a record
  ck link <id> <ref> [...]                             append links to a record
  ck check                                             validate every card file
  ck reindex                                           rebuild the index from files
  ck search <query>                                    full-text search
  ck project <id>                                      resolved project config for a record
  ck import trello <file.json>                         import a Trello board export
  ck import todo <TODO.md>                             import a TODO.md
  ck stats                                             index counts
  ck enrich [<ref>...] [--all] [--force]               resolve link enrichment and print it

  ck context <id> [--json]                             everything known about a card, assembled
  ck untriaged [--json] [--limit n]                    cards needing attention, and why
  ck set <id> [--title t] [--facet f=v] [--add f=v]
         [--remove f=v] [--parent id|none]
         [--due YYYY-MM-DD|none]                       scripted edits, for skills
  ck work <id> [--dry-run] [--no-open]                 multi-repo worktree workspace + briefing
  ck link-session <id> [--cwd dir]                     link the live session working here

  ck vaults                                            list known vaults
  ck vaults add <path> [--name n] [--create]           open a folder as a vault
  ck vaults forget <path>                              stop tracking it (folder untouched)

  --vault <path>                                       act on a specific vault
`;

function argFlags(argv: string[]): { flags: Map<string, string[]>; rest: string[] } {
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
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

function parseFilter(specs: string[] | undefined): Record<string, string[]> | undefined {
  if (!specs?.length) return undefined;
  const out: Record<string, string[]> = {};
  for (const spec of specs) {
    const [facet, values] = spec.split('=');
    if (!facet || !values) continue;
    out[facet] = values.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return Object.keys(out).length ? out : undefined;
}

function ensureData(): void {
  mkdirSync(p.cards, { recursive: true });
  mkdirSync(p.assets, { recursive: true });
  mkdirSync(p.views, { recursive: true });
}

function takenIds(): Set<string> {
  const { records } = readAll(p.cards);
  return new Set(records.keys());
}

function cardPath(id: string): string {
  return join(p.cards, `${id}.md`);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ---------------------------------------------------------------- commands

/**
 * `ck ls` runs the same compiler the sidebar does.
 *
 * The CLI has had `--filter f=v,v --group <facet>` since P0 — the web app is what
 * caught up. Sharing the compiler is what keeps them from drifting: a saved view
 * is a name both a human and an agent can say, and it means the same thing to
 * both.
 */
function cmdLs(argv: string[]): void {
  const { flags } = argFlags(argv);
  const facets = loadFacets(p.facets);
  const { db, records } = reindex(root);

  const params: Record<string, string> = {};
  const named = flags.get('view')?.[0];
  if (named) {
    const saved = findView(root, named);
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
  for (const [flag, key] of [
    ['group', 'group'],
    ['sort', 'sort'],
    ['q', 'q'],
    ['focus', 'focus'],
    ['via', 'via'],
    ['dir', 'dir'],
    ['depth', 'depth'],
  ] as const) {
    const v = flags.get(flag)?.[0];
    if (v && v !== 'true') params[key] = v;
  }
  // `--nodes` is the `kind` pseudo-facet; without it, cards only, as before.
  if (!flags.has('nodes') && !params['f.kind']) params['f.kind'] = 'card';

  const spec = parseSpec(params);
  const res = runQuery(db, records, facets, spec.query);
  const mark = (id: string) => {
    const rec = records.get(id);
    return rec?.project ? 'P' : rec && kindOf(rec) === 'node' ? 'n' : ' ';
  };
  const line = (id: string) => `   ${mark(id)} ${pad(id, 32)} ${records.get(id)?.title ?? ''}`;

  if (!res.groups) {
    for (const id of res.ids) console.log(`${pad(id, 34)} ${records.get(id)?.title ?? ''}`);
    console.log(`\n${res.total} record(s) of ${res.universe}`);
    return;
  }

  const axes = spec.query.groupBy ?? [];
  console.log(`# grouped by ${axes.join(' × ')}\n`);
  for (const g of res.groups) {
    console.log(`## ${g.lane ? `${g.lane} / ` : ''}${g.value} (${g.ids.length})`);
    for (const id of g.ids) console.log(line(id));
    console.log('');
  }
  const extra = res.placements - res.total;
  console.log(
    `${res.total} record(s) of ${res.universe} in ${res.groups.length} group(s)` +
      (extra > 0 ? ` — ${extra} appear in more than one group` : ''),
  );
}

function cmdShow(id: string): void {
  const { records } = readAll(p.cards);
  const rec = records.get(id);
  if (!rec) {
    console.error(`no record with id "${id}"`);
    process.exit(1);
  }
  console.log(`# ${rec.title}\n`);
  console.log(`id       ${rec.id}`);
  console.log(`kind     ${kindOf(rec)}${rec.project ? ' (project)' : ''}`);
  console.log(`file     ${rec.file.replace(root + '/', '')}`);
  if (rec.due) console.log(`due      ${rec.due}`);
  for (const [f, v] of Object.entries(rec.facets)) console.log(`${pad(f, 8)} ${v.join(', ')}`);
  if (rec.links.length) {
    console.log('\nlinks');
    for (const l of rec.links) console.log(`  ${pad(l.kind || '?', 10)} ${l.ref}`);
  }
  const proj = resolveProject(rec.id, records, root);
  if (proj) {
    console.log(`\nproject  ${proj.key}   chain: ${proj.chain.join(' → ')}`);
    for (const r of proj.repos) console.log(`  repo   ${r.path}${r.base ? ` (${r.base})` : ''}`);
  }
  if (rec.body.trim()) console.log(`\n---\n${rec.body.trim()}`);
}

function cmdNext(): void {
  const facets = loadFacets(p.facets);
  const { db } = reindex(root);
  const rows = nextUp(db, facets);
  console.log('# actionable now — open, nobody waited on, no unfinished blocker\n');
  for (const r of rows) {
    const pr = valuesFor(db, r.id, 'priority').join(',') || '-';
    const opens = unblocks(db, r.id).length;
    console.log(
      `  ${pad(r.due ?? '', 11)}${pad(pr, 9)} ${pad(r.id, 32)} ${r.title}` +
        (opens ? `  (unblocks ${opens})` : ''),
    );
  }
  console.log(`\n${rows.length} actionable`);
}

function cmdAdd(argv: string[]): void {
  const { flags, rest } = argFlags(argv);
  const title = rest.join(' ').trim();
  if (!title) {
    console.error('ck add <title>');
    process.exit(1);
  }
  ensureData();
  const taken = takenIds();
  const id = flags.get('id')?.[0] ?? uniqueId(slugify(title), taken);
  const facets: Record<string, string[]> = {};
  for (const spec of flags.get('facet') ?? []) {
    const [f, v] = spec.split('=');
    if (f && v) facets[f] = v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const fingerprint = flags.get('fingerprint')?.[0];
  const res = createCard(root, {
    title,
    parent: flags.get('parent')?.[0],
    facets,
    links: flags.get('link') ?? [],
    body: flags.get('body')?.[0],
    due: flags.get('due')?.[0],
    fingerprint,
  });
  if (res.existed) {
    // A sweep run twice converges instead of refilling the inbox.
    console.log(`skipped — fingerprint already on ${res.id}`);
    return;
  }
  console.log(`created cards/${res.id}.md (id: ${res.id})`);
}

function cmdLink(argv: string[]): void {
  const [id, ...refs] = argv;
  if (!id || !refs.length) {
    console.error('ck link <id> <ref> [...]');
    process.exit(1);
  }
  const { records } = readAll(p.cards);
  const rec = records.get(id);
  if (!rec) {
    console.error(`no record with id "${id}"`);
    process.exit(1);
  }
  const existing = rec.links.map((l) => l.raw);
  const merged = [...existing];
  for (const r of refs) if (!merged.includes(r)) merged.push(r);
  const text = readFileSync(rec.file, 'utf8');
  writeCardFile(rec.file, patchKey(text, 'links', merged));
  console.log(`${id}: ${merged.length} link(s)`);
}

function cmdCheck(): void {
  const facets = loadFacets(p.facets);
  const { records, unreadable, duplicates } = readAll(p.cards);
  const issues = validate(records, facets, root, { unreadable, duplicates });
  console.log(formatIssues(issues, root));
  if (issues.some((i) => i.severity === 'error')) process.exit(1);
}

function cmdReindex(): void {
  const { db, unreadable } = reindex(root);
  const c = counts(db);
  console.log(
    `indexed ${c.records} record(s): ${c.cards} card(s), ${c.nodes} node(s), ` +
      `${c.projects} project(s), ${c.edges} edge(s), ${c.links} link(s)`,
  );
  if (unreadable.length) console.log(`${unreadable.length} file(s) could not be parsed — run ck check`);
}

function cmdSearch(argv: string[]): void {
  const q = argv.join(' ').trim();
  if (!q) {
    console.error('ck search <query>');
    process.exit(1);
  }
  const { db } = reindex(root);
  const rows = search(db, q);
  for (const r of rows) console.log(`${pad(r.id, 34)} ${r.title}`);
  console.log(`\n${rows.length} match(es)`);
}

function cmdProject(id: string): void {
  const { records } = readAll(p.cards);
  if (!records.has(id)) {
    console.error(`no record with id "${id}"`);
    process.exit(1);
  }
  const proj = resolveProject(id, records, root);
  if (!proj) {
    console.log(`${id} has no project ancestor`);
    return;
  }
  console.log(`key      ${proj.key}`);
  console.log(`chain    ${proj.chain.join(' → ')}`);
  console.log(`jira     ${proj.jira ?? '-'}`);
  console.log(`branch   ${proj.branch ?? '-'}`);
  console.log(`repos    ${proj.repos.length ? '' : '-'}`);
  for (const r of proj.repos) {
    const ok = existsSync(r.path) ? '' : '  (path not found)';
    console.log(`  ${r.path}${r.base ? ` @ ${r.base}` : ''}${ok}`);
  }
  if (proj.instructions.length) {
    console.log(`\ninstructions (${proj.instructions.length} block(s), root first)`);
    for (const block of proj.instructions) console.log('\n' + block);
  }
}

function cmdImport(argv: string[]): void {
  const [what, file] = argv;
  if (!what || !file) {
    console.error('ck import trello <file.json> | ck import todo <TODO.md>');
    process.exit(1);
  }
  ensureData();
  const src = resolvePath(file, process.cwd());
  if (!existsSync(src)) {
    console.error(`not found: ${src}`);
    process.exit(1);
  }
  const taken = takenIds();
  let records: ReturnType<typeof importTrello>['records'];

  if (what === 'trello') {
    const res = importTrello(src, { taken });
    records = res.records;
    const r = res.report;
    console.log(`# Trello import\n`);
    console.log(`  file                    ${src}`);
    console.log(`  cards in file           ${r.cardsTotal}`);
    console.log(`  lists in file           ${r.listsTotal} (${r.listsOpen} open)`);
    console.log(`  live cards              ${r.cardsLive}`);
    console.log(`  - meta-list skipped     ${r.skippedMeta}`);
    console.log(`  - separators skipped    ${r.skippedSeparator}`);
    console.log(`  = imported              ${r.imported}`);
    console.log(`  project records         ${r.projects.join(', ') || '-'}`);
    console.log(`  section nodes           ${r.sections}`);
    if (r.vocabulary.length)
      console.log(`\n  column-name palette (${r.vocabulary.length}) → facet vocabulary, not cards:`);
    for (const v of r.vocabulary) console.log(`    ${v}`);
    if (r.urlTitles.length) console.log(`\n  ${r.urlTitles.length} card(s) titled with a bare URL — need titles`);
    for (const n of r.needsAttachment)
      console.log(`  attachment to re-export by hand: ${n.id} → ${n.files.join(', ')}`);
  } else if (what === 'todo') {
    // Existing project records, keyed by their project key, so a project named in
    // both sources is reused rather than duplicated.
    const { records: current } = readAll(p.cards);
    const existingProjects = new Map<string, string>();
    for (const rec of current.values()) {
      if (rec.project && !existingProjects.has(rec.id)) existingProjects.set(rec.id, rec.id);
    }
    const res = importTodo(src, { taken, existingProjects });
    records = res.records;
    const r = res.report;
    console.log(`# TODO.md import\n`);
    console.log(`  project records         ${r.projects.length}`);
    console.log(`  cards                   ${r.cards} (${r.doneCards} already done)`);
    console.log(`    of which inbox        ${r.inboxCards}  → under node "inbox", awaiting triage`);
    console.log(`    of which jira         ${r.jiraCards}  → under node "jira-triage"`);
    for (const s of r.skippedSections) console.log(`  not imported            ${s}`);
  } else {
    console.error(`unknown import source "${what}"`);
    process.exit(1);
  }

  let written = 0;
  let skipped = 0;
  for (const rec of records) {
    const file = cardPath(rec.id);
    if (existsSync(file)) {
      skipped++;
      continue;
    }
    writeCardFile(file, renderCard(rec));
    written++;
  }
  console.log(`\nwrote ${written} file(s)${skipped ? `, skipped ${skipped} already present` : ''}`);
  const { db } = reindex(root);
  const c = counts(db);
  console.log(`index: ${c.records} record(s), ${c.projects} project(s), ${c.edges} edge(s)`);
}

function cmdStats(): void {
  const { db } = reindex(root);
  const c = counts(db);
  for (const [k, v] of Object.entries(c)) console.log(`${pad(k, 14)} ${v}`);
  console.log(`${pad('files', 14)} ${listCardFiles(p.cards).length}`);
}

// ---------------------------------------------------------------- dispatch

const cmd = rawCmd;
const argv = rawArgv;
try {
  // eslint-disable-next-line no-lone-blocks
  switch (cmd) {
    case 'ls':
      cmdLs(argv);
      break;
    case 'show':
      cmdShow(argv[0] ?? '');
      break;
    case 'next':
      cmdNext();
      break;
    case 'log': {
      const { flags } = argFlags(argv);
      if (!isRepo(root)) {
        console.error(
          'this vault is not a git repository — `ck log` reads the history git already keeps',
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
      cmdCheck();
      break;
    case 'reindex':
      cmdReindex();
      break;
    case 'search':
      cmdSearch(argv);
      break;
    case 'project':
      cmdProject(argv[0] ?? '');
      break;
    case 'import':
      cmdImport(argv);
      break;
    case 'stats':
      cmdStats();
      break;

    case 'vaults': {
      const { flags, rest } = argFlags(argv);
      const [sub, given] = rest;
      if (!sub || sub === 'list') {
        const vaults = listVaults();
        if (!vaults.length) {
          console.log('no vaults yet — `ck vaults add <path>`, or open one in the app');
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
          console.error('ck vaults add <path> [--name n] [--create]');
          process.exit(1);
        }
        const path = normalise(given);
        if (flags.has('create')) initVault(path, SEED_FACETS, SEED_README, SEED_VIEWS);
        const entry = registerVault(path, flags.get('name')?.[0]);
        console.log(`${entry.name}  ${entry.path}`);
        break;
      }
      if (sub === 'forget') {
        if (!given) {
          console.error('ck vaults forget <path>');
          process.exit(1);
        }
        console.log(forgetVault(given) ? `forgot ${normalise(given)}` : 'not tracked');
        break;
      }
      console.error(`unknown: ck vaults ${sub}`);
      process.exit(1);
    }
    case 'enrich': {
      const { flags, rest } = argFlags(argv);
      const { records } = readAll(p.cards);
      const refs = rest.length
        ? rest
        : flags.has('all')
          ? [...new Set([...records.values()].flatMap((r) => r.links.map((l) => l.raw)))]
          : [];
      if (!refs.length) {
        console.error('ck enrich <ref>... | ck enrich --all');
        process.exit(1);
      }
      // Kick off the fetches, wait for the queue to drain, then report.
      await new Promise<void>((done) => {
        let settled = false;
        refresh({ dataRoot: root, onRefreshed: () => { settled = true; done(); } }, refs, flags.has('force'));
        // Nothing to fetch (all fresh) means onRefreshed never fires.
        setTimeout(() => { if (!settled) done(); }, 60_000);
      });
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
    case 'context': {
      const { flags, rest } = argFlags(argv);
      const ctx = cardContext(rest[0] ?? '', root);
      if (!ctx) {
        console.error(`no record with id "${rest[0] ?? ''}"`);
        process.exit(1);
      }
      console.log(flags.has('json') ? JSON.stringify(ctx, null, 2) : renderContext(ctx));
      break;
    }

    case 'untriaged': {
      const { flags } = argFlags(argv);
      const limit = Number(flags.get('limit')?.[0] ?? 200);
      const all = untriaged(root);
      const list = all.slice(0, limit);
      if (flags.has('json')) {
        console.log(JSON.stringify({ total: all.length, shown: list.length, cards: list }, null, 2));
        break;
      }
      for (const u of list) console.log(`${pad(u.id, 46)} ${pad(u.reasons.join(', '), 34)} ${u.title.slice(0, 50)}`);
      console.log(`\n${all.length} card(s) need attention${all.length > list.length ? ` (showing ${list.length})` : ''}`);
      break;
    }

    case 'set': {
      const { flags, rest } = argFlags(argv);
      const id = rest[0];
      if (!id) {
        console.error(
          'ck set <id> [--title t] [--facet f=v] [--add f=v] [--remove f=v] [--parent id|none] [--due YYYY-MM-DD|none]',
        );
        process.exit(1);
      }
      const { records } = readAll(p.cards);
      const rec = records.get(id);
      if (!rec) {
        console.error(`no record with id "${id}"`);
        process.exit(1);
      }
      const facets: Record<string, string[]> = { ...rec.facets };
      const split = (spec: string): [string, string[]] => {
        const i = spec.indexOf('=');
        const f = i === -1 ? spec : spec.slice(0, i);
        const v = i === -1 ? '' : spec.slice(i + 1);
        return [f, v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []];
      };
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
      const due = flags.get('due')?.[0];
      patchCard(root, id, {
        ...(title ? { title } : {}),
        ...(due !== undefined ? { due: due === 'none' ? null : due } : {}),
        ...(flags.has('facet') || flags.has('add') || flags.has('remove') ? { facets } : {}),
      });

      // `--parent` is `--facet parent=` spelled the way it reads. One relation
      // mechanism, so re-parenting is an ordinary facet write.
      const parent = flags.get('parent')?.[0];
      if (parent !== undefined) {
        patchCard(root, id, { facets: { ...facets, ...(parent === 'none' ? { parent: [] } : { parent: [parent] }) } });
      }
      const after = cardContext(id, root)!;
      console.log(
        `${id}: ${Object.entries(after.facets).map(([k, v]) => `${k}=${v.join(',')}`).join(' ') || '(no facets)'}` +
          (after.parents.length ? `  parent=${after.parents.map((x) => x.id).join(',')}` : ''),
      );
      break;
    }

    case 'work': {
      const { flags, rest } = argFlags(argv);
      const id = rest[0];
      const ctx = id ? cardContext(id, root) : null;
      if (!ctx) {
        console.error('ck work <id>');
        process.exit(1);
      }
      const jiraKeys = ctx.links.filter((l) => l.kind === 'jira').map((l) => l.ref);
      const branch = branchFor(ctx.id, { template: ctx.project?.branch, jiraKeys });
      const parentDir =
        process.env.COCKPIT_WORKSPACES ?? join(homedir(), 'Code', 'wt');
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

    case 'link-session': {
      const { flags, rest } = argFlags(argv);
      const id = rest[0];
      if (!id) {
        console.error('ck link-session <id> [--cwd dir]');
        process.exit(1);
      }
      const cwd = flags.get('cwd')?.[0] ?? process.cwd();
      const found = sessionForCwd(cwd, process.pid);
      if (!found) {
        console.error(`no live Claude session found working in ${cwd}`);
        process.exit(1);
      }
      const { records } = readAll(p.cards);
      const rec = records.get(id);
      if (!rec) {
        console.error(`no record with id "${id}"`);
        process.exit(1);
      }
      const ref = `claude:${found.sessionId}`;
      const existing = rec.links.map((l) => l.raw);
      if (existing.includes(ref)) {
        console.log(`${id} already links ${ref}`);
        break;
      }
      patchCard(root, id, { links: [...existing, ref] });
      console.log(`${id} → ${ref}${found.name ? ` (${found.name})` : ''}`);
      break;
    }

    case 'init':
      ensureData();
      console.log(`data directory ready at ${root}`);
      break;
    default:
      console.log(HELP);
      if (cmd) process.exitCode = 1;
  }
} catch (err) {
  console.error(`ck ${cmd}: ${(err as Error).message}`);
  process.exit(1);
}
