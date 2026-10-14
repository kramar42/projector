import { z } from 'zod';
import { paths } from '../config.ts';
import { cached } from '../index/cache.ts';
import { readAll, reindex } from '../index/indexer.ts';
import { counts, search } from '../index/queries.ts';
import { ftsPrefixQuery } from '../index/query.ts';
import { loadFacets } from '../schema/facets.ts';
import { formatIssues, validate } from '../schema/validate.ts';
import { validateViews } from '../view/validate.ts';
import { slugify, uniqueId } from '../schema/slug.ts';
import { editFacets, type FacetOp } from '../schema/edit.ts';
import { checkFacets } from '../server/mutate.ts';
import { loadViewFiles, loadViews } from '../server/views.ts';
import { jiraConfig } from '../sources/jira.ts';
import { queryPayload, runRules } from '../view/payload.ts';
import { renderListing, resolveListing, type Overrides } from '../view/listing.ts';
import { specToParams } from '../view/spec.ts';
import { noteContext, renderContext } from '../agent/context.ts';
import { formatHistory, history, isRepo } from '../agent/history.ts';
import { shellQuote } from '../agent/worktree.ts';
import { parseDay } from '../did/day.ts';
import { DID_SOURCES, did, renderDid } from '../did/run.ts';

/**
 * What the MCP server can be asked, one entry per tool.
 *
 * Every tool here is a `pj` read run in-process — the same module the command
 * calls, so a chat and a shell asking the same question get the same answer
 * (C9). None writes a note. The vault's rule is that nothing lands in it without
 * its owner's say-so, and a tool call is somebody else's say-so; so the one tool
 * that is *about* a write, `propose`, prints the command and runs nothing.
 *
 * The derived index under `.projector/` is the exception every read already
 * makes: it is rebuilt when a note changed, exactly as `pj ls` rebuilds it (C1).
 */

/** The vault a call acts on, and what to call it in a printed command. */
export interface Vault {
  root: string;
  /** Its registered name, or null when the server was started with a path. */
  name: string | null;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  /** True for the one tool that reaches past the vault — `did` asks Jira. */
  openWorld?: boolean;
  run(args: Record<string, unknown>, vault: Vault): string | Promise<string>;
}

/**
 * The same memo the app's server reads through, for the same reason: this is a
 * long-lived process too. Rebuilt exactly when a note, view or the vocabulary
 * changed, and the superseded handle closed rather than leaked per call.
 *
 * Callers must not `await` between this and their last read of what it returns.
 */
function indexed(root: string) {
  return cached(
    root,
    (r) => {
      const { db, notes } = reindex(r);
      return { db, notes, facets: loadFacets(paths(r).facets), views: loadViews(r) };
    },
    ({ db }) => db.close(),
  );
}

const format = z
  .enum(['text', 'json'])
  .optional()
  .describe('text (default) is what `pj` prints; json is what `pj … --json` prints');

// ---------------------------------------------------------------- ls

const lsInput = z.object({
  view: z
    .string()
    .optional()
    .describe('A saved view by name — see the `views` tool. The other arguments override it, as `pj ls --view` flags do'),
  filter: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe(
      'facet → any of these values. "(none)" matches absence; a leading "-" negates a value. ' +
        'A date or number facet takes its bucket names or a range such as ">2026-09-01"',
    ),
  group: z.array(z.string()).max(2).optional().describe('Up to two facets to group by: columns, then lanes'),
  sort: z.array(z.string()).optional().describe('e.g. ["updated:desc"]; facet:asc ranks by declared order'),
  q: z.string().optional().describe('Full-text filter'),
  focus: z.string().optional().describe('A note id to traverse from'),
  via: z.string().optional().describe('The reference facet to traverse from focus'),
  dir: z.enum(['out', 'in', 'both']).optional().describe('out follows references, in finds what refers here'),
  depth: z.number().int().optional(),
  show: z.array(z.string()).optional().describe('Facets printed beside each title; defaults to the view’s own'),
  format,
});

