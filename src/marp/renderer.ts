import { Marp } from '@marp-team/marp-core'

import { createEngine, type Analysis, type EditingEngine } from '../editing'
import { installImagePathRule, rewriteCssUrls, type MarkdownItLike } from './urls'
import { registerThemes, type ThemeCss, type ThemeRegistrationResult } from './themes'

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

/** 解析結果と、それを表示するためのデッキ */
export interface RenderedAnalysis {
  analysis: Analysis
  deck: RenderedDeck
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
 * Marp Coreの描画。インスタンスを1つだけ作り、画像パス規則を登録してから
 * 編集エンジンを作る（READMEの手順）。表示HTMLは `engine.analyze()` の結果を使い、
 * `marp.render()` を二重に呼ばない。
 */
export class MarpRenderer {
  private readonly marp: Marp
  private readonly engine: EditingEngine
  private baseDir: string | null = null
  private lastKey: string | null = null
  private last: RenderedAnalysis | null = null

  constructor(private readonly toAssetUrl: (absolutePath: string) => string) {
    this.marp = new Marp({ script: false, math: 'mathjax' })
    installImagePathRule(this.marp.markdown as MarkdownItLike, () => this.baseDir, toAssetUrl)
    this.engine = createEngine(this.marp)
  }

  /** 編集エンジン（`applyRunEdit` はこのインスタンスの最新解析に対して動く） */
  get editing(): EditingEngine {
    return this.engine
  }

  /** 現在のファイル用のカスタムテーマを登録し、描画キャッシュを無効にする */
  setThemes(themes: readonly ThemeCss[]): ThemeRegistrationResult {
    const result = registerThemes(this.marp, themes, this.toAssetUrl)
    this.lastKey = null
    this.last = null
    return result
  }

  /** 解析と描画を同時に行う。同じ入力・基準フォルダなら前回の結果を返す */
  analyze(text: string, baseDir: string | null): RenderedAnalysis {
    const key = `${baseDir ?? ''}\u0000${text}`
    if (key === this.lastKey && this.last) return this.last

    this.baseDir = baseDir
    const analysis = this.engine.analyze(text)
    const result = { analysis, deck: this.buildDeck(analysis, baseDir) }
    this.lastKey = key
    this.last = result
    return result
  }

  /** 編集中に採用された解析結果を、次回のキャッシュとして受け入れる */
  update(analysis: Analysis, baseDir: string | null): RenderedDeck {
    const deck = this.buildDeck(analysis, baseDir)
    this.lastKey = `${baseDir ?? ''}\u0000${analysis.text}`
    this.last = { analysis, deck }
    return deck
  }

  /** 表示用のデッキ。既存の呼び出し元との互換用 */
  render(text: string, baseDir: string | null): RenderedDeck {
    return this.analyze(text, baseDir).deck
  }

  private buildDeck(analysis: Analysis, baseDir: string | null): RenderedDeck {
    const { slides, width, height } = splitRenderedSlides(analysis.html)
    return {
      slides,
      css: rewriteCssUrls(analysis.css, baseDir, this.toAssetUrl),
      width,
      height,
    }
  }
}
