/**
 * Move the coverage vault's dates back to where they belong, relative to today.
 *
 *   bun run redate [<vault>]        # default: vaults/coverage
 *
 * `vaults/coverage` carries every state the app can draw, and two of its axes are
 * computed against the current date rather than stored: `due` sorts a note into
 * overdue / today / week / later, and `staleness` reads `updated` as week / month
 * / older. A committed date is therefore a date that stops meaning what it was
 * chosen to mean. The `today` column empties tomorrow; within seven weeks every
 * dated note is overdue and four columns have collapsed into one.
 *
 * That is not a hypothetical. `.chip.is-overdue` once shipped with its text the
 * same colour as its background, because no note in a real vault carried a `due`
 * date and the rule had never rendered once. A fixture whose date buckets go
 * empty is a fixture that cannot catch it happening again.
 *
 * So the notes are committed — they are markdown, and adding a state should mean
 * writing a note rather than editing a string literal in a script — and only the
 * dates are derived. **Each date says which band it is demonstrating**, in a
 * comment beside it:
 *
 *     due: ["2026-08-17"]  # overdue
 *     updated: 2026-08-25  # fresh
 *
 * which is why this script needs no table of note ids, and why a person reading
 * the note can see what the date is for. Run it before looking at the vault; it
 * rewrites nothing but the dates, so its diff is the whole of what it did.
 */
import { readFileSync, writeFileSync, globSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Days from today, per band.
 *
 * `due`'s buckets are declared in the vault's own `facets.yaml` as
 * `{overdue: upTo -1, today: upTo 0, week: 7}` with everything past the last
 * falling to `later`; `staleness` reads `updated` as week ≤7, month ≤31, older
 * beyond. One date per band, placed away from the boundary so a clock skew or a
 * run just before midnight cannot move it into the neighbouring column.
 */
const OFFSETS = {
  due: { overdue: -9, today: 0, week: 3, later: 45 },
  when: { fresh: -1, week: -4, month: -20, older: -400 },
};

/**
 * Today is the **UTC** date, because that is the day the app compares a `due`
 * against — `runQuery` defaults its `today` to `new Date().toISOString()`. Anchor
 * on local midnight instead and every date lands a day out for half the world,
 * which is exactly enough to empty the `today` column this exists to fill.
 */
const DAY = 86400000;
const midnight = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const iso = (days) => new Date(midnight + days * DAY).toISOString().slice(0, 10);

/** `due: ["2026-08-17"]  # overdue` and `updated: 2026-08-25  # fresh`. */
const DUE = /^(\s*due:\s*\["?)(\d{4}-\d{2}-\d{2})("?\]\s*#\s*)(\w+)(\s*)$/;
const WHEN = /^((?:created|updated):\s*)(\d{4}-\d{2}-\d{2})(\s*#\s*)(\w+)(\s*)$/;

const root = resolve(process.argv[2] ?? 'vaults/coverage');
let moved = 0;
let files = 0;
const unknown = [];

for (const file of globSync(`${root}/**/*.md`)) {
  const before = readFileSync(file, 'utf8');
  const after = before
    .split('\n')
    .map((line) => {
      for (const [re, table] of [
        [DUE, OFFSETS.due],
        [WHEN, OFFSETS.when],
      ]) {
        const m = re.exec(line);
        if (!m) continue;
        const [, head, was, sep, band, tail] = m;
        if (!(band in table)) {
          unknown.push(`${file}: no such band "${band}"`);
          return line;
        }
        const now = iso(table[band]);
        if (now !== was) moved++;
        return `${head}${now}${sep}${band}${tail}`;
      }
      return line;
    })
    .join('\n');
  if (after !== before) {
    writeFileSync(file, after, 'utf8');
    files++;
  }
}

if (unknown.length) {
  console.error(`unknown bands — the comment must name one of ${Object.keys(OFFSETS.due).join(', ')} (due) or ${Object.keys(OFFSETS.when).join(', ')} (created/updated):`);
  for (const u of unknown) console.error(`  ${u}`);
  process.exit(1);
}

console.log(
  moved
    ? `${root}\n  ${moved} date(s) moved across ${files} file(s) — today is ${iso(0)}`
    : `${root}\n  already dated for today (${iso(0)})`,
);
