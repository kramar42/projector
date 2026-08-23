/**
 * Generates a vault that carries every state the app can draw.
 *
 * The work vault is real work, so it only exercises the states real work
 * happens to produce. That is how `.chip.is-overdue` shipped with its text the
 * same colour as its background: no record carries a `due` date, so the rule had
 * never rendered once. A mechanism with no data behind it is not tested by
 * looking at the app — it is invisible there.
 *
 * So this writes the opposite of a real vault: every declared facet value, both
 * ends of every bucket, a blocking chain and a chain whose blocker is finished,
 * a link of every kind including two that cannot resolve, a project that owns
 * nothing, and a record carrying nothing but the two required fields.
 *
 * Dates are computed from today, so the bucket columns are never empty and the
 * fixture cannot go stale. That is also why the vault is generated rather than
 * committed: a committed one would be a set of hardcoded dates that all read
 * `overdue` within a month, which is the same failure this exists to prevent.
 *
 *   node fixtures/states.mjs [<out-dir>]      # default: fixtures/states
 *
 * Then register it and open it — the server only opens a vault on the list:
 *
 *   node src/cli/pj.ts vaults add fixtures/states --name states
 *   node src/cli/pj.ts --vault fixtures/states check
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'states'));

// ---------------------------------------------------------------- dates

const DAY = 86_400_000;
const today = new Date();
const iso = (offsetDays) => new Date(today.getTime() + offsetDays * DAY).toISOString().slice(0, 10);

/**
 * `due` buckets are `{ overdue: -1, today: 0, week: 7 }` with everything past the
 * last one falling to `later`, measured in days from today. One date per bucket,
 * placed mid-bucket rather than on a boundary so a timezone rollover cannot move
 * one into its neighbour.
 */
const DUE = { overdue: iso(-9), today: iso(0), week: iso(3), later: iso(45) };

/** `staleness` is `updated` against today: week ≤7, month ≤31, then older. */
const UPDATED = { fresh: iso(-1), week: iso(-4), month: iso(-20), older: iso(-400) };

// ---------------------------------------------------------------- vocabulary

/**
 * A deliberate copy of the work vault's vocabulary, because `work/` is
 * gitignored and the fixture has to stand alone in a fresh clone.
 *
 * The obligation this creates is the point: if a real facet gains a value, add it
 * here too. A value declared in one vocabulary and absent from the other is a
 * state nothing renders, which is the class of bug this vault exists to catch.
 */
const FACETS = `# Fixture vocabulary — a copy of the work vault's, so this vault stands alone.
# Every value declared here is carried by at least one card in cards/. If you add
# a value and no card takes it, the fixture has stopped doing its job.

status:
  label: Status
  values: [planning, active, frozen, done, archived]
  open: false
  single: true

priority:
  label: Priority
  values: [now, month, backlog, someday]
  open: false
  single: true

due:
  label: Due
  type: date
  single: true
  buckets: { overdue: -1, today: 0, week: 7 }
  overflow: later

waiting_on:
  label: Waiting on
  values: [person-a, person-b, person-c, person-d, person-e, person-g, person-f]
  open: true

energy:
  label: Energy
  values: [deep, shallow, decide, delegate]
  open: false
  single: true

domain:
  label: Domain
  values: [eventing, identity, master-data, workflow, observability, lifecycle]
  open: true

tech:
  label: Tech
  values: [k8s, aws, github, kafka, keycloak, quarkus, temporal, mongodb, devops]
  open: true

layer:
  label: Layer
  values: [layer-1, layer-2, layer-3, layer-4, layer-5]
  open: false

source:
  label: Source
  values: [brain, trello, slack, jira, gmail, gdocs, git, claude]
  open: true

owner:
  label: Owner
  values: []
  open: true
  single: true

parent:
  label: Part of
  type: ref
  single: true

blocks:
  label: Blocks
  type: ref
`;

// ---------------------------------------------------------------- cards

/**
 * Each entry names the state it exists to render, and the body says so on screen
 * — so the fixture explains itself when you open the panel rather than needing a
 * second document to read alongside it.
 */
