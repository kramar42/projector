import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FLUSH_MS } from '../src/web/changed.ts';
import { BUILTIN_FACETS, loadFacets } from '../src/schema/facets.ts';
import { SEED_FACETS } from '../src/server/seed.ts';
import { HUES } from '../src/schema/vocabulary.ts';
import { chipClass } from '../src/web/hue.ts';
import { LINK_KINDS, linkHue } from '../src/web/links.ts';
import type { FacetDef } from '../src/schema/types.ts';

/** The seeded vocabulary, on disk, so the real loader parses it. */
function seededFacetsFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), 'projector-seed-')), 'facets.yaml');
  writeFileSync(f, SEED_FACETS, 'utf8');
  return f;
}

/**
 * The stylesheet is the design system, so these are the invariants that keep it
 * one system rather than 108 independent decisions.
 *
 * Consistency here was never the problem — a documentation pass over the whole
 * file found two exceptions in the whole of it. The problem is that consistency was held in
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
 * The note mark is sized in `em` on purpose: it sits beside text that is
 * 12.5px in a table, 13px on a card and 16px in the panel, so one relative rule
 * serves all three where a step from the scale could serve only one.
 */
const RELATIVE_BY_DESIGN = new Set(['0.8em']);

test('a hidden key hint keeps its geometry', () => {
  const rule = CODE.match(/\.keyhint\.is-hidden\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /visibility:\s*hidden/, 'visibility hides paint without removing the box');
  assert.doesNotMatch(rule, /display:\s*none/, 'display none would shift the annotated label');
});

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
  const doc = readFileSync(fileURLToPath(new URL('../docs/DESIGN.md', import.meta.url)), 'utf8');
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

/**
 * Every `{group.key}` reference in `components:` points at a key that exists.
 *
 * The frontmatter's `components:` block is the one place the document states a
 * *value* rather than naming a token, and it was the one place nothing checked.
 * `input-rail` referenced `{typography.body-compact}` — a step this scale has
 * never had; the string occurred exactly once in the repo and pointed at nothing.
 * The existing frontmatter test compares the `typography:` and `rounded:` key
 * *sets* against the stylesheet, so a dangling reference inside `components:`
 * passed it untouched.
 *
 * This is the cheap half of a harder problem. Checking the component *values*
 * against the stylesheet would need a name-to-selector map — `input-rail` is
 * `.field-recessed`, `card-face` is `.cardface` — and that map would be one more
 * thing to drift. Resolving the references needs no map and catches the class of
 * defect that actually occurred: a document naming something that is not there.
 */
test('every token reference in DESIGN.md components resolves', () => {
  const doc = readFileSync(fileURLToPath(new URL('../docs/DESIGN.md', import.meta.url)), 'utf8');
  const frontmatter = doc.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'DESIGN.md should open with YAML frontmatter');
  const fm = frontmatter[1]!;

  /** The keys of one top-level mapping, indented exactly two spaces. */
  const keysOf = (group: string): Set<string> => {
    const block = fm.split(`\n${group}:\n`)[1];
    if (block === undefined) return new Set();
    const out = new Set<string>();
    for (const line of block.split('\n')) {
      if (/^\S/.test(line)) break; // the next top-level key
      const m = line.match(/^ {2}([a-z0-9-]+):/);
      if (m) out.add(m[1]!);
    }
    return out;
  };

  const groups = ['colors', 'typography', 'rounded', 'spacing'];
  const known = new Map(groups.map((g) => [g, keysOf(g)] as const));
  for (const g of groups) {
    assert.ok(known.get(g)!.size > 0, `DESIGN.md frontmatter should carry a \`${g}:\` mapping`);
  }

  const components = fm.split('\ncomponents:\n')[1];
  assert.ok(components, 'DESIGN.md frontmatter should carry a `components:` mapping');

  const dangling = [...components.matchAll(/\{([a-z]+)\.([a-z0-9-]+)\}/g)]
    .filter(([, group, key]) => !known.get(group!)?.has(key!))
    .map(([ref, group]) => (known.has(group!) ? `${ref} — no such key` : `${ref} — no such group`));

  assert.deepEqual(
    [...new Set(dangling)],
    [],
    'a components: reference pointing at a token that does not exist',
  );
});

