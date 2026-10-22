import { Marp } from '@marp-team/marp-core'

import { installImagePathRule, rewriteCssUrls, type MarkdownItLike } from './urls'

/** 1デッキ分の描画結果 */
export interface RenderedDeck {
  /** スライド1枚ずつのHTML（`<div class="marpit">` + `<svg data-marpit-svg>`） */
  slides: string[]
  /** Marp Coreが返したCSS（テーマ・`<style>` ディレクティブを含む） */
  css: string
  /** スライドの基準サイズ（px） */
  width: number
  height: number
}

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 720

const SVG_TAG = /<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>|<\/svg\s*>/gi

function parseViewBox(tag: string): { width: number; height: number } | null {
  const match = /viewBox="([^"]+)"/i.exec(tag)
  if (!match?.[1]) return null
  const values = match[1].trim().split(/[\s,]+/).map(Number)
  if (values.length < 4) return null
  const width = values[2]
  const height = values[3]
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return null
  return { width, height }
}

/**
 * Marp Coreの出力HTMLを、スライド単位のHTMLへ分割する。
 * 入れ子の `<svg>`（数式など）があっても壊れないよう、タグの深さで判定する。
 */
export function splitRenderedSlides(html: string): {
  slides: string[]
  width: number
  height: number
} {
  const slides: string[] = []
  let width = DEFAULT_WIDTH
  let height = DEFAULT_HEIGHT
  let depth = 0
  let start = -1
  let sizeFound = false

  SVG_TAG.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SVG_TAG.exec(html)) !== null) {
    const tag = match[0]
    const isClosing = tag.startsWith('</')

    if (isClosing) {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) {
          const svg = html.slice(start, SVG_TAG.lastIndex)
          slides.push(`<div class="marpit">${svg}</div>`)
          start = -1
        }
      }
      continue
    }

    const isSlideRoot = depth === 0 && /data-marpit-svg/i.test(tag)
    if (isSlideRoot) {
      start = match.index
      if (!sizeFound) {
        const size = parseViewBox(tag)
        if (size) {
          width = size.width
          height = size.height
          sizeFound = true
        }
      }
    }

    if (!tag.endsWith('/>')) depth += 1
  }

  return { slides, width, height }
}

/**
 * Marp Coreの描画。インスタンスを再利用し、画像パスだけを描画時に資産URLへ変換する。
 */
export class MarpRenderer {
  private readonly marp: Marp
  private baseDir: string | null = null
  private lastKey: string | null = null
  private lastDeck: RenderedDeck | null = null

  constructor(private readonly toAssetUrl: (absolutePath: string) => string) {
    this.marp = new Marp({ script: false, math: 'mathjax' })
    installImagePathRule(this.marp.markdown as MarkdownItLike, () => this.baseDir, toAssetUrl)
  }

  /** 同じ入力の再描画は前回の結果を返す */
  render(text: string, baseDir: string | null): RenderedDeck {
    const key = `${baseDir ?? ''}\u0000${text}`
    if (key === this.lastKey && this.lastDeck) return this.lastDeck

    this.baseDir = baseDir
    const { html, css } = this.marp.render(text)
    const { slides, width, height } = splitRenderedSlides(html)
    const deck: RenderedDeck = {
      slides,
      css: rewriteCssUrls(css, baseDir, this.toAssetUrl),
      width,
      height,
    }

    this.lastKey = key
    this.lastDeck = deck
    return deck
  }
}