const CARDS = [
  // -------------------------------------------------- projects and roll-ups
  {
    id: 'platform',
    title: 'Platform',
    facets: { status: ['active'], priority: ['now'], domain: ['identity'], layer: ['layer-2'] },
    updated: UPDATED.fresh,
    project: {
      repos: [{ path: '../services', base: 'main' }, { path: '~/code/infra', base: 'dev' }],
      jira: 'PROJ',
      branch: 'plat/{card}',
      instructions:
        '- Never change a realm in eu-prod without a ticket and a rollback plan.\n' +
        '- This is the outermost project, so this line should read *first* in an inherited chain.\n',
    },
    body:
      'Renders: the `▣` project mark, a member count, a `project:` block in the panel,\n' +
      'and the outer end of an inheritance chain. `identity` is a member *and* a project,\n' +
      'so a table row here reads `direct / total` with total larger than direct.\n',
  },
  {
    id: 'identity',
    title: 'Identity and access',
    facets: {
      status: ['active'],
      priority: ['now'],
      project: ['platform'],
      tech: ['keycloak'],
      layer: ['layer-2'],
    },
    updated: UPDATED.fresh,
    project: {
      repos: [{ path: '../identity', base: 'main' }],
      instructions: '- A nested project: this line should read *after* the platform one.\n',
    },
    body:
      'Renders: a project that is itself a member of another project — so `▣` with a\n' +
      'status chip, repo union across two levels, and instructions concatenated\n' +
      'outermost-first.\n',
  },
  {
    id: 'owns-nothing',
    title: 'A project with no members',
    facets: { status: ['planning'], priority: ['someday'] },
    updated: UPDATED.month,
    project: { jira: 'EMPTY' },
    body:
      'Renders: the empty roll-up. A table row should read `0 / 0` and the progress bar\n' +
      'should not imply completion. This is the state a project has for the five minutes\n' +
      'after you create it, and the one nothing in a real vault stays in.\n',
  },

  // -------------------------------------------------- record marks
  {
    id: 'ideas',
    title: 'Ideas worth keeping',
    facets: {},
    updated: UPDATED.week,
    body:
      'Renders: the `○` node mark and a child count. No `status`, so it is not work and\n' +
      'stays off every status-filtered board — and something names it as `parent`, which\n' +
      'is the whole of what makes it a container.\n',
  },
  {
    id: 'bare',
    title: 'Nothing but the two required fields',
    facets: {},
    body:
      'Renders: the minimal face — `·`, a title, no chips, no meta line, no excerpt beyond\n' +
      'this. Also `triage: needs-project,needs-priority,needs-status` all at once, and\n' +
      '`staleness: undated`, since nothing wrote `updated`.\n',
  },

  // -------------------------------------------------- due buckets
  {
    id: 'due-overdue',
    title: 'A deadline that has passed',
    facets: { status: ['active'], priority: ['now'], due: [DUE.overdue], project: ['platform'] },
    updated: UPDATED.fresh,
    body:
      'Renders: the filled `is-overdue` chip. This is the rule that shipped with\n' +
      '`color: var(--ink)` on `background: var(--bad)` — 1.92:1 in light, 1.94:1 in dark —\n' +
      'and went unseen for as long as it did because no record in the work vault carries a\n' +
      '`due` date. The chip shows the date and *wears* the bucket.\n',
  },
  {
    id: 'due-today',
    title: 'A deadline landing today',
    facets: { status: ['active'], priority: ['now'], due: [DUE.today], energy: ['decide'] },
    updated: UPDATED.fresh,
    body:
      'Renders: the filled `is-today` chip, which was the worse of the two at 1.03:1 in\n' +
      'dark — `#dddddd` text on a `#dfdf87` background is text you cannot see at all.\n',
  },
  {
    id: 'due-week',
    title: 'A deadline inside the week',
    facets: { status: ['planning'], priority: ['month'], due: [DUE.week], project: ['identity'] },
    updated: UPDATED.week,
    body: 'Renders: the `week` bucket — an ordinary unfilled chip, since only the two nearest buckets colour themselves.\n',
  },
  {
    id: 'due-later',
    title: 'A deadline past every bucket',
    facets: { status: ['planning'], priority: ['backlog'], due: [DUE.later] },
    updated: UPDATED.month,
    body: 'Renders: `overflow: later` — the bucket for everything past the last declared bound.\n',
  },

  // -------------------------------------------------- blocking
  {
    id: 'blocker-open',
    title: 'An unfinished blocker',
    facets: { status: ['active'], priority: ['now'], blocks: ['blocked-once'], energy: ['deep'] },
    updated: UPDATED.fresh,
    body:
      'Renders: the `unblocks` glyph in the accent, and a transitive count — finishing this\n' +
      'reaches `blocked-once` and `blocked-twice` both, since the closure is uncapped.\n',
  },
  {
    id: 'blocked-once',
    title: 'Blocked by something unfinished',
    facets: { status: ['planning'], priority: ['now'], blocks: ['blocked-twice'], project: ['platform'] },
    updated: UPDATED.week,
    body:
      'Renders: the 3px `--bad` left border, `blocked` on the derived axis, and a blocker\n' +
      'list in the panel. Also blocks something itself, so it is both ends at once.\n',
  },
  {
    id: 'blocked-twice',
    title: 'Blocked two steps back',
    facets: { status: ['planning'], priority: ['month'], project: ['platform'] },
    updated: UPDATED.week,
    body: 'Renders: the far end of a chain. Directly blocked by one record, transitively by two.\n',
  },
  {
    id: 'blocker-done',
    title: 'A blocker that is finished',
    facets: { status: ['done'], priority: ['month'], blocks: ['clear-despite-blocker'] },
    updated: UPDATED.month,
    body:
      'Renders: `status: done`, and the *absence* of an effect. A finished blocker blocks\n' +
      'nothing, so its target must read `clear` — the one rule in `isDone` that a naive\n' +
      'implementation gets wrong by counting edges instead of reading them.\n',
  },
  {
    id: 'clear-despite-blocker',
    title: 'Named as blocked, but by something finished',
    facets: { status: ['active'], priority: ['now'], tech: ['kafka'] },
    updated: UPDATED.fresh,
    body:
      'Renders: no left border and `blocked: clear`, despite carrying an inbound `blocks`\n' +
      'edge. If this one draws a red border, `isDone` is being ignored somewhere.\n',
  },
  {
    id: 'waiting-on-someone',
    title: 'Waiting on a person',
    facets: { status: ['active'], priority: ['now'], waiting_on: ['person-a', 'person-b'], domain: ['workflow'] },
    updated: UPDATED.week,
    body:
      'Renders: red `waiting_on` chips and `blocked: waiting` — the third value on that\n' +
      'axis, computed from a non-empty facet rather than from an edge.\n',
  },

  // -------------------------------------------------- chip density
  {
    id: 'every-facet',
    title: 'A card carrying every axis at once',
    facets: {
      priority: ['now'],
      status: ['active'],
      due: [DUE.week],
      energy: ['deep'],
      owner: ['oleksii'],
      waiting_on: ['person-c'],
      domain: ['eventing', 'observability'],
      source: ['slack'],
      tech: ['k8s', 'kafka', 'temporal'],
      layer: ['layer-3'],
      project: ['platform', 'identity'],
      parent: ['ideas'],
    },
    updated: UPDATED.fresh,
    body:
      'Renders: fourteen chips in one row — the `--chip-tint` dilution test. Light mode\n' +
      'mixes each fill 42% toward the surface precisely so this card is legible; at full\n' +
      "strength xoria's light shades stack into noise. If light mode looks loud here, the\n" +
      'tint has been bypassed somewhere.\n\n' +
      'Also the only card carrying `owner`, which is declared in the vocabulary and used\n' +
      'nowhere in the real vault.\n',
  },
  {
    id: 'hints-only',
    title: 'Only the hueless facets',
    facets: { status: ['planning'], energy: ['shallow'], source: ['trello'] },
    parentOf: 'ideas',
    updated: UPDATED.month,
    body:
      'Renders: `energy` italic and `source` muted — both transparent, both `--ink-3`, no\n' +
      'hue. A facet that is a hint rather than an identity is supposed to recede, and this\n' +
      'is the card that shows whether it does.\n',
  },

  // -------------------------------------------------- links
  {
    id: 'every-link-kind',
    title: 'One link of every kind',
    facets: { status: ['active'], priority: ['month'], project: ['identity'], source: ['jira'] },
    updated: UPDATED.fresh,
    links: [
      'jira:PROJ-303',
      'gh:pr:Acme/platform#412',
      'gh:branch:Acme/platform@main',
      'gh:commit:Acme/platform@0000000000000000000000000000000000000000',
      'claude:00000000-0000-4000-8000-000000000000',
      'doc:notes/resolves.md',
      'doc:notes/absent.md',
      // A permalink, because that is the only shape a slack *link* takes in the
      // real vault — all nineteen of them. The `channel/ts` pair appears there
      // fifteen times and every one is a `source_fingerprint`, which is a dedup
      // key and never something you click. A fixture carrying a shape the app
      // never sees is worse than one missing a shape it does.
      'slack:https://acme.slack.com/archives/C01234567/p1700000000000100',
      'https://example.com/a/very/long/path/that/should/be/ellipsised/well/before/here',
    ],
    body:
      'Renders: every `linked` pseudo-facet value, and the two failure paths that matter —\n' +
      '`doc:notes/absent.md` points at nothing, and the `jira`, `gh` and `claude` refs\n' +
      'cannot resolve without credentials. Each should say why *once* and stay cached,\n' +
      'not retry on every render. The bare URL is long on purpose: the label ellipsises\n' +
      'at 130px.\n\n' +
      'Every kind here except `claude` and `doc` is clickable with no fetcher having\n' +
      'run — a fetcher adds a title and a status, never the ability to click. Those two\n' +
      'have nowhere on the web to go: a session on this machine, and a file in the vault.\n',
  },

  // -------------------------------------------------- text limits
  {
    id: 'long-title',
    title:
      'A title long enough to wrap three times in a 292px column, ending in an unbroken token: ' +
      'PROJECTOR_JIRA_TOKEN_ROTATION_RUNBOOK_2026_Q3_FINAL_v4',
    facets: { status: ['active'], priority: ['backlog'], tech: ['devops'], project: ['platform'] },
    updated: UPDATED.week,
    body:
      'Renders: `overflow-wrap: anywhere` on the title, and the two-line clamp on the\n' +
      'excerpt below — which this paragraph exceeds deliberately, so the clamp has\n' +
      'something to cut. On a canvas node the title clamps to two lines as well, because a\n' +
      "node's height is declared to React Flow and the content is fitted to it rather than\n" +
      'allowed to push the box out of shape.\n',
  },
  {
    id: 'unicode-title',
    title: 'Ünïcode, 日本語, and an emoji 🚀 beside the record mark',
    facets: { status: ['planning'], priority: ['someday'], domain: ['master-data'] },
    updated: UPDATED.month,
    body:
      'Renders: the record mark next to text whose ink sits nowhere near where lowercase\n' +
      'latin sits. The mark is baseline-aligned at `0.8em` with a per-glyph nudge measured\n' +
      'against lowercase latin, so this is where that correction is least flattered.\n',
  },
  {
    id: 'checklist',
    title: 'A body with a task list',
    facets: { status: ['active'], priority: ['now'], project: ['identity'], parent: ['ideas'] },
    updated: UPDATED.fresh,
    body:
      'Renders: the progress bar — 44px track, `--ok` fill, tabular number. The app counts\n' +
      'these and never rewrites them.\n\n' +
      '- [x] Declare the vocabulary\n' +
      '- [x] Write the cards\n' +
      '- [x] Compute the dates from today\n' +
      '- [ ] Screenshot both themes\n' +
      '- [ ] Fix whatever that shows\n',
  },

  // -------------------------------------------------- triage and (none)
  {
    id: 'needs-priority',
    title: 'Has a status, no priority',
    facets: { status: ['active'], project: ['platform'], tech: ['aws'] },
    updated: UPDATED.week,
    body:
      'Renders: the dashed `(none)` column on a priority board at 0.72 opacity, and\n' +
      '`triage: needs-priority`. Dashed means the container exists and the value does not.\n',
  },
  {
    id: 'needs-project',
    title: 'Has everything except a project',
    facets: { status: ['planning'], priority: ['month'], energy: ['delegate'], domain: ['lifecycle'] },
    updated: UPDATED.week,
    body: 'Renders: `triage: needs-project`, and `(none)` on a project board.\n',
  },
  {
    id: 'needs-status',
    title: 'Has a priority, no status',
    facets: { priority: ['someday'], project: ['platform'], parent: ['ideas'] },
    updated: UPDATED.month,
    body:
      'Renders: `triage: needs-status` — and, because a record is work only by carrying a\n' +
      'status, this one is filtered off every status-filtered board while still being a\n' +
      'member of a project.\n',
  },

  // -------------------------------------------------- lifecycle tail
  {
    id: 'frozen-work',
    title: 'Frozen',
    facets: { status: ['frozen'], priority: ['backlog'], project: ['platform'], layer: ['layer-4'] },
    updated: UPDATED.older,
    body: 'Renders: `status: frozen`, and `staleness: older` — nothing has touched it in over a year.\n',
  },
  {
    id: 'archived-work',
    title: 'Archived rather than deleted',
    facets: { status: ['archived'], priority: ['someday'], source: ['claude'] },
    updated: UPDATED.older,
    source_fingerprint: 'claude:00000000-0000-4000-8000-000000000000',
    body:
      'Renders: `status: archived`, the fifth lifecycle value, and a card carrying a\n' +
      '`source_fingerprint` — which is why a rejected candidate is archived instead of\n' +
      'deleted. Deleting it destroys the fingerprint and the next sweep recreates it.\n',
  },
  {
    id: 'done-work',
    title: 'Finished',
    facets: { status: ['done'], priority: ['month'], project: ['identity'], energy: ['shallow'] },
    updated: UPDATED.month,
    body: 'Renders: `status: done`, and a member that counts toward a roll-up as complete.\n',
  },
];

