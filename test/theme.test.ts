import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The stylesheet is the design system, so these are the invariants that keep it
 * one system rather than 108 independent decisions.
 *
 * Consistency here was never the problem — a documentation pass over the whole
 * file found two exceptions in 48 KB. The problem is that consistency was held in
 * one person's head: a `11.5px` where `12px` belonged, or a sixth radius step,
 * reads as plausible in a diff and is invisible in the app. Naming the scale does
 * not shrink it; these tests are what stop it growing by accident.
 *
 * What is deliberately *not* checked: colour. Every value is a literal from
 * xoria256 by construction, and the two documented departures each carry their
 * reason in a comment beside them. A test asserting "no raw hex" would have to
 * exempt the entire token block, which is the only place hex appears.
 */

const CSS = readFileSync(fileURLToPath(new URL('../src/web/style.css', import.meta.url)), 'utf8');
/** Comments carry example values and prose; none of it is a declaration. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The token block, which is the one place a literal size may be written. */
const ROOT = CODE.slice(CODE.indexOf(':root {'), CODE.indexOf('}', CODE.indexOf(':root {')));

function declared(prefix: string): Set<string> {
  return new Set([...ROOT.matchAll(new RegExp(`--(${prefix}-[a-z-]+):`, 'g'))].map((m) => m[1]!));
}

/** Declarations of a property, excluding custom-property definitions. */
function declarations(prop: string): { value: string; line: number }[] {
  const out: { value: string; line: number }[] = [];
  CODE.split('\n').forEach((text, i) => {
    const m = text.match(new RegExp(`(?<!-)\\b${prop}:\\s*([^;]+);`));
    if (m) out.push({ value: m[1]!.trim(), line: i + 1 });
  });
  return out;
}

/**
 * The record mark is sized in `em` on purpose: it sits beside text that is
 * 12.5px in a table, 13px on a card and 16px in the panel, so one relative rule
 * serves all three where a step from the scale could serve only one.
 */
const RELATIVE_BY_DESIGN = new Set(['0.8em']);

test('every font-size is a step from the scale', () => {
  const tokens = declared('text');
  assert.ok(tokens.size >= 10, 'the scale should be declared in :root');

  const offenders = declarations('font-size').filter(
    (d) => !d.value.startsWith('var(--text-') && !RELATIVE_BY_DESIGN.has(d.value),
  );
  assert.deepEqual(
    offenders,
    [],
    `raw font sizes — use a --text-* step, or add a step if the scale genuinely needs one:\n` +
      offenders.map((o) => `  style.css:${o.line}  ${o.value}`).join('\n'),
  );
});

test('every border-radius is a step from the ladder', () => {
  assert.ok(declared('radius').size >= 5, 'the ladder should be declared in :root');

  const offenders = declarations('border-radius').filter((d) => /\d\s*px/.test(d.value));
  assert.deepEqual(
    offenders,
    [],
    `raw radii — use a --radius-* step:\n` + offenders.map((o) => `  style.css:${o.line}  ${o.value}`).join('\n'),
  );
});

test('the font shorthand carries a token too, not a literal', () => {
  // `font: 9px/1.15 var(--mono)` hides a font-size from the check above.
  const offenders = [...CODE.matchAll(/font:\s*[^;]*\d+(\.\d+)?px[^;]*;/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [], `a font shorthand with a literal size: ${offenders.join(', ')}`);
});

test('every size token referenced is declared', () => {
  const tokens = new Set([...declared('text'), ...declared('radius')]);
  const used = new Set([...CODE.matchAll(/var\(--((?:text|radius)-[a-z-]+)\)/g)].map((m) => m[1]!));
  const missing = [...used].filter((u) => !tokens.has(u));
  assert.deepEqual(missing, [], `referenced but never declared: ${missing.join(', ')}`);
});

test('every size token declared is used', () => {
  const used = new Set([...CODE.matchAll(/var\(--((?:text|radius)-[a-z-]+)\)/g)].map((m) => m[1]!));
  const dead = [...declared('text'), ...declared('radius')].filter((t) => !used.has(t));
  assert.deepEqual(dead, [], `declared but unused — a scale step with no user is not a step: ${dead.join(', ')}`);
});

/**
 * DESIGN.md's frontmatter and the stylesheet name the same tokens.
 *
 * The document is the design system written down, and it went stale within the
 * hour it was written: a refactor moved the per-glyph icon metrics out of the
 * stylesheet while the prose still described them as living in it. Prose cannot
 * be checked, but the token vocabulary can — and the vocabulary is the part that
 * a generator reads and that a person looks up.
 */
test('DESIGN.md names the same size tokens the stylesheet does', () => {
  const doc = readFileSync(fileURLToPath(new URL('../DESIGN.md', import.meta.url)), 'utf8');
  const frontmatter = doc.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'DESIGN.md should open with YAML frontmatter');

  /** The keys of one top-level mapping, which are indented exactly two spaces. */
  const keysOf = (group: string): string[] => {
    const block = frontmatter[1]!.split(`\n${group}:\n`)[1];
    assert.ok(block, `DESIGN.md frontmatter should carry a \`${group}:\` mapping`);
    const out: string[] = [];
    for (const line of block.split('\n')) {
      if (/^\S/.test(line)) break; // the next top-level key
      const m = line.match(/^ {2}([a-z0-9-]+):/);
      if (m) out.push(m[1]!);
    }
    return out.sort();
  };

  assert.deepEqual(keysOf('typography'), [...declared('text')].map((t) => t.slice('text-'.length)).sort());
  assert.deepEqual(keysOf('rounded'), [...declared('radius')].map((t) => t.slice('radius-'.length)).sort());
});

/**
 * Sizes are theme-independent. Colour tokens are redefined under
 * `prefers-color-scheme: dark`; a size redefined there would mean the two themes
 * had drifted into different layouts, which is not a thing this design does.
 */
test('the scale is not redefined per theme', () => {
  const darkStart = CODE.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(darkStart > 0, 'the dark theme block should exist');
  const dark = CODE.slice(darkStart, CODE.indexOf('\n}\n', CODE.indexOf('\n  }\n', darkStart)));
  const redefined = [...dark.matchAll(/--((?:text|radius)-[a-z-]+):/g)].map((m) => m[1]!);
  assert.deepEqual(redefined, [], `a size token redefined for dark mode: ${redefined.join(', ')}`);
});
