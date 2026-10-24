import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Preserve ordering guards around per-tab reads, save completion and conflict choices.
 * Runtime tab behavior is covered in appAsyncSync.test.tsx.
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
  it('読み込み成功まで監視を止めず、失敗した対象だけを停止する', () => {
    const body = callbackBody('openPathNow')
    expect(body.indexOf('await platform.openFile(path)')).toBeLessThan(
      body.indexOf('await platform.stopWatching(path).catch(() => {})'),
    )
    expect(body).not.toContain('platform.stopWatching()')
  })

  it('読み込み応答後の新しい通知を照合してからセッションを公開する', () => {
    const body = callbackBody('openPathNow')
    const read = body.indexOf('await platform.openFile(path)')
    const wait = body.indexOf('await waitForComposition()', read)
    const compare = body.indexOf('canApplyDiskResult(startedObservation, opening.observation)')
    expect(wait).toBeGreaterThan(read)
    expect(compare).toBeGreaterThan(wait)
    expect(body.indexOf('sessionRef.current = nextSession')).toBeGreaterThan(compare)
  })
})

describe('continuePendingNow', () => {
  it('保存応答後の取消と追加編集を確認してから終了を承認する', () => {
    const body = callbackBody('continuePendingNow')
    const save = body.indexOf('const saved = await runSave()')
    const responseCheck = body.indexOf('if (!isCurrentOperation()) return', save)
    const dirtyCheck = body.indexOf('hasUnsavedChanges(editorSessionSaveState(session))', responseCheck)
    const approve = body.indexOf('replacePending(null, { updateResolution: true })')
    expect(responseCheck).toBeGreaterThan(save)
    expect(dirtyCheck).toBeGreaterThan(responseCheck)
    expect(approve).toBeGreaterThan(dirtyCheck)
    expect(body).toContain('replacePending(action)')
    expect(appSource).toContain('onClick={cancelPending}')
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
    const themeConfig = body.indexOf('await readThemeConfig(session.path)')
    const reload = body.indexOf('applyReload(session, disk.text, disk.hash, disk.hasBom, themeConfig)')
    const write = body.indexOf('await writeMineCopy(session, snapshot)')
    const waitAfterWrite = body.indexOf('await waitForComposition()', write)

    expect(wait).toBeGreaterThan(read)
    expect(themeConfig).toBeGreaterThan(wait)
    expect(check).toBeGreaterThan(wait)
    expect(reload).toBeGreaterThan(themeConfig)
    expect(check).toBeLessThan(reload)
    expect(write).toBeGreaterThan(themeConfig)
    expect(waitAfterWrite).toBeGreaterThan(write)
  })
})