/**
 * The rules below were prose until this pass, and prose is what drifted.
 *
 * Every defect these catch is one that actually happened, was found by a person
 * or an agent *reading*, and in three cases happened more than once — which is
 * the argument for a test rather than a more careful reader. What they cost is a
 * grep; what they buy is that a rule stops depending on whoever last looked.
 */

/** Selectors, one per rule, with comments stripped so prose cannot match. */
function rules(): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of CODE.matchAll(re)) out.push({ sel: m[1]!.trim(), body: m[2]! });
  return out;
}

/**
 * The One Casing Rule: uppercase is the Label register, reached by taking the
 * step — never by transforming a string at some other size.
 *
 * This fired twice for real. The panel's axis label hand-rolled
 * `text-transform: uppercase` plus `0.1em` at the *Chip* step, and a link row's
 * field keys did the same at the *Micro* step — each a third register rather than
 * a use of the second, and each invisible in a screenshot.
 *
 * `.kv dt` is the one exemption, and it is not a loophole: DESIGN.md's Typography
 * Hierarchy commits it by name — "the panel's `kv` keys in uppercase" — at the
 * Meta step. An exemption a document states out loud is a decision.
 */
test('uppercase is reached by taking the Label step', () => {
  const EXEMPT = new Set(['.kv dt']);
  const offenders = rules()
    .filter((r) => /text-transform:\s*uppercase/.test(r.body))
    .filter((r) => !EXEMPT.has(r.sel))
    .filter((r) => !/font-size:\s*var\(--text-label\)/.test(r.body))
    .map((r) => r.sel);
  assert.deepEqual(
    offenders,
    [],
    'uppercase off the Label step — take the step, or render the string as it arrives:\n' +
      offenders.map((s) => `  ${s}`).join('\n'),
  );
});

/**
 * The Drawn Control Rule: nothing on screen is drawn by the browser.
 *
 * Checked structurally rather than per control, because per control is exactly
 * how this rule kept failing. Three checkboxes and two selects were found in one
 * pass; a later pass found `input[type=search]` and `input[type=date]` still
 * computing `appearance: auto`, because `appearance` was declared on nine classes
 * and on `select`, and on nothing that reached an unclassed or oddly-typed input.
 *
 * Asserting it on the shared element rule is what makes the defect unable to
 * recur: a control with no class, or with a type nobody thought about, is covered
 * by construction.
 */
test('every field is drawn by the app, not the browser', () => {
  const shared = rules().find((r) => r.sel === 'input, textarea, select');
  assert.ok(shared, 'the shared field rule should be declared on the elements');
  assert.match(
    shared.body,
    /appearance:\s*none/,
    'the shared `input, textarea, select` rule must declare `appearance: none`, or a control with ' +
      'no class is drawn by the browser',
  );
  const revived = rules().filter((r) => /appearance:\s*auto/.test(r.body)).map((r) => r.sel);
  assert.deepEqual(revived, [], `appearance handed back to the browser: ${revived.join(', ')}`);
});

/**
 * Still at rest. No keyframes, and no transition longer than 140ms.
 *
 * The rule with the widest blast radius in the Don't list and nothing checked it.
 * A surface that sits open on a second monitor all day is a readout, and one
 * transition added in sympathy is how a readout stops being one.
 */
