import { Document as YAMLDoc, isMap, isScalar, isSeq, parseDocument, visit, type Document } from 'yaml';

const FENCE = /^---\r?\n/;

/** Frontmatter key order, so every file reads the same way. */
export const KEY_ORDER = [
  'id',
  'title',
  'facets',
  'edges',
  'links',
  'project',
  'source_fingerprint',
  'due',
  'created',
  'updated',
];

export interface Split {
  /** Raw YAML text between the fences, or null when there is no frontmatter. */
  yaml: string | null;
  /** Everything after the closing fence, byte-identical to the source. */
  body: string;
}

/**
 * Split a markdown file into its frontmatter and body.
 *
 * The body is returned verbatim. Frontmatter-only edits must never touch it —
 * that is what lets an agent and the app work on the same file (C3).
 */
export function split(text: string): Split {
  if (!FENCE.test(text)) return { yaml: null, body: text };
  const afterOpen = text.replace(FENCE, '');
  const close = afterOpen.search(/^---\r?\n/m);
  if (close === -1) return { yaml: null, body: text };
  const yaml = afterOpen.slice(0, close);
  const rest = afterOpen.slice(close).replace(FENCE, '');
  return { yaml, body: rest };
}

/** Re-join frontmatter and body. */
export function join(yamlText: string, body: string): string {
  const y = yamlText.endsWith('\n') ? yamlText : yamlText + '\n';
  return `---\n${y}---\n${body}`;
}

/**
 * Parse frontmatter as a mutable yaml Document rather than a plain object, so
 * surgical edits preserve comments, key order and hand formatting.
 */
export function parseDoc(yamlText: string): Document {
  return parseDocument(yamlText, { prettyErrors: true });
}

const INLINE_MAP_KEYS = new Set(['type', 'to', 'path', 'base']);

/**
 * The name of a map pair's key.
 *
 * `doc.set(key, …)` stores the key as a plain string while parsed keys arrive as
 * Scalar nodes, so both forms have to be handled or a freshly set key looks
 * nameless and sorts to the end.
 */
function keyName(key: unknown): string {
  if (isScalar(key)) return String(key.value);
  return typeof key === 'string' ? key : '';
}

/**
 * Put scalar arrays and small edge/repo maps on one line — `priority: [now]`
 * rather than a three-line block. A card's frontmatter is read far more often
 * than it is written.
 */
function applyFlow(doc: Document): void {
  visit(doc, {
    Seq(_key, node) {
      if (!isSeq(node)) return;
      if (node.items.length && node.items.every((i) => isScalar(i))) node.flow = true;
    },
    Map(_key, node) {
      if (!isMap(node)) return;
      const keys = node.items.map((i) => keyName(i.key));
      if (keys.length && keys.length <= 2 && keys.every((k) => INLINE_MAP_KEYS.has(k))) {
        node.flow = true;
      }
    },
  });
}

/** Reorder top-level keys to KEY_ORDER, keeping anything unrecognised at the end. */
function reorder(doc: Document): void {
  const contents = doc.contents;
  if (!isMap(contents)) return;
  const rank = (k: string) => {
    const i = KEY_ORDER.indexOf(k);
    return i === -1 ? KEY_ORDER.length : i;
  };
  contents.items.sort((a, b) => rank(keyName(a.key)) - rank(keyName(b.key)));
}

const STRINGIFY = { lineWidth: 110, defaultStringType: 'PLAIN', singleQuote: false, flowCollectionPadding: false } as const;

export function serialize(value: unknown): string {
  const doc = new YAMLDoc(value);
  applyFlow(doc);
  return doc.toString(STRINGIFY);
}

/**
 * Patch keys in a standalone YAML file — a view config, not a card.
 *
 * Deliberately separate from `patchKey`: that one expects a `---` fenced
 * frontmatter block and treats everything after it as an untouchable body. Given
 * a plain YAML file it would find no fence, wrap the entire original document as
 * the "body", and emit a file with every key duplicated.
 */
export function patchYamlFile(text: string, patch: Record<string, unknown>): string {
  const doc = parseDoc(text);
  if (doc.contents === null) doc.contents = doc.createNode({});
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) doc.delete(key);
    else doc.set(key, doc.createNode(value));
  }
  applyFlow(doc);
  return doc.toString(STRINGIFY);
}

/**
 * Patch one top-level frontmatter key and return the whole file text.
 *
 * Preserves the body exactly, keeps untouched keys as they were, and restores
 * the canonical key order so a patched file is indistinguishable from a
 * freshly rendered one.
 */
export function patchKey(text: string, key: string, value: unknown): string {
  const { yaml, body } = split(text);
  const doc = parseDoc(yaml ?? '');
  if (value === undefined) doc.delete(key);
  // createNode first: `set` with a plain JS value stores it unconverted, and the
  // flow pass below only walks real yaml nodes.
  else doc.set(key, doc.createNode(value));
  reorder(doc);
  applyFlow(doc);
  return join(doc.toString(STRINGIFY), body);
}
