import { cssColor, type Paragraph } from './model'
import { nativeStyleReason, pixels } from './styles'

/** CSSOM returns a quoted CSS string, with hexadecimal escapes rather than JS escapes. */
export function markerText(content: string): string {
  const description = content.replace(/url\(.*?\)/g, 'url([image])')
  const match = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')$/s.exec(content)
  if (!match) throw new Error(`Unsupported CSS ::marker content: ${description}`)
  const decoded = (match[1] ?? match[2] ?? '').replace(/\\([\da-fA-F]{1,6})(?:\s)?|\\(.)/gs, (_, hex: string, literal: string) => hex ? String.fromCodePoint(Number.parseInt(hex, 16) || 0xFFFD) : literal)
  if (!decoded) return ''
  // OOXML buChar is one glyph. Whitespace is represented by measured indentation.
  const character = decoded.trimEnd()
  if ([...character].length !== 1 || character.codePointAt(0)! > 0xFFFF || /[\p{Mark}\p{Control}\p{Extended_Pictographic}]/u.test(character)) throw new Error(`Unsupported CSS ::marker content: ${description}`)
  return decoded
}
export function markerCharacter(content: string): string | undefined { return markerText(content).trimEnd() || undefined }
export function measureMarker(li: Element, fonts: Map<string, string>, scale: number): { marker?: NonNullable<Paragraph['list']>['marker']; suppressed?: boolean; text?: string } {
  const base = getComputedStyle(li), style = getComputedStyle(li, '::marker')
  if (base.display && base.display !== 'list-item') return { suppressed: true }
  const content = style.content
  if (['hidden', 'collapse'].includes(style.visibility) || style.display === 'none') return { suppressed: true }
  if (content === 'none' || content === '\"\"' || content === "''") return { suppressed: true }
  const character = content && content !== 'normal' ? markerCharacter(content) : undefined
  if (!character && base.listStyleType === 'none') return { suppressed: true }
  const reason = nativeStyleReason(style)
  if (reason) throw new Error(`::marker ${reason}`)
  // buFont/size/color are independently expressible; bullet bold/italic are inherited.
  for (const property of ['font-weight', 'font-style', 'letter-spacing', 'word-spacing', 'text-transform', 'text-shadow']) {
    const value = style.getPropertyValue(property)
    if (value && value !== base.getPropertyValue(property)) throw new Error(`Unsupported CSS ::marker ${property}: ${value}`)
  }
  const family = style.fontFamily || base.fontFamily, fontFace = fonts.get(family)
  if (!fontFace) throw new Error(`Unresolved ::marker font family: ${family}`)
  const fontSize = pixels(style.fontSize || base.fontSize) * scale
  if (!(fontSize > 0)) throw new Error(`Unsupported CSS ::marker font-size: ${style.fontSize}`)
  return { marker: { character, fontFace, fontSize, ...cssColor(style.color || base.color) }, text: character ? markerText(content) : undefined }
}
