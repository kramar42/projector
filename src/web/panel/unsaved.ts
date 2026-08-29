/**
 * What the close prompt names, so it says what is actually at risk.
 *
 * In its own module rather than in `NotePanel.tsx`, because the shell's key
 * chain asks this question and the panel is a lazy chunk: Escape must be able
 * to word the prompt without the markdown renderer coming along to answer it.
 */
export function whatIsUnsaved(u: { body: boolean; frontmatter: boolean }): string {
  if (u.body && u.frontmatter) return 'The body and the frontmatter have';
  return u.body ? 'The body has' : 'The frontmatter has';
}