test('the surface is still, apart from the one thing stillness cannot say', () => {
  // The sanctioned exception, named. DESIGN.md's The Something Moved Rule is the
  // argument; this is the enforcement. A second keyframe or a second animated
  // property fails here, which is the difference between an exception and a hole.
  assert.deepEqual(
    [...CODE.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!),
    ['touched'],
    'a keyframe animation that is not the foreign-change flush',
  );
  // The set, not the sequence: the flush is declared on several selectors and
  // cancelled on several more, and how many of each is a layout detail. What must
  // not grow is the number of distinct animations, which is one.
  assert.deepEqual(
    [...new Set([...CODE.matchAll(/(?<!-)\banimation:\s*([^;]+);/g)].map((m) => m[1]!.trim()))].sort(),
    ['none', 'touched 2600ms ease-out 1'],
    'an animation declaration that is not the flush, or its reduced-motion opt-out',
  );
  // It fires once and it does not loop: a thing that keeps moving is a thing you
  // stop seeing, and this has to still be legible on the hundredth change.
  assert.doesNotMatch(CODE, /animation:[^;]*infinite/, 'an animation that never stops');

  // The stylesheet and the client agree on how long it lasts. They cannot read each
  // other, and disagreeing is not a cosmetic drift: the class is removed on the
  // client's clock, so a shorter class than animation cuts the flush off mid-decay
  // and a longer one leaves a released animation sitting on its base style — which
  // was a real bug, seen as two flushes and a hard cut.
  const declared = CODE.match(/animation:\s*touched\s+(\d+)ms/);
  assert.ok(declared, 'the flush should still declare its duration in ms');
  assert.equal(
    Number(declared![1]),
    FLUSH_MS,
    'the stylesheet and FLUSH_MS in src/web/changed.ts disagree about the flush',
  );

  // Transparent at rest, or the animation ending is a second flush. The overlay is
  // only ever visible while something is driving it.
  const overlay = rules().find((r) => r.sel.includes('.is-touched::after'));
  assert.ok(overlay, 'the flush overlay should still exist');
  assert.match(
    overlay!.body,
    /opacity:\s*0/,
    'the flush overlay must rest transparent — a CSS animation releases to its base style',
  );

  const slow = [...CODE.matchAll(/transition:[^;]*?(\d+)ms/g)].filter((m) => Number(m[1]) > 140).map((m) => m[0]);
  assert.deepEqual(slow, [], `a transition longer than 140ms: ${slow.join(', ')}`);
});

/**
 * The Desktop-Only Rule. Every `@media` asks about the reader, never about the
 * viewport.
 *
 * Stated as an imperative — "Do not add breakpoints; if something must fit a
 * narrower window, clamp it" — which is precisely the kind of instruction that
 * needs an enforcer rather than a reader.
 *
 * Two queries now, and they are the same kind of thing: a system preference the
 * reader set, which is not a layout decision. `prefers-reduced-motion` arrived with
 * the one animation this app has, and it exists so that the reader gets the flush
 * without the decay — the information is the point and the motion is only how it
 * arrives. A width query would still fail, which is what the rule is about.
 */
