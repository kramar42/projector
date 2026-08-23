import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBody } from '../src/view/markdown.ts';
import { edgesFor } from '../src/web/views/edges.ts';
import { blankQuery } from '../src/view/intents.ts';
import { specFromFile } from '../src/view/spec.ts';
import { apiSearch, paramsOf, patchSearch } from '../src/web/query.ts';

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

test('lead order is fixed, not incidental', () => {
  const [only] = edgesFor(
    [
      { src: 'a', dst: 'b', type: 'blocked_by' },
      { src: 'a', dst: 'b', type: 'project' },
    ],
  );
  assert.equal(only!.lead, 'project', 'project outranks blocked_by whatever the order in');
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

test('only query parameters reach the server, and the rest survive a patch', () => {
  assert.equal(apiSearch('?view=home&card=abc&f.status=planning'), '?view=home&f.status=planning');
  assert.equal(paramsOf('?a=1').get('a'), '1');
  assert.equal(paramsOf('a=1').get('a'), '1', 'with or without the leading ?');

  // `null` removes, `''` keeps the key present and empty — the difference the
  // saved-view override rests on.
  assert.equal(patchSearch('?f.status=planning&card=x', { 'f.status': null }), '?card=x');
  assert.equal(patchSearch('?card=x', { 'f.status': '' }), '?card=x&f.status=');
  assert.equal(patchSearch('?f.status=planning', { 'f.status': 'active' }), '?f.status=active');
});
