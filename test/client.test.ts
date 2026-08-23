import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBody } from '../src/view/markdown.ts';
import { edgesFor } from '../src/web/views/edges.ts';
import { blankQuery } from '../src/view/intents.ts';
import { specFromFile } from '../src/view/spec.ts';
import { BUILTIN_FACETS } from '../src/schema/facets.ts';
import { chipClass, edgeColour, registerOf } from '../src/web/hue.ts';
import type { FacetDef } from '../src/schema/types.ts';
import {
  apiSearch,
  paramsOf,
  patchSearch,
  selectionOf,
  selectionPatch,
  strippedOfStrays,
} from '../src/web/query.ts';

/**
 * Decisions the client makes, tested where they live rather than through a
 * renderer.
 *
 * There is no jsdom here on purpose. The wiring these feed — pointer geometry,
 * React Flow's store, CodeMirror's mount — depends on measurements jsdom does not
 * provide, so a harness would assert behaviour in an environment that does not
 * resemble a browser, on exactly the paths where the real bugs were. What is
 * testable is what is pure, and this is it.
 */

// ---------------------------------------------------------------- markdown

/**
 * The body is the one thing here an automated process writes, so it is escaped
 * before markdown runs. This is a security property, and until it moved out of
 * the panel it was a security property no test could reach.
 */
test('a card body cannot smuggle markup into the panel', () => {
  const attacks = [
    '<img src=x onerror="alert(1)">',
    '<script>alert(1)</script>',
    '<iframe src="javascript:alert(1)"></iframe>',
    'a <b>bold</b> claim',
  ];
  for (const md of attacks) {
    const html = renderBody(md);
    // No *tag* survives. The escaped text may legitimately still read
    // `onerror=`; what matters is that no `<` reaches the browser unescaped.
    assert.doesNotMatch(html, /<(script|iframe|img|svg|object|embed)\b/i, md);
    assert.match(html, /&lt;/, `${md}: the source should be visible, not executed`);
  }

  // Markdown itself still works — escaping the source must not disable it.
  assert.match(renderBody('# Title'), /<h1/);
  assert.match(renderBody('- one\n- two'), /<li/);
});

test('a relative asset path is rewritten to the server route', () => {
  assert.match(renderBody('![x](assets/card/shot.png)'), /src="\/api\/asset\/assets\/card\/shot\.png"/);
  // An absolute one is left alone.
  assert.doesNotMatch(renderBody('![x](https://example.com/a.png)'), /api\/asset/);
});

// ---------------------------------------------------------------- canvas edges

/**
 * `parent` and `project` agreeing is the expected shape for a record inside a
 * project, so drawing both put two identical lines on top of each other. The
 * collapse is what makes a pair that *disagrees* the visible case.
 */
test('agreeing relations collapse to one edge, and the structural type leads', () => {
  // Both stored the same way round, so they land on one pair.
  const edges = edgesFor(
    [
      { src: 'x', dst: 'p', type: 'project' },
      { src: 'x', dst: 'p', type: 'blocked_by' },
    ],
  );
  assert.equal(edges.length, 1, 'two relations, one line');
  assert.deepEqual(edges[0]!.types, ['project', 'blocked_by']);
  assert.equal(edges[0]!.lead, 'project');
});

test('every edge points the way the graph opens', () => {
  // A reference is stored on the record that depends and points at what it
  // depends on, so drawing it means turning it round — all of them, with nothing
  // to consult. This took a list of which relations to flip while `blocks` was
  // stored backwards from the other two.
  const [flipped] = edgesFor([{ src: 'child', dst: 'parent', type: 'parent' }]);
  assert.deepEqual([flipped!.src, flipped!.dst], ['parent', 'child'], 'drawn parent → child');

  const [blocking] = edgesFor([{ src: 'stuck', dst: 'gate', type: 'blocked_by' }]);
  assert.deepEqual([blocking!.src, blocking!.dst], ['gate', 'stuck'], 'and blocker → blocked');
});

/**
 * The regression, in its inverted form. A dependency chain has to read from its
 * root outward whichever relation the canvas lays out by — which is exactly the
 * query that asks "what does finishing this unblock".
 *
 * While the flip was keyed on the *layout relation* rather than on the relation
 * itself, these two calls disagreed and the graph read backwards under its label.
 */
test('a blocking edge reads from the blocker outward, whatever the canvas lays out by', () => {
  const chain = [{ src: 'blocked', dst: 'blocker', type: 'blocked_by' }];
  for (const label of ['laid out by parent', 'laid out by blocked_by']) {
    const [edge] = edgesFor(chain);
    assert.deepEqual([edge!.src, edge!.dst], ['blocker', 'blocked'], label);
  }
});

