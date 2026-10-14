import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
import { checkFacets, fingerprintsOf, planAccept, planDecline } from '../server/mutate.ts';
import { loadViewFiles, loadViews } from '../server/views.ts';
import { jiraConfig } from '../sources/jira.ts';
import { queryPayload, runRules } from '../view/payload.ts';
import { renderListing, resolveListing, type Overrides } from '../view/listing.ts';
import { specToParams } from '../view/spec.ts';
import { freshNoteContext, noteContext, renderContext } from '../agent/context.ts';
import { formatHistory, history, isRepo } from '../agent/history.ts';
import { shellQuote } from '../agent/worktree.ts';
import { parseDay } from '../did/day.ts';
import { DID_SOURCES, did, renderDid } from '../did/run.ts';
import { channelNames, statusOf } from '../intake/run.ts';
import type { Note } from '../schema/types.ts';
import { ago } from '../sources/run.ts';

/**
 * What the MCP server can be asked, one entry per tool.
 *
 * Every tool here is a `pj` read run in-process — the same module the command
 * calls, so a chat and a shell asking the same question get the same answer
 * (C9). None writes a note. The vault's rule is that nothing lands in it without
 * its owner's say-so, and a tool call is somebody else's say-so; so the one tool
 * that is *about* a write, `propose`, prints the commands and runs nothing.
 * `memory` reads the agent's `memory/` the same way: read, never written
 * (decision 17 of the day loop's design).
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
    .describe('A saved view by name — `vault_status` lists them. The other arguments override it, as `pj ls --view` flags do'),
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
  if ('error' in resolved) throw new Error(`${resolved.error} — vault_status lists them`);
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
 * Part of `vault_status`, which was already naming the rules among them.
 */
function views(vault: Vault): string[] {
  return loadViewFiles(vault.root)
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
    });
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

const contextInput = z.object({
  id: z.string().min(1).describe('A note id'),
  fresh: z
    .boolean()
    .optional()
    .describe('Re-resolve every link first — Jira, GitHub, docs — as `pj context --fresh` does: the live state, not the cache'),
  format,
});

/**
 * A missing id offers the nearest matches rather than only refusing: a client
 * without a shell cannot run `pj search` to find the id it half-remembered.
 */
async function context(args: z.infer<typeof contextInput>, vault: Vault): Promise<string> {
  const ctx = args.fresh ? await freshNoteContext(args.id, vault.root) : noteContext(args.id, vault.root);
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
 * `pj vaults`, `pj reindex`, `pj check` and `pj intake status` in one answer:
 * what a shell would run to find out whether the vault is healthy, and whether
 * the world it was last told about is recent enough to plan on.
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

  // Being in `inbox/` is what makes a note a card (the layout's rule), so the
  // count is of files there, not of a facet.
  const inbox = resolve(paths(vault.root).places.inbox) + sep;
  const cards = [...notes.values()].filter((n) => resolve(n.file).startsWith(inbox)).length;
  out.push('', cards ? `inbox: ${cards} card(s) — ls with filter intake: [unjudged] lists them` : 'inbox: empty');
  out.push(...intakeStatus(vault.root));

  const saved = views(vault);
  out.push('', saved.length ? 'views (any name works as ls view):' : 'no saved views', ...saved.map((v) => `  ${v}`));
  return out.join('\n');
}

/**
 * Each channel's last tick and cursor, from the store `pj intake status` reads.
 *
 * A vault that has never ticked has no store, and asking does not make one: the
 * cursors are the one thing under `.projector/` that is not derived, and their
 * file should appear when a tick writes it, not when somebody looked.
 */
function intakeStatus(root: string): string[] {
  if (!existsSync(paths(root).intakeDb)) return ['intake: never ticked', ...channelNames().map((c) => `  ${c.padEnd(10)} never`)];
  const channels = statusOf(root);
  const ticks = channels.map((c) => c.ranAt).filter((t): t is string => !!t && Number.isFinite(Date.parse(t)));
  const newest = ticks.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return [
    newest ? `intake: last tick ${newest} (${ago(newest)})` : 'intake: never ticked',
    ...channels.map(
      (c) =>
        `  ${c.channel.padEnd(10)} ${c.ranAt ? `ran ${c.ranAt} (${ago(c.ranAt)})` : 'never'}` +
        (c.cursor ? `  cursor ${c.cursor}` : ''),
    ),
  ];
}

// ---------------------------------------------------------------- memory

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MEMORY_PARTS = ['agents', 'theories', 'patterns'] as const;