test('every media query asks about the reader, not the viewport', () => {
  const queries = [...CODE.matchAll(/@media([^{]*)\{/g)].map((m) => m[1]!.trim());
  assert.deepEqual(
    queries,
    ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)'],
    `an @media that is not a reader preference: ${queries.join(' | ')}`,
  );
  for (const q of queries) {
    assert.doesNotMatch(q, /width|height|orientation|aspect-ratio/, `a viewport query: ${q}`);
  }
  assert.deepEqual([...CODE.matchAll(/@container/g)].map((m) => m[0]), [], 'a container query');
});

/**
 * The One Hue Per Axis Rule: a facet axis owns one hue family, and a family
 * serves one axis.
 *
 * The property the whole palette exists for — that a chip's colour is legible
 * before its text is — and it dies quietly the first time two axes share a
 * family. The two hueless classes are the documented Hints Are Hueless case.
 */
test('every hue a vocabulary names is a family the stylesheet defines', () => {
  // The mapping moved out of here. It was nine rules named after nine facets, so
  // the stylesheet decided which axis was orange; `facets.yaml` decides now, and
  // this is the seam where the two halves have to agree — a `hue:` naming a
  // family with no rule behind it fails silently and looks exactly like grey.
  const defined = new Set(
    rules()
      .map((r) => r.sel.match(/^\.facet-hue-([a-z]+)$/)?.[1])
      .filter(Boolean) as string[],
  );
  assert.ok(defined.size >= 5, 'the stylesheet should offer a palette worth choosing from');

  // `HUES` is what `pj check` offers a vault, so it and the stylesheet are two
  // halves of one palette. A family in the list with no rule behind it is a grey
  // chip the validator called fine; a rule the list omits is a colour nobody can
  // ask for.
  assert.deepEqual([...defined].sort(), [...HUES].sort(), 'the offered palette is the drawn one');

  const seeded = loadFacets(seededFacetsFile());
  const claimed = new Map<string, string[]>();
  for (const [name, def] of Object.entries(seeded)) {
    for (const hue of [def.hue, ...(def.buckets ?? []).map((b) => b.hue)]) {
      if (!hue || hue === 'none') continue;
      assert.ok(defined.has(hue), `"${name}" asks for hue "${hue}", which no rule defines`);
      if (def.hue === hue) claimed.set(hue, [...(claimed.get(hue) ?? []), name]);
    }
  }

  // One family per axis *in the seed*, so a chip's colour still says which facet
  // it is before you read it. Only the seed: the palette has seven families and
  // a vault may have twenty axes, so uniqueness is a property of what is shipped
  // rather than something the app can enforce — anything past seven recedes, and
  // a vault deliberately colouring two related axes alike is its business.
  //
  // A *bucket* hue is exempt either way: it is emphasis within an axis, and
  // `overdue` borrowing red from `blocked_by` says the right thing.
  const shared = [...claimed].filter(([, names]) => names.length > 1);
  assert.deepEqual(shared, [], `a hue family serving two axes: ${shared.map(([h, n]) => `${h} <- ${n.join(', ')}`).join('; ')}`);
});

/**
 * Every register the client can ask for is a register the stylesheet draws.
 *
 * The hue-family test above covers one of the four — a `hue:` naming a family
 * with no rule behind it. The other three arrive as class names built in
 * `src/web/hue.ts` rather than as a vault's declaration, so they are invisible to
 * that test *and* to "every className resolves to a rule", which only reads
 * literal `className` strings. `.facet-app` and `.facet-ref` were both added
 * without one, and a missing register does not fail: it renders as an unstyled
 * chip, which is a transparent box with body text in it.
 */
test('every chip register the client can ask for has a rule', () => {
  const rule = new Set<string>();
  for (const m of CODE.matchAll(/([^{}]*)\{/g)) {
    for (const c of m[1]!.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) rule.add(c[1]!);
  }

  const axis = (d: Partial<FacetDef>): FacetDef =>
    ({ label: 'x', type: 'label', values: [], open: true, single: false, ...d }) as FacetDef;

  const asked = new Set(
    [
      chipClass(undefined),
      chipClass(axis({ type: 'ref' })),
      ...Object.values(BUILTIN_FACETS).map((d) => chipClass(d)),
      ...[...HUES].map((h) => chipClass(axis({ hue: h }))),
      ...[...HUES].map((h) =>
        chipClass(axis({ type: 'date', buckets: [{ name: 'b', upTo: 0, hue: h }] }), 'b'),
      ),
    ].flatMap((c) => c.split(' ')),
  );

  const orphans = [...asked].filter((c) => !rule.has(c));
  assert.deepEqual(orphans, [], `a register with no rule behind it: ${orphans.join(', ')}`);
  assert.ok(asked.has('facet-app') && asked.has('facet-ref'), 'both new registers are reachable');
});

/**
 * Every link kind names a family the palette has, and stays off the two that are
 * spoken for.
 *
 * `linkHue` builds `var(--hue-<name>)` from the vocabulary, so a typo is not an
 * error: it is a prefix that quietly inherits the chip's own colour and looks
 * like a kind that chose not to have one. The reservations are the interesting
 * half — **red** is a failure here, which `.linkchip.is-failed` needs to stay
 * readable as, and **purple** is the accent, which this map was rewritten to stop
 * spending.
 */
test('every link kind draws in a family the palette defines', () => {
  const claimed = Object.entries(LINK_KINDS).filter(([, k]) => k.hue);
  assert.ok(claimed.length >= 5, 'the kinds should be telling themselves apart by colour');

  for (const [kind, { hue }] of claimed) {
    assert.ok(HUES.includes(hue!), `link kind "${kind}" asks for hue "${hue}", which is not a family`);
    assert.ok(hue !== 'red' && hue !== 'purple', `link kind "${kind}" takes a reserved family`);
    assert.equal(linkHue(kind)?.color, `var(--hue-${hue})`);
  }

  // A kind with no family falls to the rule's own colour, which must not be the
  // accent — that is the thing being spent less of.
  assert.equal(linkHue('url'), undefined, 'the unknown-host kind names no family');
  const b = rules().find((r) => r.sel === '.linkchip b');
  assert.ok(b && !/var\(--accent\)/.test(b.body), 'the prefix no longer rests on the accent');
});

/**
 * Every class the client asks for exists in the stylesheet.
 *
 * `className` is a string, so a class with no rule behind it fails silently and
 * looks exactly like a class that works. Two passes found seven: three
 * `panelClassName`s on `PopoverButton`, then `vaultmenu`, `viewmenu`,
 * `vaultbtn-name` and `lane-name` — all live DOM hooks with nothing behind them,
 * two of them on elements whose siblings *were* styled, which is what made them
 * read as intentional.
 *
 * Only static names are checked. A class assembled by interpolation is skipped,
 * because its value is not knowable here and guessing would make this test lie in
 * the other direction.
 */
test('every className resolves to a rule', () => {
  /** Classes owned by a library, whose elements this stylesheet only reaches into. */
  const FOREIGN = /^(react-flow|cm-)/;
  const declared = new Set<string>();
  for (const m of CODE.matchAll(/([^{}]*)\{/g)) {
    for (const c of m[1]!.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) declared.add(c[1]!);
  }

  const dir = fileURLToPath(new URL('../src/web/', import.meta.url));
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.tsx')) files.push(join(d, e.name));
    }
  };
  walk(dir);
  assert.ok(files.length > 10, 'the client should have been found');

  const orphans = new Map<string, string[]>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:className|panelClassName)=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      // An interpolation leaves a `~`, which cannot occur in a class name — so
      // `tone-${t}` is skipped whole rather than truncated to a bogus `tone-`.
      const raw = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '~');
      for (const cl of raw.split(/\s+/)) {
        if (!cl || cl.includes('~') || FOREIGN.test(cl) || declared.has(cl)) continue;
        orphans.set(cl, [...(orphans.get(cl) ?? []), f.slice(dir.length)]);
      }
    }
  }
  const listed = [...orphans].map(([cl, where]) => `  ${cl} — ${[...new Set(where)].join(', ')}`);
  assert.deepEqual(listed, [], `a className with no rule behind it:\n${listed.join('\n')}`);
});

