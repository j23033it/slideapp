import { resolveAssetPath, rewriteCssUrls } from './urls'

/** Rust側の `read_theme_config` が返すテーマCSS1件 */
export interface ThemeCss {
  /** CSSファイルの絶対パス */
  path: string
  css: string
}

/** `registerThemes` で実際に登録したテーマ */
export interface RegisteredTheme {
  path: string
  /** CSSの `/* @theme name *\/` で宣言された名前 */
  name: string
}

export interface ThemeRegistrationResult {
  themes: RegisteredTheme[]
  warnings: string[]
}

/** MarpitのThemeSetのうち、このモジュールが使う部分 */
export interface ThemeSetLike {
  add(css: string): unknown
  delete(name: string): boolean
}

/** Marpインスタンスのうち、このモジュールが使う部分 */
export interface MarpLike {
  themeSet: ThemeSetLike
}

/**
 * `marp` ごとに前回登録したカスタムテーマ名。
 * テーマ登録はMarpインスタンスを再利用するため、ファイルを切り替えたときに
 * 古いテーマが残らないよう、次の登録時に外す。
 */
const registeredThemes = new WeakMap<ThemeSetLike, string[]>()

/** CSSの `/* @theme name *\/` からテーマ名を取り出す。なければ null */
export function parseThemeName(css: string): string | null {
  const comment = /\/\*([\s\S]*?)\*\//g
  let match: RegExpExecArray | null
  while ((match = comment.exec(css)) !== null) {
    const name = /(?:^|\s)@theme\s+([^\s*]+)/.exec(match[1] ?? '')
    if (name?.[1]) return name[1]
  }
  return null
}

/** 資産URLへの変換関数（Tauriの `convertFileSrc`） */
export type ToAssetUrl = (absolutePath: string) => string

/**
 * 各テーマCSSの相対 `url(...)` と `@import "相対"` を、
 * そのCSSファイルの場所基準で資産URLへ書き換えてからThemeSetに登録する。
 *
 * - `/* @theme name *\/` がないCSSは登録せず警告する
 * - 同じ名前のテーマは後勝ち
 * - 前回このMarpインスタンスに登録したカスタムテーマは先に外す
 */
export function registerThemes(
  marp: MarpLike,
  themes: readonly ThemeCss[],
  toAssetUrl: ToAssetUrl,
): ThemeRegistrationResult {
  const themeSet = marp.themeSet
  const result: ThemeRegistrationResult = { themes: [], warnings: [] }

  for (const name of registeredThemes.get(themeSet) ?? []) {
    themeSet.delete(name)
  }
  registeredThemes.set(themeSet, [])

  for (const theme of themes) {
    const name = parseThemeName(theme.css)
    if (!name) {
      warn(
        result.warnings,
        `テーマ名（/* @theme name */）がないCSSは登録しません: ${theme.path}`,
      )
      continue
    }

    const css = rewriteThemeCss(theme.css, directoryOf(theme.path), toAssetUrl)
    try {
      themeSet.add(css)
    } catch (error) {
      warn(
        result.warnings,
        `テーマCSSを登録できません (${theme.path}): ${errorMessage(error)}`,
      )
      continue
    }

    // 同名は後勝ち。登録済みの同じ名前を消してから末尾に積む
    const previous = result.themes.findIndex((registered) => registered.name === name)
    if (previous >= 0) result.themes.splice(previous, 1)
    result.themes.push({ path: theme.path, name })
  }

  registeredThemes.set(
    themeSet,
    result.themes.map((theme) => theme.name),
  )
  return result
}

/** 相対参照の `@import` と `url(...)` をCSSファイルの場所基準で資産URLにする */
export function rewriteThemeCss(css: string, baseDir: string | null, toAssetUrl: ToAssetUrl): string {
  return mapCssCode(css, (code) => {
    const imported = code.replace(
      /(@import\s+)(["'])([^"']*)\2/gi,
      (whole, head: string, _quote: string, reference: string) => {
        if (!looksLikePath(reference)) return whole
        const absolute = resolveAssetPath(baseDir, reference)
        return absolute ? `${head}url("${toAssetUrl(absolute)}")` : whole
      },
    )
    return rewriteCssUrls(imported, baseDir, toAssetUrl)
  })
}

/** コメント内の `url(...)` や `@import` は書き換えない */
function mapCssCode(css: string, transform: (code: string) => string): string {
  let output = ''
  let codeStart = 0
  let index = 0

  while (index < css.length) {
    const character = css[index]

    if (character === '"' || character === "'") {
      index = skipString(css, index)
      continue
    }

    if (character === '/' && css[index + 1] === '*') {
      output += transform(css.slice(codeStart, index))
      const end = css.indexOf('*/', index + 2)
      if (end < 0) {
        output += css.slice(index)
        return output
      }
      output += css.slice(index, end + 2)
      index = end + 2
      codeStart = index
      continue
    }

    index += 1
  }

  return output + transform(css.slice(codeStart))
}

function skipString(css: string, start: number): number {
  const quote = css[start]
  let index = start + 1
  while (index < css.length) {
    const character = css[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === quote) return index + 1
    index += 1
  }
  return index
}

/** `@import "gaia"` のようなテーマ名の指定はパスとして扱わない */
function looksLikePath(reference: string): boolean {
  const value = reference.trim()
  if (value === '') return false
  return (
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    /^\.{1,2}[\\/]/.test(value) ||
    /[\\/]/.test(value) ||
    /\.css$/i.test(value)
  )
}

/** CSSファイルの親フォルダ。`C:\a\b.css` → `C:\a` */
export function directoryOf(path: string): string | null {
  const native = path.replace(/\//g, '\\')
  const index = native.lastIndexOf('\\')
  if (index < 0) return null
  if (index === 2 && native[1] === ':') return native.slice(0, 3)
  return native.slice(0, index)
}

function warn(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