const memoryInput = z.object({
  part: z
    .enum(MEMORY_PARTS)
    .optional()
    .describe('agents: memory/AGENTS.md · theories: one day of working memory · patterns: what held up. Default: all three'),
  day: z.string().regex(DAY, 'a day is YYYY-MM-DD').optional().describe('Which theories file, YYYY-MM-DD; default the newest'),
});

/** `.md` files directly in a folder, by name. Not symlinks, not deeper: nothing here can lead out of `memory/`. */
function markdownIn(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name)
    .sort();
}

/**
 * The scientist's own files, read and never written (decision 17 of the day
 * loop's design): so a client with no file access can still run it. A vault it
 * has not run in has no `memory/`, which is a state, not a failure.
 *
 * Nothing the caller passes becomes a path: `part` is one of three names and
 * `day` a date, checked by the schema before this runs.
 */
function memory(args: z.infer<typeof memoryInput>, vault: Vault): string {
  const dir = paths(vault.root).memory;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return 'no memory/ in this vault — the scientist (pj-day) has not written anything here yet';
  }
  const out: string[] = [];
  const section = (rel: string, file: string, lead = '') =>
    out.push(`## memory/${rel}\n\n${lead}${readFileSync(file, 'utf8').trimEnd()}`);

  for (const part of args.part ? [args.part] : MEMORY_PARTS) {
    if (part === 'agents') {
      const file = join(dir, 'AGENTS.md');
      if (existsSync(file) && lstatSync(file).isFile()) section('AGENTS.md', file);
    } else if (part === 'theories') {
      const days = markdownIn(join(dir, 'theories'))
        .map((f) => f.slice(0, -3))
        .filter((d) => DAY.test(d))
        .reverse();
      if (args.day && !days.includes(args.day)) {
        throw new Error(`no memory/theories/${args.day}.md — have ${days.join(', ') || 'none'}`);
      }
      const day = args.day ?? days[0];
      if (!day) continue;
      const others = days.filter((d) => d !== day);
      const lead = others.length
        ? `_other days: ${others.slice(0, 10).join(', ')}${others.length > 10 ? ` and ${others.length - 10} older` : ''}_\n\n`
        : '';
      section(`theories/${day}.md`, join(dir, 'theories', `${day}.md`), lead);
    } else {
      for (const f of markdownIn(join(dir, 'patterns'))) section(`patterns/${f}`, join(dir, 'patterns', f));
    }
  }
  return out.length ? out.join('\n\n') : `memory/ holds nothing${args.part ? ` under ${args.part}` : ''} yet`;
}

// ---------------------------------------------------------------- propose

const facetMap = z.record(z.string(), z.array(z.string()));

const VERBS = ['add', 'set', 'link', 'accept', 'decline'] as const;

const proposalInput = z.object({
  verb: z.enum(VERBS),
  id: z
    .string()
    .optional()
    .describe(
      'set/link: the note. accept: the inbox card. decline: the card, or a fingerprint (<channel>:<ref>) no card holds. ' +
        'add: an explicit id instead of one derived from the title',
    ),
  title: z.string().optional().describe('add: required. set: a new title. decline: names a bare fingerprint in the declined pile'),
  facet: facetMap.optional().describe('Replace these facets; an empty list clears one'),
  add: facetMap.optional().describe('set: add these values'),
  remove: facetMap.optional().describe('set: remove these values'),
  links: z.array(z.string()).optional().describe('add/link: refs such as jira:PROJ-1, gh:pr:org/repo#2, https://…'),
  unlink: z.boolean().optional().describe('link: remove the refs instead of adding them'),
  body: z.string().optional().describe('add: the note body'),
  only: z.array(z.string()).optional().describe('accept, a card that extends a note: take only these of the axes it proposes'),
  reason: z.string().optional().describe('decline: required — why not; the intake judge learns from it'),
});

const proposeInput = z.object({
  commands: z.array(proposalInput).min(1).describe('The changes, in the order they would run'),
});

type Proposal = z.infer<typeof proposalInput>;

/** Quote only what a shell would split or expand, so the common case reads plainly. */
const arg = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : shellQuote(s));

/** One entry drafted: its command, what it would do, and why it would not run. */
interface Draft {
  command: string | null;
  says: string[];
  refused: string[];
}

/** What the batch has drafted so far, which a later entry may collide with. */
interface Batch {
  /** Ids an earlier `add` would create, so a second one derives another. */
  added: Set<string>;
  /** Cards an earlier entry already judges: card id → "entry N already accepts". */
  judged: Map<string, string>;
}

