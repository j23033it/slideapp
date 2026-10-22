/**
 * 描画時だけのパス変換。
 * Markdownソースは変更せず、markdown-itのトークンとCSSの `url(...)` を
 * Tauriの資産URL（`convertFileSrc`）へ置き換える。
 */

const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** 変換対象外（外部URL・data URI・アンカーなど）か */
export function isExternalReference(src: string): boolean {
  const value = src.trim()
  if (value === '' || value.startsWith('#') || value.startsWith('//')) return true
  // Windowsの絶対パス（ドライブレター）はスキームではない
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false
  return URI_SCHEME.test(value)
}

function splitPath(path: string): string[] {
  return path.replace(/\\/g, '/').split('/')
}

/** `.` と `..` を畳んだパス。ドライブレター・UNCはそのまま保つ */
function normalizePath(path: string): string {
  const native = path.replace(/\//g, '\\')
  const unc = native.startsWith('\\\\')
  const parts = splitPath(native)
  const drive = /^[a-zA-Z]:$/.test(parts[0] ?? '') ? (parts.shift() as string) : null
  const stack: string[] = []

  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }

  const body = stack.join('\\')
  if (unc) return `\\\\${body}`
  if (drive) return body ? `${drive}\\${body}` : `${drive}\\`
  return body
}

/**
 * 相対参照を、開いているMarkdownのフォルダ基準の絶対パスにする。
 * 変換しない場合は null を返す。
 */
export function resolveAssetPath(baseDir: string | null, src: string): string | null {
  const value = src.trim()
  if (isExternalReference(value)) return null

  // すでに絶対パス（ドライブレター / UNC）
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return normalizePath(value)
  }

  // ルート相対（`/images/a.png`）はドライブのルートから解決する
  if (value.startsWith('/') || value.startsWith('\\')) {
    if (!baseDir) return normalizePath(value)
    const drive = /^([a-zA-Z]:)/.exec(baseDir)?.[1]
    return normalizePath(drive ? `${drive}${value}` : value)
  }

  if (!baseDir) return null
  return normalizePath(`${baseDir}\\${value}`)
}

/** CSSの `url(...)` を資産URLへ置き換える（テーマCSS・`<style>` ディレクティブ用） */
export function rewriteCssUrls(
  css: string,
  baseDir: string | null,
  toAssetUrl: (absolutePath: string) => string,
): string {
  return css.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi,
    (whole, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      const raw = double ?? single ?? bare
      if (raw === undefined) return whole
      const absolute = resolveAssetPath(baseDir, raw)
      if (!absolute) return whole
      return `url("${toAssetUrl(absolute)}")`
    },
  )
}

/** markdown-itの画像トークン（必要最小限の形） */
interface ImageTokenLike {
  type: string
  children?: ImageTokenLike[] | null
  meta?: {
    marpitImage?: { url?: string; [key: string]: unknown }
    [key: string]: unknown
  }
  attrGet(name: string): string | null
  attrSet(name: string, value: string): void
}

/** markdown-itのインスタンス（必要な部分だけ） */
export interface MarkdownItLike {
  core: {
    ruler: {
      after(
        afterName: string,
        ruleName: string,
        rule: (state: { tokens: ImageTokenLike[] }) => void,
      ): void
    }
  }
}

/**
 * `inline` の直後に、`image` トークンの `src` を資産URLへ置き換えるコア規則を追加する。
 * Marpの背景画像（`![bg]`）はトークンの `meta.marpitImage.url` から
 * `background-image` が組み立てられるため、そちらも同じように置き換える。
 */
export function installImagePathRule(
  md: MarkdownItLike,
  getBaseDir: () => string | null,
  toAssetUrl: (absolutePath: string) => string,
): void {
  const rewrite = (src: string): string | null => {
    const absolute = resolveAssetPath(getBaseDir(), src)
    return absolute ? toAssetUrl(absolute) : null
  }

  md.core.ruler.after('inline', 'slideapp_rewrite_image_paths', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue

      for (const child of token.children) {
        if (child.type !== 'image') continue

        const src = child.attrGet('src')
        if (src) {
          const assetUrl = rewrite(src)
          if (assetUrl) child.attrSet('src', assetUrl)
        }

        const marpitImage = child.meta?.marpitImage
        if (marpitImage && typeof marpitImage.url === 'string') {
          const assetUrl = rewrite(marpitImage.url)
          if (assetUrl) marpitImage.url = assetUrl
        }
      }
    }
  })
}