/**
 * ARCHITECTURE.md's test table names exactly the tests that exist.
 *
 * It named `model.test.ts`, which does not exist and had not for some time, while
 * omitting sixteen files that do — so the table read as a complete account of what
 * is covered and was neither complete nor accurate. A table asserting coverage is
 * worse than no table when it is wrong, because it answers the question the reader
 * came to ask.
 */
test('ARCHITECTURE.md names the tests that exist', () => {
  const doc = readFileSync(fileURLToPath(new URL('../docs/ARCHITECTURE.md', import.meta.url)), 'utf8');
  const named = new Set([...doc.matchAll(/`([a-z]+\.test\.ts)`/g)].map((m) => m[1]!));
  const real = new Set(
    readdirSync(fileURLToPath(new URL('../test/', import.meta.url))).filter((f) => f.endsWith('.test.ts')),
  );
  assert.deepEqual(
    [...named].filter((n) => !real.has(n)).sort(),
    [],
    'a test the document names that does not exist',
  );
  assert.deepEqual(
    [...real].filter((r) => !named.has(r)).sort(),
    [],
    'a test that exists and the document does not name',
  );
});

/**
 * The Mono Label Rule's missing half: a control that carries text names its font.
 *
 * The most-cited rule in DESIGN.md was the least enforced, and it failed in the
 * one direction prose cannot catch. `.facetedit-head` was a bare `<button>`
 * declaring no family, so when its label's explicit `--mono` was removed to make
 * the panel agree with the filter rail, the label did not land on `--sans` — it
 * landed on the UA's form-control font, and thirteen axis labels rendered in
 * Arial thirty pixels from the rail rendering the same strings. The commit that
 * did it was *correcting* this exact divergence, and every test passed.
 *
 * A browser gives `button`, `input`, `textarea` and `select` their own family, so
 * for those elements inheritance is not a default — it is a declaration you have
 * to make. Hence the check: every `<button>` in the client must carry at least
 * one class whose rule names a family. The rail's `.facet-head` says
 * `font: inherit` and passes; the panel's old head said nothing and would not.
 *
 * Scoped to `<button>` because the shared `input, textarea, select` rule already
 * covers the other three in one place, and 'every field is drawn by the app'
 * above is what keeps that rule honest.
 */