/**
 * The exact `pj` commands for a batch of changes, each checked by the gate that
 * would run it — and run by nobody here.
 *
 * Checked rather than merely printed, because the person reading a proposal in a
 * chat is deciding whether to run it: "this would be refused" belongs in front
 * of them before they paste it, not after. `checkFacets`, `planAccept` and
 * `planDecline` are the write path's own checks, so the answer cannot drift from
 * what `pj` would do (C9).
 *
 * A batch because a day's stop is one approval, not ten. Every entry is checked
 * against the vault as it is now, and an entry that would be refused is reported
 * by its number with its reason and left out of the block — so the block is
 * exactly what runs, and nothing the caller asked for disappears without a word.
 */
function propose(args: z.infer<typeof proposeInput>, vault: Vault): string {
  const { notes } = readAll(paths(vault.root).notes);
  const batch: Batch = { added: new Set(), judged: new Map() };
  const drafts = args.commands.map((p, i) => {
    const label = `${i + 1}. ${p.verb}${p.id && p.verb !== 'add' ? ` ${p.id}` : ''}`;
    try {
      return { label, ...draft(p, i + 1, vault, notes, batch) };
    } catch (err) {
      return { label, command: null, says: [], refused: [(err as Error).message] };
    }
  });

  const runs = drafts.filter((d) => !d.refused.length && d.command);
  const refused = drafts.length - runs.length;
  const out = [
    'Proposed, not applied. Nothing was written; the owner runs these, or approves a session with a shell running them — ' +
      `${runs.length} to run${refused ? `, ${refused} refused` : ''}:`,
  ];
  if (runs.length) out.push('', ...runs.map((d) => `  ${d.command}`));
  for (const d of drafts) {
    out.push('');
    if (d.refused.length) {
      out.push(`${d.label} — refused: ${d.refused.join('; ')}`, ...(d.command ? [`   not run: ${d.command}`] : []));
    } else {
      out.push(d.label, ...d.says.map((s) => `   ${s}`));
    }
  }
  return out.join('\n');
}

function draft(p: Proposal, n: number, vault: Vault, notes: Map<string, Note>, batch: Batch): Draft {
  const flags = (name: string, map: Record<string, string[]> | undefined) =>
    Object.entries(map ?? {}).map(([f, v]) => `--${name} ${arg(`${f}=${v.join(',')}`)}`);
  const words = ['pj', '--vault', arg(vault.name ?? vault.root), p.verb];
  const says: string[] = [];
  const refused: string[] = [];
  const gate = (id: string, facets: Record<string, string[]>) => {
    try {
      checkFacets(vault.root, id, facets, notes);
    } catch (err) {
      refused.push((err as Error).message);
    }
  };
  // A card judged twice in one batch: the second would find it gone.
  const judge = (id: string, verb: string) => {
    const earlier = batch.judged.get(id);
    if (earlier) throw new Error(`${earlier} ${id}`);
    batch.judged.set(id, `entry ${n} already ${verb}s`);
  };
  // An axis `editFacets` reports as emptied is one the note will not carry.
  const describe = (facets: Record<string, string[]>) =>
    Object.entries(facets)
      .filter(([, v]) => v.length)
      .map(([k, v]) => `${k}=${v.join(',')}`)
      .join(' ') || '(no facets)';
  const done = () => ({ command: words.join(' '), says, refused });

  if (p.verb === 'add') {
    if (!p.title?.trim()) throw new Error('add needs a title');
    const id = p.id ?? uniqueId(slugify(p.title), new Set([...notes.keys(), ...batch.added]));
    if (p.id && (notes.has(p.id) || batch.added.has(p.id))) refused.push(`id "${p.id}" is already taken`);
    const facets = Object.fromEntries(Object.entries(p.facet ?? {}).filter(([, v]) => v.length));
    gate(id, facets);
    words.push(arg(p.title), ...(p.id ? ['--id', arg(p.id)] : []), ...flags('facet', facets));
    for (const l of p.links ?? []) words.push('--link', arg(l));
    if (p.body) words.push('--body', arg(p.body));
    says.push(`would create ${id} with ${describe(facets)}`);
    if (!refused.length) batch.added.add(id);
    return done();
  }

  if (!p.id) throw new Error(`${p.verb} needs an id`);

  if (p.verb === 'accept') {
    const [plan] = planAccept(vault.root, [p.id], p.only?.length ? { only: p.only } : {});
    judge(plan!.id, 'accept');
    words.push(arg(p.id), ...(p.only?.length ? ['--only', arg(p.only.join(','))] : []));
    if (!plan!.into) {
      says.push(`would file ${p.id} as its own note in ${relative(vault.root, dirname(plan!.to!))}/`);
    } else {
      const target = notes.get(plan!.into)!;
      const took = Object.keys(plan!.facets);
      says.push(
        `would fold ${p.id} into ${plan!.into}, taking ${took.length ? took.join(', ') : 'no axis'} — its body, links and fingerprint go too`,
        `${plan!.into} now: ${describe(target.facets)}`,
        `would become: ${describe({ ...target.facets, ...plan!.facets })}`,
      );
    }
    return done();
  }

  if (p.verb === 'decline') {
    const [plan] = planDecline(vault.root, [p.id], { reason: p.reason ?? '' });
    words.push(arg(p.id), '--reason', arg(p.reason!.trim()), ...(p.title ? ['--title', arg(p.title)] : []));
    if ('fingerprint' in plan!) {
      says.push(`would record ${plan.fingerprint} as declined; no card holds it`);
    } else {
      judge(plan!.card.id, 'decline');
      const fps = fingerprintsOf(plan!.card);
      says.push(
        `would remove the card${plan!.card.id === p.id ? '' : ` ${plan!.card.id}`} and ` +
          (fps.length ? `record ${fps.join(', ')} as declined` : 'record nothing: it has no fingerprint'),
      );
    }
    return done();
  }

  const rec = notes.get(p.id);
  if (!rec) throw new Error(`no note with id "${p.id}"`);
  words.push(arg(p.id));

  if (p.verb === 'set') {
    const ops: FacetOp[] = (['facet', 'add', 'remove'] as const).flatMap((op) =>
      Object.entries(p[op] ?? {}).map(([facet, values]) => ({ op, facet, values })),
    );
    if (!ops.length && !p.title) throw new Error('set needs a title or a facet change');
    if (p.title) words.push('--title', arg(p.title));
    words.push(...flags('facet', p.facet), ...flags('add', p.add), ...flags('remove', p.remove));
    const after = editFacets(rec.facets, ops);
    if (ops.length) gate(p.id, after);
    says.push(`${p.id} now: ${describe(rec.facets)}`, `would become: ${describe(after)}`);
    return done();
  }

  const refs = p.links ?? [];
  if (!refs.length) throw new Error('link needs at least one ref');
  const have = rec.links.map((l) => l.raw);
  words.push(...refs.map(arg));
  if (p.unlink) {
    words.push('--remove');
    const missing = refs.filter((r) => !have.includes(r));
    if (missing.length) refused.push(`${p.id} does not link ${missing.join(', ')}`);
  } else {
    const already = refs.filter((r) => have.includes(r));
    if (already.length) says.push(`already linked, so a no-op for: ${already.join(', ')}`);
  }
  return done();
}

