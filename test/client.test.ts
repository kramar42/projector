import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderBody, taskLines, toggleTask } from '../src/view/markdown.ts';
import { edgesFor } from '../src/web/views/edges.ts';
import { earnsRollups } from '../src/web/views/columns.ts';
import { blankQuery, changeView, excludeFilterValue, toggleFilterValue } from '../src/view/intents.ts';
import { specFromFile, type ViewSpec } from '../src/view/spec.ts';
import { emptyReason, unusedGrouping } from '../src/view/empty.ts';
import { fuzzy, fuzzyAny, subsequence } from '../src/view/fuzzy.ts';
import { NONE } from '../src/schema/vocabulary.ts';
import { BUILTIN_FACETS } from '../src/schema/facets.ts';
import { chipClass, edgeColour, registerOf } from '../src/web/hue.ts';
import type { FacetDef } from '../src/schema/types.ts';
import type { NoteDTO, NoteDetailDTO } from '../src/web/types.ts';
import { SELF_WRITE_TTL_MS, foreignOf, whatMoved } from '../src/web/changed.ts';
import {
  apiSearch,
  paramsOf,
  patchSearch,
  pinsOf,
  pinsPatch,
  selectionOf,
  selectionPatch,
  strippedOfStrays,
} from '../src/web/query.ts';
import { asksOnlyForAVault, VAULT_PARAM, vaultOf } from '../src/web/vault.ts';
import { matchesCheatsheetRow } from '../src/web/cheatsheetKeys.ts';
import { cheatsheetStrokeOf, cheatsheetStrokeLabel } from '../src/web/cheatsheetKeys.ts';
import { ACTS, KEYMAP, railControlDescription } from '../src/view/keys.ts';
import {
  afterRemovingPage,
  exposedPageWidths,
  isCompactPage,
  revealScroll,
  SPINE_W,
  stackPages,
} from '../src/web/panel/pins.ts';
import { createEventHub, type EventStream } from '../src/web/events.ts';
import { KeyHint, KeyHints } from '../src/web/components/KeyHint.tsx';

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
test('a note body cannot smuggle markup into the panel', () => {
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

/**
 * A bare note is titled by its leading heading, and the panel has already drawn
 * that as the note's name — so rendering it again prints the title twice.
 *
 * The reader and the renderer have to agree about which line that is, and they
 * agree by both calling `headingOf`. Only an exact match is dropped: a first
 * heading that says something else is saying something else.
 */
test('the heading a note is named by is not printed under its own name', () => {
  const body = '# Monday reading\n\nWe talked about the thing.\n';
  const shown = renderBody(body, 'Monday reading');
  assert.doesNotMatch(shown, /<h1/, 'the title is the panel’s to draw, once');
  assert.match(shown, /We talked about the thing/, 'and the rest of the body survives');

  // A note that says something else in its first heading keeps it.
  assert.match(renderBody(body, 'Something else'), /<h1/);
  // As does one nobody passed a title for.
  assert.match(renderBody(body), /<h1/);
  // A heading further down is a section, never the title, so it always renders.
  assert.match(renderBody('Prose first.\n\n# A section\n', 'A section'), /<h1/);
});

test('a relative asset path is rewritten to the server route', () => {
  assert.match(renderBody('![x](assets/card/shot.png)'), /src="\/api\/asset\/assets\/card\/shot\.png"/);
  // An absolute one is left alone.
  assert.doesNotMatch(renderBody('![x](https://example.com/a.png)'), /api\/asset/);
});

// ------------------------------------------------------------- body checkboxes

/** How many checkboxes the panel would actually draw for this body. */
const drawn = (md: string) => [...renderBody(md).matchAll(/<input type="checkbox"/g)].length;

/**
 * The property the click handler stands on.
 *
 * It maps a box's ordinal in the DOM to `taskLines()[n]`, so the two counts have
 * to agree on every body — and the interesting bodies are the ones where a line
 * *looks* like a task and draws no box. One test rather than two, because either
 * half being right on its own is worth nothing here.
 */
test('a task line and a drawn checkbox are the same list, fences included', () => {
  const body = [
    '- [ ] real one',
    '',
    '```sh',
    '- [ ] not a task, it is a code sample',
    '```',
    '',
    '* [x] real two',
    '1. [ ] real three',
    '- not a task at all',
  ].join('\n');

  assert.deepEqual(taskLines(body), [0, 6, 7]);
  assert.equal(drawn(body), taskLines(body).length);

  // The box the reader clicks second is the one on line 6, not the code sample.
  assert.match(toggleTask(body, 1)!.split('\n')[6]!, /^\* \[ \] real two$/);
  // And the fenced line is untouched by every ordinal there is.
  for (let n = 0; n < 3; n++) assert.match(toggleTask(body, n)!, /^- \[ \] not a task/m);
});

test('flipping a checkbox changes one character and nothing else', () => {
  assert.equal(toggleTask('  - [ ]  buy milk  ', 0), '  - [x]  buy milk  ');
  assert.equal(toggleTask('- [X] done', 0), '- [ ] done');
  // Beyond the last box there is nothing to write, and the caller must not write.
  assert.equal(toggleTask('- [ ] one', 1), null);
  assert.equal(toggleTask('no tasks here', 0), null);
});

test('a body checkbox is enabled, because it now does something', () => {
  // It shipped `disabled` for as long as nothing listened. That was honest then
  // and a false affordance the moment `toggleTask` existed.
  assert.doesNotMatch(renderBody('- [ ] a'), /disabled/);
});

// ---------------------------------------------------------------- canvas edges

/**
 * `parent` and `project` agreeing is the expected shape for a note inside a
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
  // A reference is stored on the note that depends and points at what it
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
 * A note inside a project carries `parent` and `project` naming the same
 * note, and both point at their container — so both flip, land on one pair, and
 * collapse. This is the case the module's docstring calls the *expected* shape.
 *
 * It used to draw two lines. The flip list held only the layout relation, so the
 * `parent` edge flipped and the `project` edge beside it did not, and the pair
 * described as collapsing was the one pair that could not. The old test asserted
 * that outcome and said in its own comment that it was surprising rather than
 * obviously right, which is where this bug was visible all along.
 */
test('parent and project naming the same note collapse to one edge', () => {
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
  const fromUrl = blankQuery(null, '?f.tech=kafka&note=x');
  assert.equal(fromUrl['f.tech'], null);
  assert.equal(fromUrl.note, undefined, 'where you are looking is not part of the query');

  assert.equal(blankQuery(saved, '', 'inbox').view, 'inbox', 'landing on a view keeps it');
});

/**
 * A view answers "what am I looking at", never "what am I looking for". Picking
 * one used to run the same total blank as *revert* and *start from nothing*, so
 * a search typed into the box was gone the moment you hopped views — the same
 * class of surprise as a filter that empties itself.
 */
test('changing view keeps the search and nothing else', () => {
  const saved = specFromFile('home', {
    shape: 'board',
    q: 'kafka',
    filter: { status: ['planning'] },
  });

  const carried = changeView(saved, '?view=home&q=invoice&shape=table&f.tech=kafka', 'due');
  assert.equal(carried.view, 'due');
  assert.equal(carried.q, undefined, 'the typed search is not mentioned, so the URL keeps it');
  assert.equal(carried.shape, null, 'how the old view drew itself is the old view\'s');
  assert.equal(carried['f.status'], null, 'and so were its filters');
  assert.equal(carried['f.tech'], null, 'including one only the URL carried');

  // The spec's `q` is whichever of file and URL won, so reading it there would
  // make a *view's* stored search sticky. Only an override rides along.
  const fromFile = changeView(saved, '?view=home', 'due');
  assert.equal(fromFile.q, null, "a view's own q: belongs to the view it came from");

  // `q=` is "this view's search, suppressed" — a statement about a view that is
  // no longer the one on screen.
  assert.equal(changeView(saved, '?view=home&q=', 'due').q, null, 'an empty override is dropped');

  // Every other way of leaving a view is still a full blank.
  assert.equal(blankQuery(saved, '?view=home&q=invoice', 'home').q, null, 'revert discards it');
  assert.equal(blankQuery(saved, '?q=invoice').q, null, 'and so does starting from nothing');
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
  assert.equal(strippedOfStrays('?view=home&f.status=planning&note=x'), null);
  assert.equal(strippedOfStrays(''), null, 'no params is nothing to rewrite');
  assert.equal(strippedOfStrays('?filterstyle=chip&view=home'), '?view=home');
  assert.equal(strippedOfStrays('?filterstyle=chip'), '', 'a search that was only a stray');
  assert.equal(
    strippedOfStrays('?note=x&filterstyle=chip'),
    '?note=x',
    'which panel is open is the app\'s, and survives',
  );
  // And so is what you have picked out. Left off the owned list it would be
  // deleted from the address bar on load, exactly as `filterstyle` now is.
  assert.equal(strippedOfStrays('?sel=a,b&view=home'), null, 'sel is owned, not a stray');
  // The reading set survives; whether it is spread is transient presentation.
  assert.equal(strippedOfStrays('?pins=a,b&view=home'), null, 'pins are owned');
  assert.equal(
    strippedOfStrays('?pins=a,b&stack=1&view=home'),
    '?pins=a%2Cb&view=home',
    'a retired stack deep link is normalised without losing its pins',
  );
});

test('a suppressed key hint keeps its box in the markup', () => {
  const hint = createElement(KeyHint, { keys: 'c', means: 'edit the body' });
  const shown = renderToStaticMarkup(createElement(KeyHints, { on: true, children: hint }));
  const hidden = renderToStaticMarkup(createElement(KeyHints, { on: false, children: hint }));

  assert.match(shown, /<kbd class="keyhint"/);
  assert.match(hidden, /<kbd class="keyhint is-hidden"/);
  assert.match(hidden, /aria-hidden="true"/);
  assert.match(hidden, />c<\/kbd>/, 'the same content reserves the same intrinsic width');
});

/**
 * Pins are a list where the selection is a set: the spread draws them in pin
 * order, oldest at the left, and order is the one thing `?sel=`'s shape cannot
 * carry. The patch shape matches `selectionPatch` — empty removes the key, so
 * unpinning the last note leaves no trace in a shared URL.
 */
test('pins round-trip the URL in order, and an empty set leaves no key', () => {
  assert.deepEqual(pinsOf('?pins=b,a,c'), ['b', 'a', 'c'], 'pin order is kept, not sorted');
  assert.deepEqual(pinsOf('?view=home'), [], 'no key is no pins');
  assert.deepEqual(pinsPatch(['b', 'a']), { pins: 'b,a' });
  assert.deepEqual(pinsPatch([]), { pins: null }, 'empty removes the key');
  assert.equal(patchSearch('?view=home&pins=a', pinsPatch([])), '?view=home');
});

/**
 * A right-stuck page paints its full width over the page before it until the
 * strip has moved far enough for that page to return to normal flow. Counting
 * it as a 34px spine says page two is visible at scroll zero, while its title is
 * actually behind page three.
 */
test('revealing a spread page clears the full sticky page on its right', () => {
  assert.equal(revealScroll(0, 8, 460, 1280, 0, 2400), 0, 'the first page is already whole');
  assert.equal(revealScroll(1, 8, 460, 1280, 0, 2400), 270);
  assert.equal(revealScroll(1, 8, 460, 1280, 2400, 2400), 426, 'walking left clears elder spines');
  assert.equal(revealScroll(7, 8, 460, 1280, 0, 2400), 2400, 'the final page reaches the scroll end');
});

test('the open note is the spread\'s trailing slot, even when it is pinned', () => {
  assert.deepEqual(stackPages(['a', 'b', 'c'], null), ['a', 'b', 'c']);
  assert.deepEqual(stackPages(['a', 'b', 'c'], 'x'), ['a', 'b', 'c', 'x']);
  assert.deepEqual(stackPages(['a', 'b', 'c'], 'b'), ['a', 'c', 'b']);
});

test('a spread page presentation follows exposed paint, not its fixed card width', () => {
  assert.deepEqual(
    exposedPageWidths(
      [
        { left: 0, right: 460 },
        { left: 34, right: 494 },
        { left: 494, right: 954 },
      ],
      { left: 0, right: 900 },
    ),
    [34, 460, 406],
    'a younger sticky page covers its elder while every card remains 460px wide',
  );
  assert.equal(isCompactPage(SPINE_W * 2 + 1), false, 'content survives until only two spines fit');
  assert.equal(isCompactPage(SPINE_W * 2), true, 'the exact two-spine boundary folds the page');
});

test('live readers share one event stream until the last subscriber leaves', () => {
  class FakeStream implements EventStream {
    closed = false;
    listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    close(): void { this.closed = true; }
    emit(type: string, data: string): void {
      for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>);
    }
  }

  const streams: FakeStream[] = [];
  const hub = createEventHub(() => {
    const stream = new FakeStream();
    streams.push(stream);
    return stream;
  });
  const seen: string[] = [];
  const offA = hub.subscribe('change', (event) => seen.push(`a:${event.data}`));
  const offB = hub.subscribe('change', (event) => seen.push(`b:${event.data}`));
  const offAttention = hub.subscribe('attention', (event) => seen.push(`n:${event.data}`));

  assert.equal(streams.length, 1, 'several useLive readers must spend one HTTP connection');
  streams[0]!.emit('change', '1');
  assert.deepEqual(seen, ['a:1', 'b:1']);
  offA();
  offB();
  assert.equal(streams[0]!.closed, false, 'another event kind still owns the stream');
  offAttention();
  assert.equal(streams[0]!.closed, true);

  const offAgain = hub.subscribe('change', () => undefined);
  assert.equal(streams.length, 2, 'a later reader opens one fresh shared stream');
  offAgain();
});

test('removing a spread page keeps focus beside the place that disappeared', () => {
  assert.equal(afterRemovingPage(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(afterRemovingPage(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(afterRemovingPage(['a'], 'a'), null);
});

test('the vault is URL-owned context, not a query parameter', () => {
  const search = '?vault=notes&view=home&filterstyle=chip';

  assert.equal(vaultOf(search), 'notes');
  assert.equal(
    strippedOfStrays(search),
    '?vault=notes&view=home',
    'normalising a URL must preserve its selected vault',
  );
  assert.equal(apiSearch(search), '?view=home', 'the vault names the request header, never the view');
  assert.equal(
    patchSearch('?vault=notes&view=home', { shape: 'table' }),
    '?vault=notes&view=home&shape=table',
    'editing a view cannot lose which vault it belongs to',
  );
  assert.equal(VAULT_PARAM, 'vault');
});

/**
 * The landing view, and the regression that took it away silently.
 *
 * `App` opens the vault's `home` view when the reader has asked for nothing
 * else. That test was `if (search)` — correct while a view was a *path* and the
 * vault was not in the query — and stayed after the vault became a parameter
 * written on the way in, at which point it was true on every load and no vault
 * ever landed on its home view again. Nothing failed; every vault simply opened
 * on an ungrouped ad-hoc board, the shipped tutorial included.
 *
 * So the question is a function, and it is asserted from both sides: the vault
 * alone is context, and a parameter of any other name is something the reader
 * asked for and must be left alone.
 */
test('only the vault is context; anything else in the URL is a question', () => {
  assert.equal(asksOnlyForAVault(''), true, 'the bare root asks nothing');
  assert.equal(asksOnlyForAVault('?vault=notes'), true, 'and choosing a vault is not a question');
  assert.equal(asksOnlyForAVault('vault=notes'), true, 'with or without the ?');

  for (const asked of ['view=home', 'shape=table', 'note=a', 'pins=a,b', 'sel=a', 'q=rust', 'f.status=active']) {
    assert.equal(
      asksOnlyForAVault(`?vault=notes&${asked}`),
      false,
      `${asked} is a question the reader asked, and the landing view may not overwrite it`,
    );
  }
});

test('a practice key lights every cheatsheet pattern it can complete', () => {
  const axes = ['p', 'b'];

  assert.ok(matchesCheatsheetRow('j k h l', { key: 'j', altKey: false }, axes));
  assert.ok(matchesCheatsheetRow('g ⟨axis⟩', { key: 'p', altKey: false }, axes));
  assert.ok(matchesCheatsheetRow('g ⇧⟨axis⟩', { key: 'P', altKey: false }, axes));
  assert.ok(matchesCheatsheetRow('g ⟨axis⟩', { key: 'P', altKey: false }, axes), 'Shift still reaches this axis');
  assert.ok(matchesCheatsheetRow('g ⇧⟨axis⟩', { key: 'p', altKey: false }, axes), 'the axis row trains either direction');
  assert.ok(matchesCheatsheetRow('⟨axis⟩', { key: 'P', altKey: false }, axes), 'the vault axis itself is case-insensitive');
  assert.ok(matchesCheatsheetRow('⌥j ⌥k', { key: 'j', altKey: true }, axes));
  assert.ok(matchesCheatsheetRow('gg G', { key: 'g', altKey: false }, axes), 'a prefix teaches its completion');
  assert.ok(matchesCheatsheetRow('⏎', { key: 'Enter', altKey: false }, axes));

  assert.ok(!matchesCheatsheetRow('j k h l', { key: 'j', altKey: true }, axes));
  assert.ok(!matchesCheatsheetRow('g ⟨axis⟩', { key: 'z', altKey: false }, axes));
});

test('practice mode recognises the physical option keys a Mac actually sends', () => {
  const axes = ['p'];
  // macOS turns ⌥J into ∆ and ⌥1 into ¡. `code`, not those layout glyphs, is
  // the grammar's stable name — the dispatcher already depends on that fact.
  const optionJ = cheatsheetStrokeOf({ key: '∆', code: 'KeyJ', altKey: true, shiftKey: false });
  const optionOne = cheatsheetStrokeOf({ key: '¡', code: 'Digit1', altKey: true, shiftKey: false });

  assert.deepEqual(optionJ, { key: 'j', altKey: true });
  assert.ok(matchesCheatsheetRow('⌥j ⌥k', optionJ, axes));
  assert.ok(!matchesCheatsheetRow('j k', optionJ, axes), '⌥J is never bare J');
  assert.deepEqual(optionOne, { key: '1', altKey: true });
  assert.ok(matchesCheatsheetRow('⌥1–9', optionOne, axes));
  assert.ok(!matchesCheatsheetRow('1–9', optionOne, axes), '⌥1 is never bare 1');

  assert.ok(
    matchesCheatsheetRow('⟨axis⟩ 1–9', cheatsheetStrokeOf({ key: '2', code: 'Digit2', altKey: false, shiftKey: false }), axes),
    'a completion is useful to learn even when it is the second stroke',
  );
  assert.equal(cheatsheetStrokeLabel({ key: 'P', altKey: false }), '⇧P');
});

test('practice mode keeps unmodified keys in the active keyboard layout', () => {
  // On Dvorak the physical QWERTY J key produces `h`. Only Option commands
  // belong to a physical key: ordinary navigation must practice what the layout
  // actually sends, exactly as the dispatcher does.
  const dvorakH = cheatsheetStrokeOf({ key: 'h', code: 'KeyJ', altKey: false, shiftKey: false });
  const dvorakHShifted = cheatsheetStrokeOf({ key: 'H', code: 'KeyJ', altKey: false, shiftKey: true });

  assert.deepEqual(dvorakH, { key: 'h', altKey: false });
  assert.deepEqual(dvorakHShifted, { key: 'H', altKey: false });
  assert.ok(matchesCheatsheetRow('h l', dvorakH, []));
  assert.ok(!matchesCheatsheetRow('j k', dvorakH, []));
});

test('a keyed rail control has one phrase in its tooltip, palette and cheatsheet', () => {
  const rows = KEYMAP.flatMap((section) => section.rows);
  for (const act of ACTS) {
    if (act.command.kind !== 'rail' || !act.keys) continue;
    const phrase = railControlDescription(act.command.control);
    assert.equal(act.palette, phrase, `${act.id} palette`);
    assert.equal(rows.find((row) => row.keys === act.keys)?.does, phrase, `${act.id} cheatsheet`);
  }
  assert.equal(railControlDescription('collapse'), 'collapse sidebar');
});

/**
 * A selection round-trips through the URL, because that is where it lives: a
 * change of shape unmounts the view, and picking the same twelve notes again is
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
  assert.equal(apiSearch('?view=home&note=abc&f.status=planning'), '?view=home&f.status=planning');
  // The selection is the app's, not the query's. Both halves matter: a saved view
  // must not note one, and `useLive` blanks its data before refetching — so a
  // `sel` that counted as a query param would flash the pane on every click.
  assert.equal(apiSearch('?view=home&sel=a,b&f.status=planning'), '?view=home&f.status=planning');
  assert.equal(paramsOf('?a=1').get('a'), '1');
  assert.equal(paramsOf('a=1').get('a'), '1', 'with or without the leading ?');

  // `null` removes, `''` keeps the key present and empty — the difference the
  // saved-view override rests on.
  assert.equal(patchSearch('?f.status=planning&note=x', { 'f.status': null }), '?note=x');
  assert.equal(patchSearch('?note=x', { 'f.status': '' }), '?note=x&f.status=');
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
 * note came to read as a purple `parent` chip on a board and as plain text in
 * the editor, and how the built-in axis was drawn in purple by the note picker
 * while declaring `blue` in its own definition.
 */
test("a reference draws as a note, and the app's own axis in the app's colour", () => {
  // A label axis: its family, and a bucket that declares one wins and fills.
  assert.equal(chipClass(axis({ hue: 'green' })), 'facet-hue-green');
  assert.equal(
    chipClass(axis({ type: 'date', buckets: [{ name: 'overdue', upTo: -1, hue: 'red' }] }), 'overdue'),
    'facet-hue-red is-filled',
  );
  // No hue: the chip recedes. The Hints Are Hueless Rule.
  assert.equal(chipClass(axis({})), 'facet-muted');
  assert.equal(chipClass(undefined), 'facet-muted', 'an axis the vocabulary does not have');

  // A reference draws as a note however it is declared — a `hue:` on one is a
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

// ------------------------------------------- something changed, and whose change

/**
 * The two decisions behind the foreign-change mark.
 *
 * Neither the `EventSource`, the watcher nor the pseudo-element that flushes can be
 * wrong in a way a reader notices if these are right, and none of them is testable
 * without a DOM this repo does not have. So the rules moved into `changed.ts` and
 * the wiring stayed thin — which is the same trade the rest of this file makes.
 */

// The detail DTO, because `whatMoved` compares two reads of the panel's route —
// the only DTO that still carries a body.
const note = (over: Partial<NoteDetailDTO> = {}): NoteDetailDTO =>
  ({
    id: 'n',
    title: 'A note',
    body: 'prose',
    facets: {},
    links: [],
    blockedBy: [],
    buckets: {},
    isProject: false,
    refCount: 0,
    ...over,
  }) as NoteDetailDTO;

/**
 * The property the whole feature rests on: **your own edit never flashes at you.**
 *
 * Get this wrong in the generous direction and the app pulses on every chip click,
 * because the server announces a route's write immediately and the watcher announces
 * the same bytes again when its write-finish settles — the same id, twice, the second
 * time late. That is why the window exists rather than a request handshake.
 */
test('a change this tab caused is not a foreign change', () => {
  // Every time below is measured from the stamp, because that is what the rule
  // measures from. Writing them against a separate "now" is how the first draft of
  // this test asserted a 2100ms gap was inside a 2000ms window.
  const wroteAt = 10_000;
  const mine = () => new Map([['a', wroteAt]]);

  assert.deepEqual(foreignOf(['a'], mine(), wroteAt + 100), [], 'our own write, announced back');
  assert.deepEqual(foreignOf(['b'], mine(), wroteAt + 100), ['b'], 'a note we never wrote');
  assert.deepEqual(
    foreignOf(['a', 'b'], mine(), wroteAt + 100),
    ['b'],
    'one batch, both kinds — only the other writer’s survives',
  );

  // The late half of the double announcement: the watcher's copy arrives after the
  // route's, and it is still ours.
  assert.deepEqual(
    foreignOf(['a'], mine(), wroteAt + SELF_WRITE_TTL_MS),
    [],
    'still ours at the last moment of the window',
  );

  // Past it, an agent editing the same note is news again — and the stamp is dropped
  // on the way past, so the map cannot grow without bound.
  const aged = mine();
  assert.deepEqual(
    foreignOf(['a'], aged, wroteAt + SELF_WRITE_TTL_MS + 1),
    ['a'],
    'past the window it is somebody else',
  );
  assert.equal(aged.has('a'), false, 'an expired stamp is pruned as it is read');
});

/**
 * What moved, as keys — never as a sentence. The caller lights the regions these
 * name, so the reader's eye lands on the new value with nothing to read.
 */
test('a diff names the parts that moved, and only those', () => {
  const before = note({
    title: 'Before',
    body: 'one',
    facets: { status: ['active'], tech: ['kafka'] },
    links: [{ raw: 'jira:A' }] as NoteDTO['links'],
  });

  assert.deepEqual(whatMoved(before, before), [], 'nothing moved');
  assert.deepEqual(whatMoved(null, before), [], 'the first read of a note is not a change');

  assert.deepEqual(
    whatMoved(before, note({ ...before, facets: { status: ['done'], tech: ['kafka'] } })),
    ['status'],
    'one axis, and not the one beside it',
  );
  assert.deepEqual(
    whatMoved(before, note({ ...before, title: 'After' })),
    ['title'],
  );
  assert.deepEqual(
    whatMoved(before, note({ ...before, body: 'two' })),
    ['body'],
  );
  assert.deepEqual(
    whatMoved(before, note({ ...before, links: [] })),
    ['links'],
  );

  // An axis the other side does not have at all, in both directions — an agent
  // clearing a facet is the case that would otherwise go unmarked.
  assert.deepEqual(
    whatMoved(before, note({ ...before, facets: { tech: ['kafka'] } })),
    ['status'],
    'an axis removed',
  );
  assert.deepEqual(
    whatMoved(before, note({ ...before, facets: { ...before.facets, owner: ['person-e'] } })),
    ['owner'],
    'an axis added',
  );

  // Order within an axis is a change: a board reads the first value as the primary.
  assert.deepEqual(
    whatMoved(
      note({ ...before, facets: { status: ['a', 'b'] } }),
      note({ ...before, facets: { status: ['b', 'a'] } }),
    ),
    ['status'],
    'reordered values are a change',
  );

  // And the separator cannot make two values look like one.
  assert.deepEqual(
    whatMoved(
      note({ ...before, facets: { status: ['a b'] } }),
      note({ ...before, facets: { status: ['a', 'b'] } }),
    ),
    ['status'],
    'one value split into two',
  );

  assert.deepEqual(
    whatMoved(before, note({ ...before, title: 'After', body: 'two', facets: {} })),
    ['title', 'status', 'tech', 'body'],
    'several at once, in the order the panel draws them',
  );
});

// ---------------------------------------------------------------- negation

/**
 * A filter value has three states, and a click names the one it wants.
 *
 * The property worth pinning is that no sequence of clicks can leave an axis
 * holding a value and its negation at once: that query matches nothing, and
 * neither click asked for nothing.
 */
test('a value is in, out, or neither — never both', () => {
  const spec = specFromFile('t', { shape: 'board' });
  const filterOf = (s: ViewSpec) => s.query.filter?.project ?? [];

  const on = toggleFilterValue(spec, 'project', 'project-a');
  assert.deepEqual(filterOf(on), ['project-a']);

  // Alt-clicking a selected value moves it across rather than adding a second
  // claim about it.
  const out = excludeFilterValue(on, 'project', 'project-a');
  assert.deepEqual(filterOf(out), ['-project-a']);

  // And plain-clicking an excluded one brings it back the same way.
  assert.deepEqual(filterOf(toggleFilterValue(out, 'project', 'project-a')), ['project-a']);

  // Either gesture, twice, is off.
  assert.deepEqual(filterOf(excludeFilterValue(out, 'project', 'project-a')), []);
  assert.deepEqual(filterOf(toggleFilterValue(on, 'project', 'project-a')), []);
});

test('excluding one value leaves the rest of the axis alone', () => {
  const spec = toggleFilterValue(specFromFile('t', { shape: 'board' }), 'project', 'project-a');
  const both = excludeFilterValue(spec, 'project', 'project-b');
  // "in project-a, and not in project-b" — the query a multi-valued axis needs and no
  // positive selection can express.
  assert.deepEqual(both.query.filter?.project, ['project-a', '-project-b']);
});


// ---------------------------------------------------------------- table columns

test('only a table of projects earns the roll-up columns', () => {
  // `Notes`, `Blocked` and `Untriaged` are `projectRollups` numbers, and only a
  // note with a `project:` block has one. The gate asked `some`, so one project
  // note among ordinary notes grew three columns that were blank on every row
  // that cannot have a number — which is width spent to say "not applicable".
  const face = (id: string, isProject: boolean) => ({ id, isProject }) as NoteDTO;
  const notes: Record<string, NoteDTO> = {
    p1: face('p1', true),
    p2: face('p2', true),
    card: face('card', false),
  };

  assert.equal(earnsRollups(['p1', 'p2'], notes), true, 'every row a project: the numbers are the point');
  assert.equal(earnsRollups(['p1', 'card'], notes), false, 'one project does not earn three columns for the rest');
  assert.equal(earnsRollups(['card'], notes), false);

  // `every` over nothing is vacuously true, which would draw the columns for a
  // table that has just proved it has no rows.
  assert.equal(earnsRollups([], notes), false, 'an empty table earns nothing');

  // An id the payload does not carry is not a project. Optional chaining decides
  // this, so it is worth stating: a stale `?sel=` must not conjure a column.
  assert.equal(earnsRollups(['ghost'], notes), false);
});

// ------------------------------------------------------------- empty states

/**
 * An empty result had one rendering and more than one cause.
 *
 * "No notes match" is true of a filter that is too tight, of a search that found
 * nothing, and of an axis no note in the vault has ever carried. The next move
 * differs every time — widen, rephrase, or go and set the axis on something — and
 * the third was the one with no way of being said.
 */
const VOCAB = {
  facets: {
    status: { label: 'Status', type: 'label', values: ['planning', 'active'], open: false, single: true },
    waiting_on: { label: 'Waiting on', type: 'label', values: [], open: true, single: false, blocking: true },
    blocked_by: { label: 'Blocked by', type: 'ref', values: [], open: true, single: false, blocking: true },
  } as unknown as Parameters<typeof emptyReason>[0]['facets'],
  // `waiting_on` and `blocked_by` are declared and carried by nobody.
  axisPopulation: { status: 9 },
  counts: { notes: 9 },
};

const result = (query: object, total = 0, universe = 0) =>
  ({ spec: { query } as unknown as ViewSpec, total, universe });

test('an axis nobody has ever set says so, rather than blaming the filter', () => {
  const r = emptyReason(VOCAB, result({ filter: { waiting_on: ['person-a'] } }));
  assert.match(r!.text, /No note carries a value on Waiting on/);
  assert.equal(r!.axis, 'waiting_on', 'the caller can point at the row at fault');
});

/**
 * The hop the aging view needs. `blocked` is computed and every note has a value
 * on it, so the axis is never unpopulated — but its values *are* the names of the
 * blocking facets, so an empty `blocked: [waiting_on]` is a fact about
 * `waiting_on` and can be reported as one.
 */
test('a computed blocking value is explained by the axis underneath it', () => {
  const r = emptyReason(VOCAB, result({ filter: { blocked: ['waiting_on'] } }));
  assert.equal(r!.axis, 'waiting_on');
  assert.match(r!.text, /No note carries a value on Waiting on/);

  // Two blocking values is a question with two answers, so it is not answered.
  const both = emptyReason(VOCAB, result({ filter: { blocked: ['waiting_on', 'blocked_by'] } }));
  assert.equal(both!.axis, undefined);

  // `clear` is not a blocking facet, so there is no axis to blame.
  assert.equal(emptyReason(VOCAB, result({ filter: { blocked: ['clear'] } }))!.axis, undefined);
});

test('a populated axis is never blamed, and a full result is never explained', () => {
  assert.match(emptyReason(VOCAB, result({ filter: { status: ['active'] } }))!.text, /No notes match/);
  assert.equal(emptyReason(VOCAB, result({ filter: { waiting_on: ['x'] } }, 3)), null, 'not empty');
});

test('asking for the absence of an unused axis is not a broken axis', () => {
  // Every note satisfies `waiting_on: (none)` when nothing carries it, so an
  // empty result there means something *else* narrowed it — never the axis.
  const r = emptyReason(VOCAB, result({ filter: { waiting_on: [NONE], status: ['active'] } }, 0, 4));
  assert.match(r!.text, /No note matches this filter/);
});

/**
 * A view that says what its own emptiness means outranks every deduction.
 *
 * The intake queue is the case that forced it: `intake` is carried only by
 * unjudged cards, so judging the last one empties the axis and the unused-axis
 * branch would call an axis you just drained "declared and unused".
 */
test('a view can say what its own emptiness means, and it wins', () => {
  const done = { spec: { query: { filter: { intake: ['unjudged'] } }, whenEmpty: 'The queue is clear.' } as unknown as ViewSpec, total: 0, universe: 9 };
  assert.equal(emptyReason(VOCAB, done)!.text, 'The queue is clear.');

  // Even against the unused-axis branch, which is the one that would be wrong.
  const drained = { ...done, spec: { ...done.spec, query: { filter: { waiting_on: ['person-a'] } } } as unknown as ViewSpec };
  assert.equal(emptyReason(VOCAB, drained)!.text, 'The queue is clear.');

  // And not at all when there is something to draw.
  assert.equal(emptyReason(VOCAB, { ...done, total: 3 }), null);
});

test('the general answers name what actually narrowed it', () => {
  assert.match(emptyReason(VOCAB, result({}, 0, 5))!.text, /this filter/);
  assert.match(emptyReason(VOCAB, result({ q: 'keycloak' }))!.text, /keycloak/);
  assert.match(
    emptyReason({ ...VOCAB, counts: { notes: 0 } }, result({}))!.text,
    /no notes yet/,
    'an empty vault is not a filter problem',
  );
});

/**
 * The board's other failure, which is not an empty result at all: group by an
 * unused axis and every note lands in `(none)` while the declared columns draw
 * blank. `total` is healthy, so the empty text must stay silent and this must not.
 */
test('a board grouped by an unused axis is told so while its result is full', () => {
  const full = result({ groupBy: ['waiting_on'] }, 9, 9);
  assert.equal(emptyReason(VOCAB, full), null, 'nine notes is not an empty result');
  assert.match(unusedGrouping(VOCAB, full)!.text, /No note carries a value on Waiting on/);
  assert.match(unusedGrouping(VOCAB, full)!.text, /every column here is empty/, 'and why it looks like this');
  // Present tense, always: `axisPopulation` counts what notes carry *now*, so a
  // claim about history is a claim the number cannot support. An axis drained to
  // zero — which is what judging the last intake card does — reads identically to
  // one never used, and only one of those two sentences would be true.
  assert.doesNotMatch(unusedGrouping(VOCAB, full)!.text, /\b(ever|never)\b/i);
  // The gesture belongs to `.board-nudge`, which says it already. Two
  // instructions about one drag on one board is the thing this avoids.
  assert.doesNotMatch(unusedGrouping(VOCAB, full)!.text, /drag/i);

  assert.equal(unusedGrouping(VOCAB, result({ groupBy: ['status'] }, 9, 9)), null);
  // The second grouping axis makes lanes, not columns, so it is not this state.
  assert.equal(unusedGrouping(VOCAB, result({ groupBy: ['status', 'waiting_on'] }, 9, 9)), null);
});

// ------------------------------------------------------------------- fuzzy

/**
 * fzf's rule without fzf's ranking: characters in order, anything between, and
 * no score. The absence of the score is the part worth testing — a ranked list
 * would reorder itself as you type, and the app does not make claims it cannot
 * compute (C8).
 */
test('a needle matches when its letters appear in order', () => {
  assert.ok(fuzzy('nst', 'needs status'));
  assert.ok(fuzzy('gp', 'group by'));
  assert.ok(fuzzy('status', 'status'), 'an exact match is still a match');
  assert.ok(fuzzy('SsT', 'needs status'), 'both sides fold case');
  assert.ok(fuzzy('', 'anything'), 'an untouched filter box matches everything');

  assert.ok(!fuzzy('tsn', 'needs status'), 'order is the whole rule');
  assert.ok(!fuzzy('zz', 'needs status'));
});

test('the positions are the earliest ones, so they can be drawn', () => {
  assert.deepEqual(subsequence('nd', 'needs'), [0, 3]);
  assert.deepEqual(subsequence('', 'needs'), []);
  assert.equal(subsequence('x', 'needs'), null);
  // Greedy and left-to-right, which is what makes it the same answer every time.
  assert.deepEqual(subsequence('ee', 'needs'), [1, 2]);
});

test('a space in the needle is intent, not a character to find', () => {
  // Someone typing two words means both of them; the gap is how they said so,
  // and a haystack with no literal space would otherwise never match.
  assert.ok(fuzzy('new card', 'newcard'));
  assert.ok(fuzzy('nc', 'new card'));
});

test('the characters may not be spread across two fields', () => {
  // `fuzzyAny` asks each field on its own. Letting a match straddle a title and
  // an id would pair rows no reader would call related.
  assert.ok(fuzzyAny('kc', 'keycloak', 'other-id'));
  assert.ok(fuzzyAny('oth', 'keycloak', 'other-id'));
  assert.ok(!fuzzyAny('keyother', 'keycloak', 'other-id'));
});
