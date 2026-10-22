import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `openPathNow` は Preact の状態に強く結びついているため、ここでは呼び出し順の
 * 不変条件だけをソースで固定する。Rust の `open_file` は成功時に監視を切り替えるので、
 * 先に `stopWatching` すると、開くのに失敗したとき元のファイルの監視が止まったままになる。
 */
const appSource = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function callbackBody(name: string): string {
  const start = appSource.indexOf(`const ${name} = useCallback(`)
  if (start < 0) throw new Error(`${name} not found`)
  const end = appSource.indexOf('\n  )\n', start)
  if (end < 0) throw new Error(`${name} end not found`)
  return appSource.slice(start, end)
}

describe('openPathNow', () => {
  it('新しいファイルを開く前に監視を止めない', () => {
    expect(callbackBody('openPathNow')).not.toContain('platform.stopWatching(')
  })

  it('読み込み後に未保存の変更を確認し直す', () => {
    expect(callbackBody('openPathNow')).toContain('needsOpenReconfirm')
  })
})