function ls(args: z.infer<typeof lsInput>, vault: Vault): string {
  const overrides: Overrides = {};
  for (const [facet, values] of Object.entries(args.filter ?? {})) overrides[`f.${facet}`] = values.join(',');
  if (args.group?.length) overrides.group = args.group.join(',');
  if (args.sort?.length) overrides.sort = args.sort.join(',');
  if (args.q) overrides.q = args.q;
  if (args.focus) overrides.focus = args.focus;
  if (args.via) overrides.via = args.via;
  if (args.dir) overrides.dir = args.dir;
  if (args.depth !== undefined) overrides.depth = String(args.depth);
  if (args.show?.length) overrides.show = args.show.join(',');

  const resolved = resolveListing(vault.root, args.view, overrides);
  if ('error' in resolved) throw new Error(`${resolved.error} — the views tool lists them`);
  const { spec, saved } = resolved;
  const { db, notes, facets, views } = indexed(vault.root);
  const payload = queryPayload(
    { facets, db, notes, views, jiraBase: jiraConfig(vault.root)?.url ?? null },
    spec,
    saved,
  );
  if (args.format === 'json') return JSON.stringify(payload);
  const head = saved ? `view ${saved.name}${saved.title ? ` — ${saved.title}` : ''}\n\n` : '';
  return head + renderListing(payload, spec, spec.show);
}

// ---------------------------------------------------------------- views

/**
 * Every saved view, the unlisted ones included and marked: `pj ls --view` takes
 * them all, and a rule hidden from the picker is still a question worth asking.
 */
function views(vault: Vault): string {
  const loaded = loadViewFiles(vault.root);
  if (!loaded.length) return 'no saved views';
  return loaded
    .map(({ name, spec }) => {
      const query = Object.entries(specToParams(spec))
        .filter(([k]) => k !== 'shape')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      const marks = [
        spec.unlisted ? 'unlisted' : '',
        spec.expect ? `rule: expect ${spec.expect}` : '',
        spec.lists?.length ? `lists: ${spec.lists.join(', ')}` : '',
      ].filter(Boolean);
      return (
        `${name} — ${spec.title ?? name} (${spec.shape})` +
        (marks.length ? ` [${marks.join('; ')}]` : '') +
        (query ? `\n    ${query}` : '')
      );
    })
    .join('\n');
}

// ---------------------------------------------------------------- search, context

const searchInput = z.object({
  query: z.string().min(1).describe('Words to find; prefix-matched, most relevant first'),
  limit: z.number().int().positive().optional().describe('Cap on results; none by default'),
});

function searchTool(args: z.infer<typeof searchInput>, vault: Vault): string {
  const q = ftsPrefixQuery(args.query);
  if (q === null) return `no searchable words in "${args.query}"`;
  const rows = search(indexed(vault.root).db, q, args.limit);
  return [...rows.map((r) => `${r.id.padEnd(34)} ${r.title}`), `\n${rows.length} match(es), most relevant first`].join('\n');
}

const contextInput = z.object({ id: z.string().min(1).describe('A note id'), format });

/**
 * A missing id offers the nearest matches rather than only refusing: a client
 * without a shell cannot run `pj search` to find the id it half-remembered.
 */
function context(args: z.infer<typeof contextInput>, vault: Vault): string {
  const ctx = noteContext(args.id, vault.root);
  if (!ctx) {
    const q = ftsPrefixQuery(args.id.replace(/-/g, ' '));
    const near = q ? search(indexed(vault.root).db, q, 5) : [];
    throw new Error(
      `no note with id "${args.id}"` + (near.length ? `. Did you mean: ${near.map((r) => r.id).join(', ')}` : ''),
    );
  }
  return args.format === 'json' ? JSON.stringify(ctx) : renderContext(ctx);
}

// ---------------------------------------------------------------- log, did

const logInput = z.object({
  since: z.string().optional().describe('Anything git accepts for --since; default "1 week ago"'),
});

function log(args: z.infer<typeof logInput>, vault: Vault): string {
  if (!isRepo(vault.root)) {
    throw new Error('this vault is not a git repository — log reads the history git already keeps');
  }
  return formatHistory(history(vault.root, args.since ?? '1 week ago'));
}

const didInput = z.object({
  day: z.string().optional().describe('today (default), yesterday, or YYYY-MM-DD — a local day'),
  only: z.array(z.enum(DID_SOURCES)).optional().describe('Restrict to these sources'),
  format,
});

async function didTool(args: z.infer<typeof didInput>, vault: Vault): Promise<string> {
  const day = parseDay(args.day);
  if ('error' in day) throw new Error(day.error);
  const report = await did(vault.root, day, args.only ?? []);
  return args.format === 'json' ? JSON.stringify(report) : renderDid(report);
}

// ---------------------------------------------------------------- status

const statusInput = z.object({
  issues: z.boolean().optional().describe('List every `pj check` issue rather than counting them'),
});

