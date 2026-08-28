/**
 * What the server says about work nobody asked for.
 *
 * A request logs nothing: it has a caller, a status code and a client that can
 * see the answer. This is for the other half — the timer, the watcher and the
 * fetchers, which run whether or not anyone is looking and whose only evidence
 * of working used to be a note appearing in a board some hours later. A server
 * that is silent while doing nothing and silent while doing everything is a
 * server you cannot tell apart from a broken one.
 *
 * **Events, not progress.** One line when something *happened* — a file arrived,
 * a channel answered, a batch of links resolved. Not one per file read, not one
 * per HTTP call, and deliberately nothing for a note being *edited*: a vault
 * under an editor changes constantly and a log that says so is one nobody reads.
 *
 * ## Why it is off until switched on
 *
 * The sink is `null` here and `serve.ts` sets it at startup. Library code can
 * therefore log freely without deciding whether it is inside a server, a CLI run
 * or a test — `pj ls` stays clean, `node --test` stays quiet, and neither has to
 * pass a logger down through five call sites to say so. The cost is that a new
 * call to `info` from a context nobody wired up prints nothing, which is why
 * this paragraph exists.
 */

type Sink = (line: string) => void;

let sink: Sink | null = null;

/** Where lines go, or `null` for nowhere. `serve.ts` passes `console.log`. */
export function logTo(fn: Sink | null): void {
  sink = fn;
}

/**
 * The areas, spelled once.
 *
 * A closed set rather than a free string, so the column stays a column and
 * `grep '\bintake\b'` keeps meaning one thing. They are the four things that
 * happen on their own.
 */
export type Area = 'intake' | 'enrich' | 'watch' | 'index';

/**
 * Local time, not UTC.
 *
 * This is read beside a terminal by the person whose machine it is running on,
 * comparing it against when they did something. A `Z` timestamp two hours off
 * the wall clock makes that comparison a subtraction, every time.
 */
function stamp(at = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ` +
    `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`
  );
}

function emit(level: 'INFO' | 'WARN', area: Area, msg: string): void {
  sink?.(`[${level}] ${stamp()} ${area.padEnd(6)} ${msg}`);
}

export function info(area: Area, msg: string): void {
  emit('INFO', area, msg);
}

/**
 * Something did not work, and the run carried on anyway.
 *
 * Every background path here is built to survive its own failures — a channel
 * that cannot be reached, a fetcher that throws, a tick that holds — which is
 * correct and is also exactly how a system rots quietly. This is the level that
 * makes "it has been failing for a week" visible without making it fatal.
 */
export function warn(area: Area, msg: string): void {
  emit('WARN', area, msg);
}

/**
 * `3 notes` / `1 note`, because "1 notes" in a health log reads as a bug in the
 * log. The client has `plural.ts`; this is the server side of the same idea and
 * is not worth sharing a module for.
 */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * `gh:3 jira:2` — the by-kind tail several of these lines end with, with the
 * zeroes dropped so a quiet kind costs no width.
 */
export function tally(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}:${n}`)
    .join(' ');
}
