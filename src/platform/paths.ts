/**
 * Windowsのパス操作（表示と資産URLの解決に必要な最小限）。
 * Nodeの `path` はブラウザで使えないため、ここで実装する。
 */

/** 末尾の区切りと、ファイル名を取り除いたフォルダ。`C:\a\b.md` → `C:\a` */
export function dirname(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  if (index < 0) return ''
  if (index === 2 && /^[a-zA-Z]:/.test(normalized)) return normalized.slice(0, 3)
  return normalized.slice(0, index)
}

/** `C:\a\b.md` → `b.md` */
export function basename(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return index < 0 ? normalized : normalized.slice(index + 1)
}