/** `ideas` needs children to be a container; these name it as parent. */
const PARENTS = {
  'hints-only': 'ideas',
  'unicode-title': 'ideas',
  'due-later': 'ideas',
};

// ---------------------------------------------------------------- views

/**
 * One view per shape, plus one per state that only a particular query reveals.
 * A state nothing puts on screen is not covered, however carefully its card was
 * written.
 */
const VIEWS = {
  home: `# Board by priority — reaches the dashed \`(none)\` column, since two cards carry no priority.
shape: board
title: Home
groupBy: [priority]
sort: [updated:desc]
uncategorised: end
show: [project, status, tech]
`,
  due: `# Every \`due\` bucket at once. The two filled chips live here and nowhere else.
shape: board
title: Due
groupBy: [due]
sort: [due:asc]
uncategorised: hide
show: [priority, status, due]
`,
  blocked: `# The derived axis: blocked · waiting · clear, including the card whose blocker is done.
shape: board
title: Blocked
groupBy: [blocked]
sort: [priority:asc]
show: [priority, blocks, waiting_on]
`,
  triage: `# All four triage values, including \`complete\`.
shape: board
title: Triage
groupBy: [triage]
sort: [updated:desc]
show: [project, priority, status]
`,
  lanes: `# Two grouping axes: columns within rows. The only view that draws a lane head.
shape: board
title: Lanes
groupBy: [priority, status]
sort: [title:asc]
uncategorised: end
show: [project, due]
`,
  linked: `# Grouped by which kinds of link a record carries — one card carries all of them.
shape: board
title: Linked
groupBy: [linked]
sort: [title:asc]
uncategorised: end
show: [status, project]
`,
  staleness: `# week · month · older, and the undated record that has no value on the axis at all.
shape: board
title: Staleness
groupBy: [staleness]
sort: [updated:desc]
uncategorised: end
show: [status, priority]
`,
  map: `# The decomposition tree, plus blocking edges. Two relation colours on one canvas.
shape: canvas
title: Map
show: [parent, blocks]
`,
  bands: `# A grouped canvas: bands behind the nodes, drawn from the grouping axis.
shape: canvas
title: Bands
groupBy: [priority]
show: [parent]
`,
  context: `# Match plus context: the filter keeps unmatched ancestors so the tree stays
# connected, drawn muted and counted separately. The dashed context band lives here.
shape: canvas
title: Context
filter:
  priority: [now]
groupBy: [status]
show: [parent]
`,
  focused: `# A saved view carrying a focus, which is the state the \u2715 beside it has to be
# able to undo. Clearing has to travel as \`focus=\` rather than as a deleted key:
# the server merges a view file's parameters *under* the query string's, so an
# absent key means inherit and the saved focus would come straight back.
shape: canvas
title: Focused
focus: { id: ideas, via: parent, dir: in }
show: [parent]
`,
  portfolio: `# Roll-ups: direct / total, blocked, untriaged, last activity — including the
# project that owns nothing, whose row must read 0 / 0.
shape: table
title: Portfolio
filter:
  type: [project]
sort: [title:asc]
show: [status, priority, due]
`,
  table: `# Every record as columns of values, which is the only place a facet reads as a column.
shape: table
title: Table
sort: [title:asc]
show: [priority, status, due, project, tech, layer, owner]
`,
  empty: `# Matches nothing, on purpose. The empty result is a state too, and it is the one
# most likely to be reached by accident.
shape: board
title: Empty
filter:
  status: [done]
  priority: [now]
groupBy: [priority]
show: [project]
`,
};

