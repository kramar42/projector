import type { NoteDTO } from '../types.ts';

/**
 * Which columns a table draws beyond the ones its view asked for.
 *
 * A table's columns are its `show` list — that is the whole point of one
 * parameter serving chips and columns — and these are the exceptions: numbers
 * that are not a facet on any note, so nothing in `show` could name them.
 * Keeping the exceptions in one named place is what stops them growing back.
 */

/**
 * Whether this result set earns the project roll-up columns.
 *
 * `Notes`, `Blocked` and `Untriaged` come from `projectRollups`, which has a
 * number only for a note carrying a `project:` block. The gate asked whether
 * *some* row was a project, so a single project note in a mixed result grew three
 * columns that were blank for every ordinary note beside it — width spent on a
 * number those rows cannot have.
 *
 * `every` instead, which is what `views/projects.yaml` and `views/portfolio.yaml`
 * already state with `filter: type=[project]`: a table *of projects* has the
 * numbers in every row, and any other table has them in almost none. A mixed
 * table that wants them can say so by filtering, which is the query saying it out
 * loud rather than the renderer guessing.
 *
 * The length guard is not defensive: `every` over nothing is vacuously true, so
 * an empty result would otherwise draw the three columns it has just finished
 * proving it has no rows for.
 */
export function earnsRollups(ids: string[], notes: Record<string, NoteDTO>): boolean {
  return ids.length > 0 && ids.every((id) => notes[id]?.isProject);
}
