import { readFileSync } from 'node:fs';
import { clean, slugify, uniqueId } from './slug.ts';
import { parseLink } from '../schema/links.ts';
import type { Rec } from '../schema/types.ts';

/**
 * TODO.md → cards, nodes and project records.
 *
 * The document's own structure carries the project hierarchy already:
 * `## A. Project A` is a project, `### B1. Project F` is a project beneath it, and the
 * checkbox lines under either are its cards.
 */

const PEOPLE = new Set(['person-c', 'person-a', 'person-b', 'person-d', 'person-e', 'mark', 'person-f']);
const SOURCES = new Set(['brain', 'trello', 'slack', 'jira', 'gdocs', 'gmail']);

/** Heading title → project key, where the slug alone would read badly. */
const KEY_OVERRIDES: Record<string, string> = {
  'project-a transport orchestration system': 'project-a',
  'project-f ai governance': 'project-f',
  'Project D mapping': 'project-d',
  'project-b keycloak': 'project-b',
  'infra devops': 'infra',
  'project-f internal platform': 'project-f-platform',
  'ai governance': 'ai-governance',
  'project-g sso entra keycloak': 'firstsupply-sso',
  'keycloak general': 'keycloak',
  'quarkus 3 migration': 'quarkus3',
};

const STATUS_BY_EMOJI: [RegExp, string][] = [
  [/🔴/u, 'blocked'],
  [/🟡/u, 'active'],
  [/🟢/u, 'waiting'],
  [/❄/u, 'frozen'],
  [/📋/u, 'planning'],
];

export interface TodoReport {
  projects: string[];
  cards: number;
  doneCards: number;
  inboxCards: number;
  jiraCards: number;
  skippedSections: string[];
  unparented: number;
}

/**
 * Sections that are not projects but do hold real items.
 *
 * Each becomes a plain container node rather than a project record, so the cards
 * beneath it inherit no repos or instructions and `ck check` flags them as
 * needing a project — which is exactly true: they are waiting on triage.
 */
const CONTAINERS: { match: RegExp; id: string; title: string; mode: 'bullets' | 'table' }[] = [
  { match: /Inbox/i, id: 'inbox', title: 'Inbox — needs triage', mode: 'bullets' },
  { match: /Jira/i, id: 'jira-triage', title: 'Jira — needs a reply', mode: 'table' },
];

/** Sections that genuinely are not cards: a date list and a ranking. */
const NOT_CARDS = [
  { match: /Upcoming/i, why: 'dates, not cards — belongs on a calendar' },
  { match: /Priority Stack/i, why: 'a ranking, already encoded by the priority facet' },
];

interface Section {
  id: string;
  level: 2 | 3;
  status?: string;
}