const NOTES = {
  'resolves.md': `# A doc link that resolves

\`doc:\` paths are relative to the vault root, so \`doc:notes/resolves.md\` finds this file and
renders its first heading as the label. Its sibling \`doc:notes/absent.md\` deliberately does not
exist, so the two failure paths sit side by side on one card.
`,
};

// ---------------------------------------------------------------- write

function frontmatter(card) {
  const lines = [`id: ${card.id}`, `title: ${JSON.stringify(card.title)}`];
  const facets = { ...card.facets };
  if (PARENTS[card.id]) facets.parent = [PARENTS[card.id]];
  const keys = Object.keys(facets);
  if (keys.length) {
    lines.push('facets:');
    for (const k of keys) lines.push(`  ${k}: [${facets[k].map((v) => JSON.stringify(v)).join(', ')}]`);
  }
  if (card.links?.length) {
    lines.push('links:');
    for (const l of card.links) lines.push(`  - ${JSON.stringify(l)}`);
  }
  if (card.project) {
    lines.push('project:');
    if (card.project.repos) {
      lines.push('  repos:');
      for (const r of card.project.repos) {
        lines.push(`    - { path: ${JSON.stringify(r.path)}${r.base ? `, base: ${JSON.stringify(r.base)}` : ''} }`);
      }
    }
    if (card.project.jira) lines.push(`  jira: ${card.project.jira}`);
    if (card.project.branch) lines.push(`  branch: ${JSON.stringify(card.project.branch)}`);
    if (card.project.instructions) {
      lines.push('  instructions: |');
      for (const l of card.project.instructions.replace(/\n$/, '').split('\n')) lines.push(`    ${l}`);
    }
  }
  if (card.source_fingerprint) lines.push(`source_fingerprint: ${JSON.stringify(card.source_fingerprint)}`);
  lines.push(`created: ${card.created ?? UPDATED.older}`);
  if (card.updated) lines.push(`updated: ${card.updated}`);
  return lines.join('\n');
}