/**
 * `pj vaults`, `pj reindex` and `pj check` — validity and the rules — in one
 * answer: what a shell would run to find out whether the vault is healthy.
 */
function vaultStatus(args: z.infer<typeof statusInput>, vault: Vault): string {
  const { db, notes, facets, views: all } = indexed(vault.root);
  const c = counts(db, facets);
  const out = [`vault ${vault.name ?? '(unnamed)'} at ${vault.root}`, `${c.notes} note(s)`];
  for (const [k, v] of Object.entries(c)) if (k !== 'notes') out.push(`  ${k.padEnd(14)} ${v}`);

  const { unreadable, duplicates } = readAll(paths(vault.root).notes);
  const issues = [
    ...validate(notes, facets, vault.root, { unreadable, duplicates }),
    ...validateViews(loadViewFiles(vault.root), facets),
  ];
  const errors = issues.filter((i) => i.severity === 'error').length;
  out.push('', `check: ${errors} error(s), ${issues.length - errors} warning(s)`);
  if (args.issues && issues.length) out.push(formatIssues(issues, vault.root));

  const rules = runRules({ facets, db, notes, views: all });
  if (rules.length) {
    out.push('', 'rules (views declaring expect: empty):');
    for (const { name, ids } of rules) {
      out.push(`  ${ids.length ? 'BROKEN' : 'ok    '} ${name.padEnd(24)} ${ids.length || ''} ${ids.join(', ')}`.trimEnd());
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- propose

const facetMap = z.record(z.string(), z.array(z.string()));

const proposeInput = z.object({
  command: z.enum(['add', 'set', 'link']),
  id: z.string().optional().describe('set/link: the note. add: an explicit id instead of one derived from the title'),
  title: z.string().optional().describe('add: required. set: a new title'),
  facet: facetMap.optional().describe('Replace these facets; an empty list clears one'),
  add: facetMap.optional().describe('set: add these values'),
  remove: facetMap.optional().describe('set: remove these values'),
  links: z.array(z.string()).optional().describe('add/link: refs such as jira:PROJ-1, gh:pr:org/repo#2, https://…'),
  unlink: z.boolean().optional().describe('link: remove the refs instead of adding them'),
  body: z.string().optional().describe('add: the note body'),
});

/** Quote only what a shell would split or expand, so the common case reads plainly. */
const arg = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : shellQuote(s));

/**
 * The exact `pj` command for a change, checked by the gate that would run it —
 * and run by nobody here.
 *
 * Checked rather than merely printed, because the person reading a proposal in a
 * chat is deciding whether to run it: "this would be refused" belongs in front
 * of them before they paste it, not after. `checkFacets` is the write path's own
 * check, so the answer cannot drift from what `pj` would do.
 */
function propose(args: z.infer<typeof proposeInput>, vault: Vault): string {
  const { notes } = readAll(paths(vault.root).notes);
  const flags = (name: string, map: Record<string, string[]> | undefined) =>
    Object.entries(map ?? {}).map(([f, v]) => `--${name} ${arg(`${f}=${v.join(',')}`)}`);
  const words = ['pj', '--vault', arg(vault.name ?? vault.root), args.command];
  const findings: string[] = [];
  const gate = (id: string, facets: Record<string, string[]>) => {
    try {
      checkFacets(vault.root, id, facets, notes);
    } catch (err) {
      findings.push(`would be refused: ${(err as Error).message}`);
    }
  };
  // An axis `editFacets` reports as emptied is one the note will not carry.
  const describe = (facets: Record<string, string[]>) =>
    Object.entries(facets)
      .filter(([, v]) => v.length)
      .map(([k, v]) => `${k}=${v.join(',')}`)
      .join(' ') || '(no facets)';

  if (args.command === 'add') {
    if (!args.title?.trim()) throw new Error('add needs a title');
    const id = args.id ?? uniqueId(slugify(args.title), new Set(notes.keys()));
    if (args.id && notes.has(args.id)) findings.push(`would be refused: id "${args.id}" is already taken`);
    const facets = Object.fromEntries(Object.entries(args.facet ?? {}).filter(([, v]) => v.length));
    gate(id, facets);
    words.push(arg(args.title), ...(args.id ? ['--id', arg(args.id)] : []), ...flags('facet', facets));
    for (const l of args.links ?? []) words.push('--link', arg(l));
    if (args.body) words.push('--body', arg(args.body));
    findings.unshift(`would create ${id} with ${describe(facets)}`);
  } else {
    if (!args.id) throw new Error(`${args.command} needs an id`);
    const rec = notes.get(args.id);
    if (!rec) throw new Error(`no note with id "${args.id}"`);
    words.push(arg(args.id));

    if (args.command === 'set') {
      const ops: FacetOp[] = (['facet', 'add', 'remove'] as const).flatMap((op) =>
        Object.entries(args[op] ?? {}).map(([facet, values]) => ({ op, facet, values })),
      );
      if (!ops.length && !args.title) throw new Error('set needs a title or a facet change');
      if (args.title) words.push('--title', arg(args.title));
      words.push(...flags('facet', args.facet), ...flags('add', args.add), ...flags('remove', args.remove));
      const after = editFacets(rec.facets, ops);
      if (ops.length) gate(args.id, after);
      findings.unshift(`${args.id} now: ${describe(rec.facets)}`, `would become: ${describe(after)}`);
    } else {
      const refs = args.links ?? [];
      if (!refs.length) throw new Error('link needs at least one ref');
      const have = rec.links.map((l) => l.raw);
      words.push(...refs.map(arg));
      if (args.unlink) {
        words.push('--remove');
        const missing = refs.filter((r) => !have.includes(r));
        if (missing.length) findings.push(`would be refused: ${args.id} does not link ${missing.join(', ')}`);
      } else {
        const already = refs.filter((r) => have.includes(r));
        if (already.length) findings.push(`already linked, so a no-op for: ${already.join(', ')}`);
      }
    }
  }

  return [
    'Proposed, not applied. Nothing was written; the owner runs this, or approves a session with a shell running it:',
    '',
    `  ${words.join(' ')}`,
    '',
    ...findings,
  ].join('\n');
}

// ---------------------------------------------------------------- the table

export const TOOLS: Tool[] = [
  {
    name: 'ls',
    title: 'List notes',
    description:
      'List notes through a saved view and/or a query, exactly as `pj ls` does. ' +
      'The saved views are this vault’s own questions — the views tool lists them. ' +
      'Grouped output prints one section per group; each line is a note id and title, with the view’s facets in brackets.',
    input: lsInput,
    run: (a, v) => ls(lsInput.parse(a), v),
  },
  {
    name: 'views',
    title: 'Saved views',
    description: 'Every saved view: name, title, shape, its query, and whether it is a rule (`expect: empty`). Any name works as `ls` view.',
    input: z.object({}),
    run: (_a, v) => views(v),
  },
  {
    name: 'search',
    title: 'Search notes',
    description: 'Full-text search over titles and bodies, most relevant first, as `pj search` does. Returns ids for `context`.',
    input: searchInput,
    run: (a, v) => searchTool(searchInput.parse(a), v),
  },
  {
    name: 'context',
    title: 'Note context',
    description:
      'Everything known about one note, as `pj context` assembles it: facets, project chain, inherited repos and instructions, ' +
      'relations both ways, blockers, links with cached enrichment, and the body. The right first move for any question about a note.',
    input: contextInput,
    run: (a, v) => context(contextInput.parse(a), v),
  },
  {
    name: 'log',
    title: 'Vault history',
    description: 'What changed in the vault, read from git: status transitions, deadlines and creations, as `pj log` does.',
    input: logInput,
    run: (a, v) => log(logInput.parse(a), v),
  },
  {
    name: 'did',
    title: 'What was done on a day',
    description:
      'Your own traces on one local day — notes created, closed or moved, commits in the work repos, Claude sessions, ' +
      'and Jira activity you authored — as `pj did` reports them. Facts, not a summary.',
    input: didInput,
    openWorld: true,
    run: (a, v) => didTool(didInput.parse(a), v),
  },
  {
    name: 'vault_status',
    title: 'Vault status',
    description: 'The vault’s path, note and axis counts, `pj check` error and warning counts, and every rule view with what breaks it.',
    input: statusInput,
    run: (a, v) => vaultStatus(statusInput.parse(a), v),
  },
  {
    name: 'propose',
    title: 'Propose a change',
    description:
      'Draft an add, set or link as the exact `pj` command, checked against the vocabulary the write would be checked against. ' +
      'Never applies it: nothing reaches the vault without its owner running or approving the command. ' +
      'Show the command to the user rather than claiming the change was made.',
    input: proposeInput,
    run: (a, v) => propose(proposeInput.parse(a), v),
  },
];
