/**
 * A count and its noun, agreeing.
 *
 * `${n} note(s)` is a sentence nobody would write by hand, and the app said it
 * in five places. It is not only ugly: a message assembled from fragments cannot
 * be read aloud correctly, and it is the shape that has to be unpicked first if
 * these strings are ever translated.
 *
 * English-only and deliberately so — there is one reader and one locale, and a
 * plural-rules library for `s` would be more machinery than the problem.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
