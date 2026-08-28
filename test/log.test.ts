import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, info, logTo, tally, warn } from '../src/server/log.ts';

/**
 * The format is a decision, so it is pinned here rather than left to whatever
 * the last edit happened to produce. What is asserted is the *shape* — level,
 * a local timestamp, an area column — and not the wording of any one line.
 */
test('a background line says level, local time and area, in fixed columns', () => {
  const lines: string[] = [];
  logTo((l) => lines.push(l));
  try {
    info('intake', 'work/git saw 3');
    warn('enrich', '1 fetcher error');
  } finally {
    logTo(null);
  }

  assert.match(lines[0]!, /^\[INFO\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} intake work\/git saw 3$/);
  assert.match(lines[1]!, /^\[WARN\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} enrich 1 fetcher error$/);
  // Local time, not UTC: this is read beside a terminal on the machine it runs
  // on, and a `Z` stamp two hours off the wall clock makes every comparison a
  // subtraction. The hour is the one the clock in the corner shows.
  assert.ok(lines[0]!.includes(String(new Date().getHours()).padStart(2, '0') + ':'));
  // The area column is padded so the messages line up under each other.
  assert.equal(lines[0]!.indexOf('work/git'), lines[1]!.indexOf('1 fetcher'));
});

test('nothing is written until a sink is set, which is what keeps the CLI and the tests quiet', () => {
  // The default. `serve.ts` opts in at startup; `pj ls` and `node --test` import
  // the same modules and must not inherit a server's log.
  logTo(null);
  assert.doesNotThrow(() => info('watch', 'this goes nowhere'));

  const lines: string[] = [];
  logTo((l) => lines.push(l));
  info('watch', 'this does not');
  logTo(null);
  info('watch', 'and this goes nowhere again');
  assert.equal(lines.length, 1);
});

test('a tally drops the zeroes and a count knows about one', () => {
  // `gh:0 jira:0 claude:3` spends three columns to say one thing, and the
  // zeroes are the part nobody is reading for.
  assert.equal(tally({ gh: 0, jira: 2, claude: 1 }), 'claude:1 jira:2');
  assert.equal(tally({ gh: 0 }), '', 'nothing happened is the empty string, not "gh:0"');

  // "1 notes" in a health log reads as a bug in the log.
  assert.equal(count(1, 'note'), '1 note');
  assert.equal(count(3, 'note'), '3 notes');
  assert.equal(count(0, 'note'), '0 notes');
  assert.equal(count(2, 'entry', 'entries'), '2 entries');
});
