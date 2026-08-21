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
      { src: 'x', dst: 'p', type: 'blocks' },
    ],
    [],
  );
  assert.equal(edges.length, 1, 'two relations, one line');
  assert.deepEqual(edges[0]!.types, ['project', 'blocks']);
  assert.equal(edges[0]!.lead, 'project');
});

test('a hierarchy edge points the way the graph opens', () => {
  // `hierarchy` is the canvas's layout relation — always one, from `data.layout`.
  const [flipped] = edgesFor([{ src: 'child', dst: 'parent', type: 'parent' }], ['parent']);
  assert.deepEqual([flipped!.src, flipped!.dst], ['parent', 'child'], 'drawn parent → child');

  const [kept] = edgesFor([{ src: 'a', dst: 'b', type: 'blocks' }], ['parent']);
  assert.deepEqual([kept!.src, kept!.dst], ['a', 'b'], 'a non-hierarchy keeps its direction');
});

/**
 * Only relations stored the same way round can collapse. Since `hierarchy` holds
 * exactly the layout relation, a `parent` edge flips while a `project` edge beside
 * it does not — so the pair the docstring describes as collapsing does not, when
 * `parent` is what the canvas lays out by. Asserted here because it is surprising,
 * not because it is obviously right.
 */
test('a flipped relation and an unflipped one stay separate edges', () => {
  const edges = edgesFor(
    [
      { src: 'child', dst: 'p', type: 'parent' },
      { src: 'child', dst: 'p', type: 'project' },
    ],
    ['parent'],
  );
  assert.equal(edges.length, 2);
  assert.deepEqual(
    edges.map((e) => [e.src, e.dst, e.lead]),
    [
      ['p', 'child', 'parent'],
      ['child', 'p', 'project'],
    ],
  );
});

test('a pair that disagrees stays two edges', () => {
  const edges = edgesFor(
    [
      { src: 'x', dst: 'p1', type: 'parent' },
      { src: 'x', dst: 'p2', type: 'project' },
    ],
    ['parent'],
  );
  assert.equal(edges.length, 2, 'different targets are the case worth seeing');
});

test('lead order is fixed, not incidental', () => {
  const [only] = edgesFor(
    [
      { src: 'a', dst: 'b', type: 'blocks' },
      { src: 'a', dst: 'b', type: 'project' },
    ],
    [],
  );
  assert.equal(only!.lead, 'project', 'project outranks blocks whatever the order in');
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
