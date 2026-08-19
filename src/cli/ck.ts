#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, paths, resolvePath } from '../config.ts';
import { loadFacets } from '../schema/facets.ts';
import { listCardFiles, renderCard, writeCardFile } from '../schema/card.ts';
import { formatIssues, validate } from '../schema/validate.ts';
import { parseLink } from '../schema/links.ts';
import { patchKey } from '../schema/frontmatter.ts';
import { readFileSync } from 'node:fs';
import { readAll, reindex } from '../index/indexer.ts';
import { resolveProject } from '../index/project.ts';
import {
  blockersOf,
  counts,
  groupBy,
  listRecords,
  nextUp,
  search,
  UNCATEGORISED,
  unblocks,
  valuesFor,
} from '../index/queries.ts';
import { importTrello } from '../import/trello.ts';
import { importTodo } from '../import/todo.ts';
import { slugify, uniqueId } from '../import/slug.ts';

const root = dataDir();
const p = paths(root);

const HELP = `ck — cockpit CLI   (data: ${root})

  ck ls [--group <facet>] [--filter f=v,v] [--nodes]   list records, grouped
  ck show <id>                                         one record in full
  ck next                                              actionable cards: open and unblocked
  ck add <title> [--kind card|node] [--parent id]
         [--facet f=v ...] [--link ref ...]            create a record
  ck link <id> <ref> [...]                             append links to a record
  ck check                                             validate every card file
  ck reindex                                           rebuild the index from files
  ck search <query>                                    full-text search
  ck project <id>                                      resolved project config for a record
  ck import trello <file.json>                         import a Trello board export
  ck import todo <TODO.md>                             import a TODO.md
  ck stats                                             index counts
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
  mkdirSync(p.boards, { recursive: true });
  mkdirSync(p.canvases, { recursive: true });
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

function cmdLs(argv: string[]): void {
  const { flags } = argFlags(argv);
  const facets = loadFacets(p.facets);
  const { db } = reindex(root);
  const group = flags.get('group')?.[0];
  const rows = listRecords(db, {
    filter: parseFilter(flags.get('filter')),
    includeNodes: flags.has('nodes'),
  });

  if (!group) {
    for (const r of rows) console.log(`${pad(r.id, 34)} ${r.title}`);
    console.log(`\n${rows.length} record(s)`);
    return;
  }

  const groups = groupBy(db, rows, group, facets);
  const def = facets[group];
  const total = rows.length;
  const placements = groups.reduce((n, g) => n + g.rows.length, 0);

  console.log(`# grouped by ${def?.label ?? group}\n`);
  for (const g of groups) {
    console.log(`## ${g.value}  (${g.rows.length})`);
    for (const r of g.rows) {
      const marks = [
        r.is_project ? 'P' : r.kind === 'node' ? 'n' : ' ',
      ].join('');
      console.log(`   ${marks} ${pad(r.id, 32)} ${r.title}`);
    }
    console.log('');
  }
  const extra = placements - total;
  console.log(
    `${total} record(s) in ${groups.length} group(s)` +
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
  console.log(`kind     ${rec.kind}${rec.project ? ' (project)' : ''}`);
  console.log(`file     ${rec.file.replace(root + '/', '')}`);
  for (const [f, v] of Object.entries(rec.facets)) console.log(`${pad(f, 8)} ${v.join(', ')}`);
  if (rec.edges.length) {
    console.log('\nedges');
    for (const e of rec.edges) console.log(`  ${pad(e.type, 8)} → ${e.to}`);
  }
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
  console.log('# actionable now — open status, no unfinished blocker\n');
  for (const r of rows) {
    const pr = valuesFor(db, r.id, 'priority').join(',') || '-';
    const opens = unblocks(db, r.id).length;
    console.log(
      `  ${pad(pr, 9)} ${pad(r.id, 32)} ${r.title}` + (opens ? `   (unblocks ${opens})` : ''),
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
  const kind = (flags.get('kind')?.[0] ?? 'card') as 'card' | 'node';
  const parent = flags.get('parent')?.[0];
  const today = new Date().toISOString().slice(0, 10);
  const text = renderCard({
    id,
    kind,
    title,
    facets,
    edges: parent ? [{ type: 'parent', to: parent }] : [],
    links: (flags.get('link') ?? []).map(parseLink),
    created: today,
    updated: today,
    body: '\n',
  });
  const file = cardPath(id);
  if (existsSync(file)) {
    console.error(`${file} already exists`);
    process.exit(1);
  }
  writeCardFile(file, text);
  console.log(`created ${file.replace(root + '/', '')}  (id: ${id})`);
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
    const ok = existsSync(r.path) ? '' : '   (path not found)';
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
    console.log(`  lists in file           ${r.listsTotal}  (${r.listsOpen} open)`);
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
      const key = rec.project?.key;
      if (key && !existingProjects.has(key)) existingProjects.set(key, rec.id);
    }
    const res = importTodo(src, { taken, existingProjects });
    records = res.records;
    const r = res.report;
    console.log(`# TODO.md import\n`);
    console.log(`  project records         ${r.projects.length}`);
    console.log(`  cards                   ${r.cards}  (${r.doneCards} already done)`);
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

const [cmd, ...argv] = process.argv.slice(2);
try {
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
    case 'add':
      cmdAdd(argv);
      break;
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

export { UNCATEGORISED, blockersOf, writeFileSync };