export function importTodo(
  file: string,
  opts: { taken?: Set<string>; existingProjects?: Map<string, string> } = {},
): { records: Omit<Rec, 'file'>[]; report: TodoReport } {
  const lines = readFileSync(file, 'utf8').split('\n');
  const taken = opts.taken ?? new Set<string>();
  const out: Omit<Rec, 'file'>[] = [];
  const report: TodoReport = {
    projects: [],
    cards: 0,
    doneCards: 0,
    inboxCards: 0,
    jiraCards: 0,
    skippedSections: [],
    unparented: 0,
  };

  let h2: Section | null = null;
  let h3: Section | null = null;
  /** `**Done:**` blocks list completed work without checkboxes. */
  let inDone = false;
  let skipSection = false;
  /** Non-empty while inside a container section (Inbox, Jira). */
  let container: (typeof CONTAINERS)[number] | null = null;

  const existing = opts.existingProjects ?? new Map<string, string>();

  const addSection = (rawTitle: string, level: 2 | 3, parent: string | null): Section => {
    // Headings are enumerated — `A. Project A (…)`, `B1. Project F (…)`. The enumerator is
    // document structure, not part of the project's name or key.
    const title = clean(rawTitle)
      .replace(/^[A-Z]\d*\.\s*/, '')
      // Trailing status markers belong in the status facet, not the name.
      .replace(/\s+(PRIMARY|SECONDARY|waiting|frozen|blocked|active|planning)$/i, '')
      .trim();
    const norm = title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    // Headings trail status markers — `… 🟡 ⭐ PRIMARY`, `… 🟢 waiting`. Match the
    // override on the leading part of the name rather than the whole line.
    const override =
      KEY_OVERRIDES[norm] ??
      Object.keys(KEY_OVERRIDES)
        .filter((k) => norm.startsWith(k))
        .sort((a, b) => b.length - a.length)
        .map((k) => KEY_OVERRIDES[k])[0];
    const key = override ?? slugify(title, 3);
    const status = STATUS_BY_EMOJI.find(([re]) => re.test(rawTitle))?.[1];

    // The same project can appear in both sources. Reuse it rather than creating
    // a second record — a project's key is its record id, so there is one name.
    const already = existing.get(key);
    if (already) return { id: already, level, status };

    const id = uniqueId(key, taken);
    existing.set(key, id);
    out.push({
      id,
      title,
      facets: { ...(status ? { status: [status] } : {}), ...(parent ? { parent: [parent] } : {}) },
      links: [],
      project: {},
      created: today(),
      updated: today(),
      body: `\nImported from TODO.md.\n`,
    });
    report.projects.push(id);
    return { id, level, status };
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const m2 = line.match(/^##\s+(.+)$/);
    const m3 = line.match(/^###\s+(.+)$/);

    if (m2) {
      const title = m2[1]!;
      const bare = clean(title);
      inDone = false;
      h3 = null;
      h2 = null;
      container = null;
      skipSection = false;

      const dead = NOT_CARDS.find((s) => s.match.test(bare));
      if (dead) {
        skipSection = true;
        report.skippedSections.push(`${bare} — ${dead.why}`);
        continue;
      }

      const cont = CONTAINERS.find((c) => c.match.test(bare));
      if (cont) {
        container = cont;
        if (!taken.has(cont.id)) {
          taken.add(cont.id);
          out.push({
            id: cont.id,
            title: cont.title,
            facets: {},
            links: [],
            created: today(),
            updated: today(),
            body: `\nImported from TODO.md section "${bare}". These need a project and facets.\n`,
          });
        }
        continue;
      }

      h2 = addSection(title, 2, null);
      continue;
    }

    if (m3) {
      inDone = false;
      if (skipSection || container) continue;
      h3 = addSection(m3[1]!, 3, h2?.id ?? null);
      continue;
    }

    if (/^\*\*Done:?\*\*/i.test(line)) {
      inDone = true;
      continue;
    }
    if (/^\*\*(Remaining|Your work|Others'?|Context|Sources|Status)/i.test(line)) {
      inDone = false;
      continue;
    }

    if (skipSection) continue;

    // Container sections: plain bullets, or a markdown table of Jira tickets.
    if (container) {
      if (container.mode === 'table') {
        const cells = line.match(/^\|(.+)\|\s*$/);
        if (!cells) continue;
        const parts = cells[1]!.split('|').map((c) => c.trim());
        const key = parts[0] ?? '';
        if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) continue; // header and rule rows
        const summary = parts[1] ?? '';
        const action = parts[2] ?? '';
        const rec = buildCard(
          `${key} ${summary} — ${action}`.trim(),
          container.id,
          false,
          taken,
          [`jira:${key}`],
        );
        if (rec) {
          out.push(rec);
          report.cards++;
          report.jiraCards++;
        }
        continue;
      }
      const bullet = line.match(/^-\s+(?!\[[ xX]\])(.+)$/);
      if (!bullet) continue;
      const rec = buildCard(bullet[1]!, container.id, false, taken);
      if (rec) {
        out.push(rec);
        report.cards++;
        report.inboxCards++;
      }
      continue;
    }

    const task = line.match(/^-\s+\[( |x|X)\]\s+(.+)$/);
    const doneBullet = inDone ? line.match(/^-\s+(?!\[)(.+)$/) : null;
    if (!task && !doneBullet) continue;

    const parent = h3?.id ?? h2?.id ?? null;
    if (!parent) continue;

    const checked = task ? task[1]!.toLowerCase() === 'x' : true;
    const text = (task ? task[2]! : doneBullet![1]!).trim();
    const rec = buildCard(text, parent, checked || inDone, taken);
    if (!rec) continue;
    out.push(rec);
    report.cards++;
    if (checked || inDone) report.doneCards++;
  }

  return { records: out, report };
}

function buildCard(
  text: string,
  parent: string,
  done: boolean,
  taken: Set<string>,
  extraLinks: string[] = [],
): Omit<Rec, 'file'> | null {
  const facets: Record<string, string[]> = { source: ['brain'] };
  const links: string[] = [...extraLinks];

  // `#tag` in backticks: people become waiting_on, the rest source or tech.
  let body = text;
  const tags = [...text.matchAll(/`#([A-Za-z0-9_-]+)`/g)].map((m) => m[1]!);
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (PEOPLE.has(t)) push(facets, 'waiting_on', t);
    else if (SOURCES.has(t)) push(facets, 'source', t);
    else push(facets, 'tech', t);
  }
  body = body.replace(/`#[A-Za-z0-9_-]+`/g, '').trim();

  // `[Person B] Do the thing` — someone else's next step.
  const owner = body.match(/^\[([A-Za-z]+)\]\s*(.+)$/);
  if (owner) {
    push(facets, 'waiting_on', owner[1]!.toLowerCase());
    body = owner[2]!.trim();
  }

  // Markdown links move to `links`, their text stays in the title.
  for (const m of body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)) links.push(m[2]!);
  const full = body
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^[\u{26A0}\u{FE0F}\u{2757}\u{2753}\s]+/u, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!full) return null;
  // Long inbox lines carry their detail after an em dash; keep it in the body.
  const cut = full.length > 90 ? full.search(/\s[—–-]\s|:\s/) : -1;
  const title = cut > 20 ? full.slice(0, cut).trim() : full;

  // An unchecked TODO line is unstarted, not in progress. Claiming `active` for
  // all of them would make every open card look like work in flight.
  facets.status = [done ? 'done' : 'planning'];
  if (!done) facets.priority = ['backlog'];

  const short = title.length > 120 ? title.slice(0, 117) + '…' : title;
  return {
    id: uniqueId(slugify(title), taken),
    title: short,
    facets: { ...facets, parent: [parent] },
    links: links.map(parseLink),
    source_fingerprint: `todo:${hash(text)}`,
    created: today(),
    updated: today(),
    body: full === short ? '\n' : `\n${full}\n`,
  };
}

function push(facets: Record<string, string[]>, key: string, value: string): void {
  const list = facets[key] ?? [];
  if (!list.includes(value)) list.push(value);
  facets[key] = list;
}

/** Stable content hash, so a re-import converges instead of duplicating. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