test('a button names its font, because the browser otherwise names it for you', () => {
  /** `font: inherit`, a `font-family:`, or a `font:` shorthand naming a token. */
  const NAMES_FAMILY = /(font-family:|font:\s*inherit|font:[^;]*var\(--(?:sans|mono)\))/;
  const byClass = new Map<string, string[]>();
  for (const r of rules()) {
    for (const c of r.sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
      byClass.set(c[1]!, [...(byClass.get(c[1]!) ?? []), r.body]);
    }
  }
  const names = (cl: string) => (byClass.get(cl) ?? []).some((b) => NAMES_FAMILY.test(b));

  const dir = fileURLToPath(new URL('../src/web/', import.meta.url));
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.tsx')) files.push(join(d, e.name));
    }
  };
  walk(dir);

  /**
   * The classes on one opening tag, however the caller spelled them.
   *
   * `className` is a string here, a template literal there, and a `cls(...)` call
   * in `Button.tsx` — which is the one that matters most, since every real button
   * in the app goes through it. So: take the whole attribute value with balanced
   * braces, then read every quoted or backticked run inside it. An interpolation
   * contributes nothing and is simply not a class this test can see.
   */
  const classesOn = (tag: string): string[] => {
    const at = tag.indexOf('className=');
    if (at < 0) return [];
    let i = at + 'className='.length;
    let value: string;
    if (tag[i] === '{') {
      let depth = 0;
      const from = i;
      for (; i < tag.length; i++) {
        if (tag[i] === '{') depth++;
        else if (tag[i] === '}' && --depth === 0) break;
      }
      value = tag.slice(from + 1, i);
    } else {
      value = tag.slice(i, tag.indexOf('"', i + 1) + 1);
    }
    const out: string[] = [];
    for (const m of value.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
      for (const cl of (m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/)) if (cl && !cl.includes('$')) out.push(cl);
    }
    return out;
  };

  const bare: string[] = [];
  for (const f of files) {
    // Prose talks about markup — this very test's own comment names a `<button>`
    // — so comments come out before anything is counted as an element.
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    for (const m of src.matchAll(/<button\b[\s\S]*?>/g)) {
      const classes = classesOn(m[0]);
      if (classes.some(names)) continue;
      bare.push(`  ${f.slice(dir.length)} — ${classes.join(' ') || '(no class at all)'}`);
    }
  }
  assert.deepEqual(
    bare,
    [],
    `a <button> whose classes never name a font family, so it keeps the UA's:\n${bare.join('\n')}`,
  );
});

