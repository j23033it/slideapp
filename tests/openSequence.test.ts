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
  it('新しいファイルを開く前には監視を止めない', () => {
    const body = callbackBody('openPathNow')
    expect(body.indexOf('const file = await platform.openFile(path)')).toBeLessThan(
      body.indexOf('await platform.stopWatching().catch(() => {})'),
    )
  })

  it('読み込み後に未保存の変更を確認し直す', () => {
    expect(callbackBody('openPathNow')).toContain('needsOpenReconfirm')
  })

  it('読み込み応答後にIME確定を待ってから内容を照合する', () => {
    const body = callbackBody('openPathNow')
    expect(body.indexOf('await platform.openFile(path)')).toBeLessThan(body.indexOf('await waitForComposition()'))
    expect(body.indexOf('await waitForComposition()')).toBeLessThan(body.indexOf('needsOpenReconfirm'))
  })

  it('フロント側が読み込み内容を拒否したとき監視先を復旧する', () => {
    const body = callbackBody('openPathNow')
    expect(body).toContain('await restoreSessionWatch(restoreSession)')
    expect(body).toContain('await platform.stopWatching().catch(() => {})')
  })

  it('監視先の復旧結果をIME確定後に外部変更として反映する', () => {
    const restoreBody = callbackBody('restoreSessionWatch')
    const read = restoreBody.indexOf('const restored = await platform.openFile(session.path)')
    const wait = restoreBody.indexOf('await waitForComposition()', read)
    const apply = restoreBody.indexOf(
      "externalRef.current({ type: 'changed', path: session.path, ...restored })",
      wait,
    )
    const openBody = callbackBody('openPathNow')

    expect(read).toBeGreaterThanOrEqual(0)
    expect(wait).toBeGreaterThan(read)
    expect(apply).toBeGreaterThan(wait)
    expect(openBody).toContain('await restoreSessionWatch(existing)')
    expect(openBody).toContain('await restoreSessionWatch(restoreSession)')
  })
})

describe('continuePendingNow', () => {
  it('保存応答後に操作IDと取消状態を確認し、閉じる直前にも未保存状態を確認する', () => {
    const body = callbackBody('continuePendingNow')
    const save = body.indexOf('const saved = await runSave()')
    const responseCheck = body.indexOf('if (!isCurrentOperation()) return', save)
    const closeCheck = body.indexOf('hasUnsavedChanges(editorSessionSaveState(session))')
    const closeCall = body.indexOf('platform.forceClose()')

    expect(body).toContain('const operationId = ++pendingOperationRef.current')
    expect(responseCheck).toBeGreaterThan(save)
    expect(closeCheck).toBeGreaterThan(responseCheck)
    expect(closeCheck).toBeLessThan(closeCall)
    expect(body.indexOf("if (mode === 'save' && action.kind === 'close')")).toBeLessThan(closeCheck)
    expect(body).toContain('replacePending(action)')
    expect(appSource).toContain('onClick={() => replacePending(null)}')
    expect(appSource).toContain('pendingOperationRef.current += 1')
  })
})

describe('performSave', () => {
  it('保存時に競合が返ったら競合状態を記録してからディスクを読み直す', () => {
    const body = callbackBody('performSave')
    const markConflict = body.indexOf('session.conflict = true')
    const readDisk = body.indexOf('await platform.openFile(session.path)')
    expect(markConflict).toBeGreaterThan(body.indexOf("if (result.kind === 'conflict')"))
    expect(markConflict).toBeLessThan(readDisk)
  })
})

describe('chooseConflictNow', () => {
  it('IME確定後に内容を照合してからディスクをモデルへ反映する', () => {
    const body = callbackBody('chooseConflictNow')
    const read = body.indexOf('const disk = await platform.openFile(session.path)')
    const wait = body.indexOf('await waitForComposition()', read)
    const check = body.indexOf('planMineCopyReload(snapshot', wait)
    const reload = body.indexOf('applyReload(disk.text, disk.hash, disk.hasBom)')

    expect(wait).toBeGreaterThan(read)
    expect(check).toBeGreaterThan(wait)
    expect(check).toBeLessThan(reload)
    expect(body.indexOf('await writeMineCopy(session, snapshot)')).toBeLessThan(
      body.indexOf('await waitForComposition()', wait + 1),
    )
  })
})