/**
 * A record inside a project carries `parent` and `project` naming the same
 * record, and both point at their container — so both flip, land on one pair, and
 * collapse. This is the case the module's docstring calls the *expected* shape.
 *
 * It used to draw two lines. The flip list held only the layout relation, so the
 * `parent` edge flipped and the `project` edge beside it did not, and the pair
 * described as collapsing was the one pair that could not. The old test asserted
 * that outcome and said in its own comment that it was surprising rather than
 * obviously right, which is where this bug was visible all along.
 */
test('parent and project naming the same record collapse to one edge', () => {
  const edges = edgesFor(
    [
      { src: 'child', dst: 'p', type: 'parent' },
      { src: 'child', dst: 'p', type: 'project' },
    ],
  );
  assert.equal(edges.length, 1, 'agreeing containment reads as one relationship');
  assert.deepEqual([edges[0]!.src, edges[0]!.dst], ['p', 'child'], 'drawn container → member');
  assert.deepEqual(edges[0]!.types, ['parent', 'project']);
  assert.equal(edges[0]!.lead, 'parent', 'the more structural type styles the line');
});

test('a pair that disagrees stays two edges', () => {
  const edges = edgesFor(
    [
      { src: 'x', dst: 'p1', type: 'parent' },
      { src: 'x', dst: 'p2', type: 'project' },
    ],
  );
  assert.equal(edges.length, 2, 'different targets are the case worth seeing');
});

test('lead order is the vocabulary\'s, not incidental and not a list here', () => {
  // Declaration order decides, which is the same order the filter rail and the
  // panel read. It was a three-name list in this module, so a vault's own
  // relation could never lead and a renamed one silently stopped leading.
  const facets = { project: {}, blocked_by: {} };
  const [only] = edgesFor(
    [
      { src: 'a', dst: 'b', type: 'blocked_by' },
      { src: 'a', dst: 'b', type: 'project' },
    ],
    facets,
  );
  assert.equal(only!.lead, 'project', 'project is declared first, so it styles the line');

  const [flipped] = edgesFor(
    [
      { src: 'a', dst: 'b', type: 'blocked_by' },
      { src: 'a', dst: 'b', type: 'project' },
    ],
    { blocked_by: {}, project: {} },
  );
  assert.equal(flipped!.lead, 'blocked_by', 'and a vault that declares it first gets it first');
});

// ---------------------------------------------------------------- clearing

/**
 * The regression from the pass that moved this: iterating `SPEC_PARAMS` alone
 * cannot clear `f.<facet>`, because facet filters are one key per axis with no
 * fixed list. Revert silently stopped clearing filters.
 */
test('clearing drops the fixed keys and every facet override, from either source', () => {
  const saved = specFromFile('home', { shape: 'board', filter: { status: ['planning'] } });

  // A filter the saved view supplies, absent from the URL.
  const fromSpec = blankQuery(saved, '');
  assert.equal(fromSpec['f.status'], null);
  assert.equal(fromSpec.shape, null);
  assert.equal(fromSpec.group, null, 'a fixed key is cleared even when unset');

  // A filter present only as a URL override, for an axis the spec no longer carries.
  const fromUrl = blankQuery(null, '?f.tech=kafka&card=x');
  assert.equal(fromUrl['f.tech'], null);
  assert.equal(fromUrl.card, undefined, 'where you are looking is not part of the query');

  assert.equal(blankQuery(saved, '', 'inbox').view, 'inbox', 'landing on a view keeps it');
});

// ---------------------------------------------------------------- the location

/**
 * A key the app does not own is not part of the view.
 *
 * `patchSearch` preserves what it does not recognise — it writes what it is told —
 * so nothing ever took a retired parameter back out of the URL. `?filterstyle=`
 * switched between three filter-value treatments; two of them and the parameter
 * were deleted, and it sat in bookmarked and open URLs afterwards regardless.
 * `null` means "nothing to rewrite", which is what keeps the caller from looping
 * on `URLSearchParams`'s own re-encoding.
 */
test('a parameter the app does not own is dropped from the URL', () => {
  assert.equal(strippedOfStrays('?view=home&f.status=planning&card=x'), null);
  assert.equal(strippedOfStrays(''), null, 'no params is nothing to rewrite');
  assert.equal(strippedOfStrays('?filterstyle=chip&view=home'), '?view=home');
  assert.equal(strippedOfStrays('?filterstyle=chip'), '', 'a search that was only a stray');
  assert.equal(
    strippedOfStrays('?card=x&filterstyle=chip'),
    '?card=x',
    'which panel is open is the app\'s, and survives',
  );
  // And so is what you have picked out. Left off the owned list it would be
  // deleted from the address bar on load, exactly as `filterstyle` now is.
  assert.equal(strippedOfStrays('?sel=a,b&view=home'), null, 'sel is owned, not a stray');
});

/**
 * A selection round-trips through the URL, because that is where it lives: a
 * change of shape unmounts the view, and picking the same twelve cards again is
 * the work you were trying to avoid.
 */