/**
 * A counter cannot lose its tabular guard by accident.
 *
 * The guard is not doing what it looks like it does. Every member of the hoisted
 * rule is mono, and in a monospaced face the digits already share one advance —
 * so the declaration changes nothing about any of them *today*. What it is, is
 * insurance against a counter losing its mono, which is a thing that happens: the
 * commit that dropped thirteen axis labels onto a `<button>`'s own font did it
 * with every test in this file green. On the day that lands on a counter, this
 * declaration is the difference between a number that shoves its neighbours on
 * every increment and one that does not.
 *
 * Two things can silently remove it, and the test is one assertion each.
 *
 * **The `font:` shorthand resets every sub-property it does not name**, including
 * this one. So a hoisted rule is undone by any later rule that sets `font:` on the
 * same element, and the two counters that do — `.facet-more` and `.popbtn` — have
 * to re-declare it for themselves. Membership is pinned as a set rather than a
 * count so that adding a counter is a deliberate edit here, and so that the file
 * cannot disagree with a tally in prose about how many there are.
 *
 * **A co-class is not membership.** `.facet-count` renders as
 * `quietcount facet-count` in one template string, so it inherited the guard from
 * a sibling class in a `className` rather than from a rule. That is a guard held
 * in place by a JSX string, and this test would not have noticed it leaving.
 */
