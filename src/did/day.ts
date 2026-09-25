/**
 * A local calendar day as a half-open window.
 *
 * Local, because "what did I do on Tuesday" means your Tuesday: a UTC day would
 * move an evening's commits onto the next date for anyone east of Greenwich
 * after midnight UTC, and onto the previous one for anyone west.
 */
export interface Day {
  day: string;
  start: Date;
  end: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `today`, `yesterday` or `YYYY-MM-DD`. Anything else is refused, never guessed at. */
export function parseDay(arg: string | undefined, now = new Date()): Day | { error: string } {
  const spec = (arg ?? 'today').trim();
  let y: number, m: number, d: number;
  if (spec === 'today' || spec === 'yesterday') {
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (spec === 'yesterday' ? 1 : 0));
    [y, m, d] = [base.getFullYear(), base.getMonth(), base.getDate()];
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec);
    if (!match) return { error: `not a day: ${spec}. Use today, yesterday or YYYY-MM-DD` };
    [y, m, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  }
  const start = new Date(y, m, d);
  // A date the calendar does not have (2026-02-30) rolls over in `Date`; refuse it.
  if (start.getMonth() !== m || start.getDate() !== d) return { error: `not a day: ${spec}` };
  return { day: localDate(start), start, end: new Date(y, m, d + 1) };
}

export function within(iso: string | undefined, day: Day): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= day.start.getTime() && t < day.end.getTime();
}
