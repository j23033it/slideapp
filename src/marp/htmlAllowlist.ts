import { Marp } from '@marp-team/marp-core'

// Keep the grammar deliberately narrower than CSS: the value is emitted only
// if every declaration, unit and its order is understood by the editor.
export function boxStyle(value: string): string {
  return /^[ \t]*position[ \t]*:[ \t]*absolute[ \t]*;[ \t]*left[ \t]*:[ \t]*-?\d+px[ \t]*;[ \t]*top[ \t]*:[ \t]*-?\d+px[ \t]*;[ \t]*width[ \t]*:[ \t]*\d+px[ \t]*(?:;[ \t]*font-size[ \t]*:[ \t]*\d+pt[ \t]*)?(?![\s\S])/.test(value) ? value : ''
}

// A div allowlist alone cannot require data-box on every admitted div. It must
// only be used together with installBoxHtmlRules.
export const boxHtmlAllowlist = {
  ...Marp.html,
  div: { 'data-box': true, style: boxStyle },
}