rmSync(root, { recursive: true, force: true });
for (const dir of ['cards', 'views', 'notes']) mkdirSync(join(root, dir), { recursive: true });

writeFileSync(join(root, 'facets.yaml'), FACETS, 'utf8');
writeFileSync(
  join(root, '.gitignore'),
  '# Derived. This whole directory is generated by fixtures/states.mjs.\n.index.db\n.enrich.db\n.intake.db\n',
  'utf8',
);

for (const card of CARDS) {
  writeFileSync(join(root, 'cards', `${card.id}.md`), `---\n${frontmatter(card)}\n---\n\n${card.body}`, 'utf8');
}
for (const [name, body] of Object.entries(VIEWS)) {
  writeFileSync(join(root, 'views', `${name}.yaml`), body, 'utf8');
}
for (const [name, body] of Object.entries(NOTES)) {
  writeFileSync(join(root, 'notes', name), body, 'utf8');
}

const declared = new Set();
for (const card of CARDS) for (const vals of Object.values(card.facets)) for (const v of vals) declared.add(v);

console.log(`${root}
  ${CARDS.length} cards, ${Object.keys(VIEWS).length} views, ${declared.size} distinct facet values
  due buckets: overdue ${DUE.overdue} · today ${DUE.today} · week ${DUE.week} · later ${DUE.later}

  node src/cli/pj.ts vaults add ${root} --name states
  node src/cli/pj.ts --vault ${root} check`);