// ---------------------------------------------------------------- the table

export const TOOLS: Tool[] = [
  {
    name: 'ls',
    title: 'List notes',
    description:
      'List notes through a saved view and/or a query, exactly as `pj ls` does. ' +
      'The saved views are this vault’s own questions — vault_status lists them. ' +
      'Grouped output prints one section per group; each line is a note id and title, with the view’s facets in brackets.',
    input: lsInput,
    run: (a, v) => ls(lsInput.parse(a), v),
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
      'relations both ways, blockers, links with cached enrichment, and the body. The right first move for any question about a note. ' +
      '`fresh` re-resolves the links first, for a claim the note makes about something outside it.',
    input: contextInput,
    openWorld: true,
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
    description:
      'The vault’s path, note and axis counts, `pj check` error and warning counts, every rule view with what breaks it, ' +
      'how many cards wait in the inbox, each intake channel’s last tick and cursor — whether what the vault knows of the world is recent — ' +
      'and every saved view with its query (any name works as `ls` view).',
    input: statusInput,
    run: (a, v) => vaultStatus(statusInput.parse(a), v),
  },
  {
    name: 'memory',
    title: 'The agent’s memory',
    description:
      'Read the vault’s memory/: AGENTS.md (how the planning agent has decided to investigate), one day of theories ' +
      '(working memory; the newest unless `day` names one) and the patterns (what held up). The agent’s own files, not notes; ' +
      'read-only here. A vault with no memory/ answers so, and that is not an error.',
    input: memoryInput,
    run: (a, v) => memory(memoryInput.parse(a), v),
  },
  {
    name: 'propose',
    title: 'Propose changes',
    description:
      'Draft a batch of changes — add, set, link, and accept or decline an inbox card — as the exact `pj` commands, ' +
      'each checked by the gate the write would meet. One that would be refused is reported by its number with why, and left out of the block. ' +
      'Never applies anything: nothing reaches the vault without its owner running or approving the commands. ' +
      'Show them to the user rather than claiming the change was made.',
    input: proposeInput,
    run: (a, v) => propose(proposeInput.parse(a), v),
  },
];