test('a counter cannot lose its tabular guard by accident', () => {
  /**
   * The counters, pinned. This list is the decision; the stylesheet is checked
   * against it, never the other way round — a set derived from "whichever rules
   * declare the guard" cannot notice a counter dropping the guard, because
   * dropping it also drops the counter out of the set doing the checking.
   */
  const COUNTERS = [
    'bulkbar-count',
    'cardface-meta',
    'column-count',
    'count',
    'facet-badge',
    'facet-count',
    'facet-more',
    'lane-count',
    'num',
    'popbtn',
    'progress-num',
    'quietcount',
    'rail-active',
    'rail-pins',
    'rail-stats',
    'section-count',
    'sidebar-ribbon-info',
    'table',
    'vaultrow-meta',
  ];

  const classesIn = (sel: string) => [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
  const tabular = rules().filter((r) => /font-variant-numeric:\s*tabular-nums/.test(r.body));

  // (a) Nothing joined or left the guard without this list being edited on purpose.
  assert.deepEqual(
    [...new Set(tabular.flatMap((r) => classesIn(r.sel)))].sort(),
    [...COUNTERS].sort(),
    'a counter joined or left the tabular guard',
  );

  // (b) A rule that sets the `font:` shorthand wipes the guard for its subtree, so
  // any rule doing that to a pinned counter must re-declare it. Checked against the
  // pinned list rather than the derived set, or removing the declaration would also
  // remove the element being asked about.
  const broken = rules()
    .filter((r) => /(^|[;{\s])font:\s*[^;]+;/.test(r.body))
    .filter((r) => classesIn(r.sel).some((c) => COUNTERS.includes(c)))
    .filter((r) => !/font-variant-numeric:\s*tabular-nums/.test(r.body))
    .map((r) => r.sel);
  assert.deepEqual(
    broken,
    [],
    `a counter sets the \`font:\` shorthand, which resets its own tabular guard:\n  ${broken.join('\n  ')}`,
  );
});

// ------------------------------------------------------------------- contrast

/**
 * The rule prose used to guard alone.
 *
 * Everything above refuses a raw step, a stray hue, a class that resolves to no
 * rule — and none of it can say whether two colours can be read against each
 * other. The one regression of that kind, a `dt` label receding to 3.16:1, was
 * found by measuring in a browser. A ratio needs resolved colour, and resolving
 * it here is the cheap half of that: the tokens are literals in two blocks, and
 * the one interpolated value that matters is reproduced below.
 *
 * The floor is WCAG 2.1 AA for normal text. `PRODUCT.md` names no standard and
 * declines to invent one, but it does record the usage fact this stands on — read
 * at second-monitor distance, for hours, in whichever theme the system is set to.
 * 4.5:1 is the number that fact implies.
 */
const AA = 4.5;

/** Tokens are literal hex in both blocks, which is the whole reason this is cheap. */
function tokensIn(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

/**
 * The two themes, as resolved maps.
 *
 * Light is `:root` and dark overrides it, which is the cascade the browser
 * performs — so dark is the spread of one over the other rather than a second
 * complete table, and a token added to `:root` alone is correctly shared.
 */
const THEMES: [string, Record<string, string>][] = (() => {
  const light = tokensIn(ROOT);
  const at = CODE.indexOf("[data-theme='light']) {");
  const dark = { ...light, ...tokensIn(CODE.slice(at, CODE.indexOf('\n  }', at))) };
  return [
    ['light', light],
    ['dark', dark],
  ];
})();

const channels = (hex: string): number[] => {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

/** WCAG 2.1 relative luminance, and the ratio built from two of them. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** `color-mix(in srgb, a <p>, b)`, which is sRGB and therefore just a lerp. */
function mix(a: string, b: string, p: number): string {
  const [x, y] = [channels(a), channels(b)];
  return (
    '#' +
    x.map((v, i) => Math.round(v * p + y[i]! * (1 - p)).toString(16).padStart(2, '0')).join('')
  );
}

/**
 * Every colour that carries text, against every surface it can land on.
 *
 * The pairing is a decision and is written out; the *members* are derived, so an
 * `--ink-4` or a `--surface-4` joins the matrix by being declared rather than by
 * someone remembering this file. That is the half that would otherwise rot.
 */
test('text clears AA against every surface it can sit on, in both themes', () => {
  const failures: string[] = [];
  for (const [theme, T] of THEMES) {
    const surfaces = Object.keys(T).filter((n) => n === 'ground' || /^surface(-\d)?$/.test(n));
    const inks = Object.keys(T).filter(
      (n) => /^ink(-\d)?$/.test(n) || ['accent', 'ok', 'warn', 'bad'].includes(n),
    );
    assert.ok(surfaces.length >= 4 && inks.length >= 7, `${theme}: the matrix went missing`);
    for (const ink of inks) {
      for (const s of surfaces) {
        const r = contrast(T[ink]!, T[s]!);
        if (r < AA) failures.push(`${theme}: --${ink} on --${s} is ${r.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, [], `under ${AA}:1:\n  ${failures.join('\n  ')}`);
});

/**
 * A chip's hue against the fill the chip actually gets — not against the raw
 * `-bg` token, which is what a reader of the stylesheet would assume and is wrong
 * in light mode. `--chip-tint` dilutes the fill toward the surface, so the light
 * theme's real backgrounds are 42% of what is declared and every ratio here is
 * tighter than the token pair suggests.
 */
test('a facet chip reads against its own fill, tint included', () => {
  const failures: string[] = [];
  for (const [theme, T] of THEMES) {
    // `--chip-tint` is a percentage, so it is not hex and not in the map above.
    const where = theme === 'dark' ? CODE.slice(CODE.indexOf("[data-theme='light']) {")) : ROOT;
    const pct = /--chip-tint:\s*(\d+)%/.exec(where);
    assert.ok(pct, `${theme}: --chip-tint is not declared, so a chip's real fill is unknown`);
    const p = Number(pct[1]) / 100;
    const families = Object.keys(T)
      .filter((n) => /^hue-[a-z]+$/.test(n))
      .filter((n) => T[`${n}-bg`]);
    assert.ok(families.length >= 7, `${theme}: the hue families went missing`);
    for (const f of families) {
      const fill = mix(T[`${f}-bg`]!, T['surface']!, p);
      const r = contrast(T[f]!, fill);
      if (r < AA) failures.push(`${theme}: --${f} on its chip (${fill}) is ${r.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], `under ${AA}:1:\n  ${failures.join('\n  ')}`);
});

/**
 * The margin, pinned where it is thinnest.
 *
 * `--ink-3` on `--surface-3` in the light theme measures 4.52:1 — one nudge from
 * failing, and the pair a hover state puts on screen constantly. Asserting the
 * *floor* alone would let someone spend that margin without noticing they were
 * the last person who could. This says out loud that there is none left.
 */
test('the tightest pair in the palette is known, and is still the tightest', () => {
  const light = THEMES[0]![1];
  const r = contrast(light['ink-3']!, light['surface-3']!);
  assert.ok(r >= AA, `--ink-3 on --surface-3 fell to ${r.toFixed(2)}:1`);
  assert.ok(
    r < 5,
    `--ink-3 on --surface-3 is now ${r.toFixed(2)}:1 — the palette got roomier, so re-measure and move this`,
  );
});