test('a selection survives the URL, and an empty one leaves no trace', () => {
  assert.deepEqual([...selectionOf('?sel=a,b,c')], ['a', 'b', 'c']);
  assert.deepEqual([...selectionOf('?view=home')], [], 'no key is no selection');
  assert.deepEqual([...selectionOf('?sel=')], [], 'an empty key is no selection');
  assert.deepEqual([...selectionOf('?sel=a,,b')], ['a', 'b'], 'a stray comma is not an id');

  assert.deepEqual(selectionPatch(new Set(['a', 'b'])), { sel: 'a,b' });
  // `null` removes rather than writing `sel=`, so a cleared selection is not a
  // fossil in a shared link.
  assert.deepEqual(selectionPatch(new Set()), { sel: null });
  assert.equal(patchSearch('?view=home&sel=a,b', selectionPatch(new Set())), '?view=home');

  // The whole point: changing shape is a patch of spec keys, and it leaves the
  // selection alone.
  assert.equal(
    patchSearch('?view=home&sel=a,b', { shape: 'table' }),
    '?view=home&sel=a%2Cb&shape=table',
  );
  assert.deepEqual([...selectionOf(patchSearch('?sel=a,b', { shape: 'table' }))], ['a', 'b']);
});

test('only query parameters reach the server, and the rest survive a patch', () => {
  assert.equal(apiSearch('?view=home&card=abc&f.status=planning'), '?view=home&f.status=planning');
  // The selection is the app's, not the query's. Both halves matter: a saved view
  // must not record one, and `useLive` blanks its data before refetching — so a
  // `sel` that counted as a query param would flash the pane on every click.
  assert.equal(apiSearch('?view=home&sel=a,b&f.status=planning'), '?view=home&f.status=planning');
  assert.equal(paramsOf('?a=1').get('a'), '1');
  assert.equal(paramsOf('a=1').get('a'), '1', 'with or without the leading ?');

  // `null` removes, `''` keeps the key present and empty — the difference the
  // saved-view override rests on.
  assert.equal(patchSearch('?f.status=planning&card=x', { 'f.status': null }), '?card=x');
  assert.equal(patchSearch('?card=x', { 'f.status': '' }), '?card=x&f.status=');
  assert.equal(patchSearch('?f.status=planning', { 'f.status': 'active' }), '?f.status=active');
});

// ---------------------------------------------------------------- colour

/** A definition with only the keys a register decision reads. */
const axis = (d: Partial<FacetDef>): FacetDef =>
  ({ label: 'x', type: 'label', values: [], open: true, single: false, ...d }) as FacetDef;

/**
 * Which colour an axis draws in, decided once for every surface.
 *
 * The bug this replaces was two implementations: a chip class built in
 * `vocabulary.tsx` and an edge colour built in `CanvasView`, each with its own
 * idea of what a reference and an undeclared axis meant. That is how the same
 * record came to read as a purple `parent` chip on a board and as plain text in
 * the editor, and how the built-in axis was drawn in purple by the record picker
 * while declaring `blue` in its own definition.
 */
test("a reference draws as a record, and the app's own axis in the app's colour", () => {
  // A label axis: its family, and a bucket that declares one wins and fills.
  assert.equal(chipClass(axis({ hue: 'green' })), 'facet-hue-green');
  assert.equal(
    chipClass(axis({ type: 'date', buckets: [{ name: 'overdue', upTo: -1, hue: 'red' }] }), 'overdue'),
    'facet-hue-red is-filled',
  );
  // No hue: the chip recedes. The Hints Are Hueless Rule.
  assert.equal(chipClass(axis({})), 'facet-muted');
  assert.equal(chipClass(undefined), 'facet-muted', 'an axis the vocabulary does not have');

  // A reference draws as a record however it is declared — a `hue:` on one is a
  // line colour, which is the assertion below about the edge.
  assert.equal(chipClass(axis({ type: 'ref' })), 'facet-ref');
  assert.equal(chipClass(axis({ type: 'ref', hue: 'purple' })), 'facet-ref');

  // The app's own axis, and the only one allowed the accent.
  assert.equal(chipClass(BUILTIN_FACETS.project), 'facet-app');
  assert.equal(registerOf(BUILTIN_FACETS.project).kind, 'app');
  assert.equal(
    Object.values(BUILTIN_FACETS).filter((d) => d.builtin).length,
    Object.keys(BUILTIN_FACETS).length,
    'every built-in is marked as one, or the client cannot tell without naming it',
  );

  // The edge is the one place a reference's declared family is drawn.
  assert.equal(edgeColour(axis({ type: 'ref', hue: 'purple' })), 'var(--hue-purple)');
  assert.equal(edgeColour(BUILTIN_FACETS.project), 'var(--accent)', "no hue declared, so the app's");
  assert.equal(edgeColour(axis({ type: 'ref' })), 'var(--ink-3)');
});
