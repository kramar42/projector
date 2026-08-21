import { readFileSync } from 'node:fs';
import { clean, slugify, uniqueId } from './slug.ts';
import type { Rec } from '../schema/types.ts';
import { parseLink } from '../schema/links.ts';

/**
 * Trello board export → cards, nodes and project records.
 *
 * The export is the whole board history, so almost all of it is deliberately
 * dropped. The mapping is recorded in the importer itself; the
 * report this returns is what proves the arithmetic held.
 */

interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  closed?: boolean;
  idList: string;
  pos?: number;
  shortUrl?: string;
  dateLastActivity?: string;
  idChecklists?: string[];
  attachments?: { name?: string; url?: string; mimeType?: string; bytes?: number | null }[];
}

interface TrelloList {
  id: string;
  name: string;
  closed?: boolean;
  pos?: number;
}

interface TrelloChecklist {
  id: string;
  name: string;
  checkItems?: { name: string; state: string; pos?: number }[];
}

interface TrelloBoard {
  cards: TrelloCard[];
  lists: TrelloList[];
  checklists?: TrelloChecklist[];
}

/** The meta-list: a palette of column names, not work. Becomes vocabulary. */
const META_LIST = 'lists';
const SEPARATOR = /^-{2,}$/;
const SECTION = /^\*{2,}\s*(.+?)\s*\*{2,}$/;

/** Live list name → the priority facet value it maps to. */
const PRIORITY_BY_LIST: Record<string, string> = {
  priority: 'now',
  month: 'month',
  backlog: 'backlog',
  research: 'someday',
};

/** Lists that become project records rather than a priority bucket. */
const PROJECT_LISTS: Record<string, { key: string; title: string; facets: Record<string, string[]> }> = {
  'quarkus 3 migration': {
    key: 'quarkus3',
    title: 'Quarkus 3 migration',
    facets: { status: ['frozen'] },
  },
  research: { key: 'research', title: 'Research', facets: { priority: ['someday'] } },
};

export interface ImportReport {
  listsTotal: number;
  listsOpen: number;
  cardsTotal: number;
  cardsLive: number;
  skippedMeta: number;
  skippedSeparator: number;
  vocabulary: string[];
  sections: number;
  projects: string[];
  imported: number;
  needsAttachment: { id: string; files: string[] }[];
  urlTitles: string[];
}

export function importTrello(
  file: string,
  opts: { taken?: Set<string> } = {},
): { records: Omit<Rec, 'file'>[]; report: ImportReport } {
  const board = JSON.parse(readFileSync(file, 'utf8')) as TrelloBoard;
  const listsById = new Map(board.lists.map((l) => [l.id, l]));
  const checklists = new Map((board.checklists ?? []).map((c) => [c.id, c]));

  const openLists = board.lists.filter((l) => l.closed !== true);
  const live = board.cards.filter(
    (c) => c.closed !== true && listsById.get(c.idList)?.closed === false,
  );

  const taken = opts.taken ?? new Set<string>();
  const out: Omit<Rec, 'file'>[] = [];
  const report: ImportReport = {
    listsTotal: board.lists.length,
    listsOpen: openLists.length,
    cardsTotal: board.cards.length,
    cardsLive: live.length,
    skippedMeta: 0,
    skippedSeparator: 0,
    vocabulary: [],
    sections: 0,
    projects: [],
    imported: 0,
    needsAttachment: [],
    urlTitles: [],
  };

  // Project records first, so children can point at them.
  const projectIdByList = new Map<string, string>();
  for (const list of openLists) {
    const name = clean(list.name).toLowerCase();
    const spec = PROJECT_LISTS[name];
    if (!spec) continue;
    const id = uniqueId(spec.key, taken);
    projectIdByList.set(list.id, id);
    report.projects.push(id);
    out.push({
      id,
      title: spec.title,
      facets: spec.facets,
      links: [],
      project: {},
      created: today(),
      updated: today(),
      body: `\nImported from the Trello list "${clean(list.name)}".\n`,
    });
  }

  for (const list of [...openLists].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0))) {
    const listName = clean(list.name).toLowerCase();
    const cards = live
      .filter((c) => c.idList === list.id)
      .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));

    // The palette of column names: vocabulary, not cards.
    if (listName === META_LIST) {
      report.skippedMeta += cards.length;
      report.vocabulary = cards.map((c) => clean(c.name)).filter(Boolean);
      continue;
    }

    const projectId = projectIdByList.get(list.id);
    let sectionId: string | null = null;

    for (const card of cards) {
      const name = card.name.trim();

      if (SEPARATOR.test(name)) {
        report.skippedSeparator++;
        sectionId = null;
        continue;
      }

      // `*** platform ***` was faking structure a single list could not express.
      const section = name.match(SECTION);
      if (section) {
        report.skippedSeparator++;
        const id = uniqueId(slugify(`${listName} ${section[1]!}`), taken);
        sectionId = id;
        out.push({
          id,
          title: clean(section[1]!),
          facets: projectId ? { parent: [projectId] } : {},
          links: [],
          created: today(),
          updated: today(),
          body: '\n',
        });
        report.sections++;
        continue;
      }

      const id = uniqueId(slugify(name), taken);
      const isUrl = /^https?:\/\//.test(name);
      if (isUrl) report.urlTitles.push(id);

      const facets: Record<string, string[]> = {};
      const priority = PRIORITY_BY_LIST[listName];
      if (priority && !projectId) facets.priority = [priority];
      const spec = PROJECT_LISTS[listName];
      if (spec) for (const [k, v] of Object.entries(spec.facets)) facets[k] = [...v];
      // A card on the live board is open but unstarted. Without a status it would be
      // invisible to every board view that filters on one, which is all of them.
      if (!facets.status) facets.status = ['planning'];
      facets.source = ['trello'];

      const parent = sectionId ?? projectId;
      const links: string[] = [];
      if (card.shortUrl) links.push(card.shortUrl);
      if (isUrl) links.push(name);

      const bodyParts: string[] = [];
      if (card.desc?.trim()) bodyParts.push(card.desc.trim());

      for (const clId of card.idChecklists ?? []) {
        const cl = checklists.get(clId);
        if (!cl?.checkItems?.length) continue;
        const items = [...cl.checkItems].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
        bodyParts.push(
          `## ${cl.name}\n\n` +
            items
              .map((i) => `- [${i.state === 'complete' ? 'x' : ' '}] ${i.name}`)
              .join('\n'),
        );
      }

      const images: string[] = [];
      for (const att of card.attachments ?? []) {
        const url = att.url ?? '';
        if (/slack\.com/.test(url)) links.push(`slack:${url}`);
        else if (att.mimeType?.startsWith('image/')) images.push(att.name ?? 'attachment');
        else if (url) links.push(url);
      }
      if (images.length) {
        report.needsAttachment.push({ id, files: images });
        bodyParts.push(
          `## Attachments to re-export\n\n` +
            images.map((f) => `- [ ] \`${f}\` — save from Trello into \`assets/${id}/\``).join('\n'),
        );
      }

      out.push({
        id,
        title: isUrl ? name : clean(name) || name,
        facets: { ...facets, ...(parent ? { parent: [parent] } : {}) },
        links: links.map(parseLink),
        source_fingerprint: `trello:${card.id}`,
        created: today(),
        updated: (card.dateLastActivity ?? '').slice(0, 10) || today(),
        body: bodyParts.length ? '\n' + bodyParts.join('\n\n') + '\n' : '\n',
      });
      report.imported++;
    }
  }

  return { records: out, report };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
