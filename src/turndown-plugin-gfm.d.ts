/**
 * Ambient declaration for `@joplin/turndown-plugin-gfm`, which ships no types
 * and has no DefinitelyTyped package.
 * Extracted verbatim from DeepSeek Harness `packages/web/tool-web/src/turndown-plugin-gfm.d.ts` (MIT).
 */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  /** The composite GitHub-flavored-markdown plugin (tables, strikethrough, task lists, highlighted code blocks). */
  export const gfm: TurndownService.Plugin
}
