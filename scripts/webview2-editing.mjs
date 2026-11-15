// Real WebView2 input regression runner. See docs/webview2-editing.md.
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import JSZip from 'jszip'

const port = Number(process.env.CDP_PORT ?? 9222)
const output = resolve(process.env.TRACE_DIR ?? await mkdtemp(join(tmpdir(), 'slideapp-webview2-')))
await mkdir(output, { recursive: true })
const fixtureDirectory = await mkdtemp(join(output, 'fixture-'))
const fixture = join(fixtureDirectory, 'sample.md')
const sample = process.env.SAMPLE_MD
  ? await readFile(process.env.SAMPLE_MD)
  : Buffer.from('---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# SlideApp 動作確認\n\n文字をクリックして直接編集できるか試すためのサンプル。・・\n\n| 表見出し | 列見出し |\n|---|---|\n| 表の前<br>表の後 | 表セル<br> |\n\n---\n\n## 日本語入力のテスト\n\n- この行をクリックして、日本語を入力・変換してみる\n- **太字の部分**と*斜体の部分*も編集してみる\n\n![w:80](probe.png)\n')
await writeFile(fixture, sample)
await writeFile(join(fixtureDirectory, 'probe.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8X8AAAAASUVORK5CYII=', 'base64'))
let child, childClosed, ws, launchLog, launchError, testIdentifier
let profilePaths = []
const execFileAsync = promisify(execFile)
async function clipboardText() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write((Get-Clipboard -Raw))'], {windowsHide:true,encoding:'utf8'})
  return stdout.replace(/^\uFEFF/,'')
}
const results = []
const pending = new Map()
let sequence = 0
async function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
  return response.result.value
}
async function waitFor(expression, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return
    await delay(50)
  }
  throw new Error(`Timed out: ${expression}`)
}
async function key(key, modifiers = 0) {
  const code = { Tab: 9, Enter: 13, Backspace: 8, Delete: 46, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F5: 116, c: 67, m: 77, y: 89, z: 90, s: 83, b: 66, w: 87, '1': 49, '2': 50 }[key]
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers })
  await delay(180)
}
async function mouse(type, point, extras = {}) {
  await send('Input.dispatchMouseEvent', { type, ...point, ...extras })
}
async function point(text, offset) {
  return evaluate(`(() => {
    const root = document.querySelector('.stage-host').shadowRoot;
    const run = [...root.querySelectorAll('[data-sm-run]')].find(e => e.textContent === ${JSON.stringify(text)});
    if (!run) throw new Error('Missing run: ' + ${JSON.stringify(text)});
    const walker = document.createTreeWalker(run, NodeFilter.SHOW_TEXT);
    let left = ${offset}, node = walker.nextNode();
    while (node && left > node.length) { left -= node.length; node = walker.nextNode(); }
    const r = document.createRange(); r.setStart(node ?? run, left); r.collapse(true);
    const rect = r.getBoundingClientRect();
    return { x: rect.x + (${offset} === ${JSON.stringify(text)}.length ? -1 : 0.5), y: rect.y + rect.height / 2 };
  })()`)
}
async function click(text, offset = text.length) {
  const p = await point(text, offset)
  await mouse('mouseMoved', p)
  await mouse('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 })
  await mouse('mouseReleased', p, { button: 'left', buttons: 0, clickCount: 1 })
  await delay(180)
}
async function drag(text, start, end) {
  const a = await point(text,start), b = await point(text,end)
  await mouse('mouseMoved',a); await mouse('mousePressed',a,{button:'left',buttons:1,clickCount:1})
  for (let i=1;i<=12;i++) { await mouse('mouseMoved',{x:a.x+(b.x-a.x)*i/12,y:a.y+(b.y-a.y)*i/12},{button:'left',buttons:1}); await delay(20) }
  await mouse('mouseReleased',b,{button:'left',buttons:0,clickCount:1}); await delay(250)
}
async function setup() {
  const navigation = String(sequence)
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {source:`
    window.editingProbeNavigation = ${JSON.stringify(navigation)};
    const wrapInternals = internals => {
      if (!internals) return internals;
      let invoke = internals.invoke;
      Object.defineProperty(internals, 'invoke', {
        configurable: true,
        get: () => invoke,
        set: original => {
          invoke = function(command, ...args) {
            if (command === 'settings_get') return Promise.resolve({openTabs: [], activeTab: null});
            if (command === 'settings_set') return Promise.resolve();
            if (command === 'recent_files_get' || command === 'recent_files_add') return Promise.resolve([]);
            return original.call(this, command, ...args);
          };
        },
      });
      if (invoke) internals.invoke = invoke;
      return internals;
    };
    let internals = wrapInternals(window.__TAURI_INTERNALS__);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      get: () => internals,
      set: value => { internals = wrapInternals(value) },
    });
  `})
  try {
    await send('Page.reload')
    await waitFor(`window.editingProbeNavigation === ${JSON.stringify(navigation)} && !!document.querySelector('.empty-open-button')`)
  } finally { await send('Page.removeScriptToEvaluateOnNewDocument',{identifier}) }
  await evaluate(String.raw`(async () => {
    const { platform } = await import('/src/platform/index.ts');
    // Follow Vite's timestamped import after HMR so the patch reaches the class App uses.
    const stageModule = await (await fetch('/src/app/SlideStage.tsx')).text();
    const stageUrl = stageModule.match(/from\s+["']([^"']*stageEditor\.ts[^"']*)["']/)?.[1] ?? '/src/app/stageEditor.ts';
    const { StageEditor } = await import(stageUrl);
    const { DocumentModel } = await import('/src/document/index.ts');
    window.trace = [];
    const node = n => {
      if (!n) return null;
      const element = n.nodeType === 1 ? n : n.parentElement;
      return {name:n.nodeName, text:n.nodeType === 3 ? n.textContent : undefined, run:element?.closest('[data-sm-run]')?.dataset.smRun, block:element?.closest('[data-sm-block]')?.dataset.smBlock, className:element?.getAttribute('class'), connected:n.isConnected};
    };
    window.state = () => {
      const s = getSelection(), r = s?.rangeCount ? s.getRangeAt(0) : null, e = window.editor;
      const root = document.querySelector('.stage-host')?.shadowRoot, scoped = root?.getSelection?.();
      return {
        anchor:node(s?.anchorNode), anchorOffset:s?.anchorOffset,
        focus:node(s?.focusNode), focusOffset:s?.focusOffset,
        collapsed:s?.isCollapsed, selected:s?.toString(),
        range:r && {start:node(r.startContainer),startOffset:r.startOffset,end:node(r.endContainer),endOffset:r.endOffset},
        scoped:scoped && {anchor:node(scoped.anchorNode),anchorOffset:scoped.anchorOffset,focus:node(scoped.focusNode),focusOffset:scoped.focusOffset,collapsed:scoped.isCollapsed},
        editing:e?.editing, adapter:!!e?.adapter, draft:e?.analysis.draft,
        text:e?.analysis.text, latestText:e?.options.latest().analysis.text,
        adapterText:e?.adapter?.getAnalysis().text,
        pendingComposition:e?.hasPendingComposition(),
        modelText:window.model?.text, modelDraft:!!window.model?.draft,
        active:node(root?.activeElement),
      };
    };
    window.record = (type, detail = {}) => trace.push({time:performance.now(), type, ...detail, state:state()});
    for (const name of ['render','focusRun','endEditingSilently','handleFinish','insertNewline','cancelAbandonedDraft','cancelDraftAtLineStart']) {
      const original = StageEditor.prototype[name];
      StageEditor.prototype[name] = function(...args) {
        window.editor = this;
        if (!this.tracedCallbacks) {
          this.tracedCallbacks = true;
          for (const callback of ['onBegin','onEnd','onNotice','onCommit','onCrossRun']) {
            const originalCallback = this.options[callback];
            this.options[callback] = (...args) => {record('callback.'+callback,{detail:typeof args[0]==='string'?args[0]:undefined,edit:args[0]?.edit}); return originalCallback(...args)};
          }
        }
        record(name + ':before');
        try { return original.apply(this,args) } finally { record(name + ':after') }
      };
    }
    const edit = DocumentModel.prototype.edit;
    DocumentModel.prototype.edit = function(...args) { window.model = this; record('model.edit:before', {edit:args[0]}); try {return edit.apply(this,args)} catch(e) {record('model.edit:error',{message:e.message}); throw e} finally {record('model.edit:after')} };
    const canUndo = Object.getOwnPropertyDescriptor(DocumentModel.prototype,'canUndo');
    Object.defineProperty(DocumentModel.prototype,'canUndo',{...canUndo,get() {window.model=this; return canUndo.get.call(this)}});
    for (const type of ['keydown','beforeinput','input','selectionchange','focus','blur','click','pointerdown','pointerup','compositionstart','compositionupdate','compositionend','copy']) {
      document.addEventListener(type, e => {
        record(type + ':capture', {key:e.key,inputType:e.inputType,data:e.data,isComposing:e.isComposing,target:node(e.composedPath()[0])});
        setTimeout(() => record(type + ':settled', {key:e.key,inputType:e.inputType,prevented:e.defaultPrevented}), 0);
      },true);
    }
    window.addEventListener('error', e => record('error',{message:e.message}));
    platform.pickMarkdownFile = async () => ${JSON.stringify(fixture)};
    // Avoid polluting the user's recent-file list; actual Rust open/read/watch remains in use.
    platform.recentFilesAdd = async () => [];
    const openButton = document.querySelector('.empty-open-button');
    if (openButton) openButton.click();
    else {
      // Settings restoration can replace the empty view between the initial
      // wait and these dynamic imports. Reuse the restored fixture and trigger
      // a stage render so the instrumentation observes its existing editor.
      for (let i = 0; i < 100 && !document.querySelector('.slide-list-host')?.shadowRoot?.querySelectorAll('.slot').length; i++)
        await new Promise(resolve => setTimeout(resolve, 50));
      const slots = document.querySelector('.slide-list-host')?.shadowRoot?.querySelectorAll('.slot');
      if (!slots || slots.length < 2) throw new Error('Restored fixture is not ready');
      slots[1].click();
      await new Promise(resolve => setTimeout(resolve, 100));
      slots[0].click();
    }
  })()`)
  await waitFor(`!!window.editor?.adapter && !!document.querySelector('.stage-host')?.shadowRoot?.querySelector('[data-sm-run]')`)
  await delay(250)
}
async function scenario(name, run) {
  // The initial empty view can be replaced while asynchronous tab restoration
  // is settling. Retry a fresh navigation if that happened during setup.
  for (let attempt = 0; ; attempt++) {
    try { await setup(); break }
    catch (error) {
      if (attempt >= 2 || !(String(error).includes("Cannot read properties of null (reading 'click')") ||
          String(error).includes('Timed out: window.editingProbeNavigation'))) throw error
    }
  }
  let error
  try { await run() } catch (e) { error = e.message }
  const trace = await evaluate('trace')
  await writeFile(join(output, name + '.json'), JSON.stringify({ name, error, trace }, null, 2))
  results.push({ name, passed: !error, error })
  console.log(`${error ? 'FAIL' : 'PASS'} ${name}${error ? ': ' + error : ''}`)
}
function check(value, message) { if (!value) throw new Error(message) }
const paragraph = '文字をクリックして直接編集できるか試すためのサンプル。・・'
try {
  if (!process.argv.includes('--launch') || process.env.WEBVIEW2_HOST_EXE) {
    throw new Error('Use --launch without WEBVIEW2_HOST_EXE to isolate the test settings')
  }
  if (process.argv.includes('--launch')) {
    for (const url of [`http://localhost:${port}/json/version`,'http://localhost:1420/']) {
      const occupied = await fetch(url).then(()=>true,()=>false)
      if (occupied) throw new Error('Refusing to launch while a required port is occupied: '+url)
    }
    const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
    // A fresh identifier isolates preferences even before CDP can attach.
    const config = join(fixtureDirectory, 'tauri-test.conf.json')
    testIdentifier = 'io.github.j23033it.slideapp.webviewtest' + randomUUID().replaceAll('-', '')
    if (!/^io\.github\.j23033it\.slideapp\.webviewtest[0-9a-f]{32}$/.test(testIdentifier)) throw new Error('Invalid test identifier')
    if (!process.env.APPDATA || !process.env.LOCALAPPDATA) throw new Error('APPDATA and LOCALAPPDATA are required')
    profilePaths = [process.env.APPDATA, process.env.LOCALAPPDATA].map(root => join(root, testIdentifier))
    for (const path of profilePaths) {
      try { await access(path); throw new Error('Test profile already exists: ' + path) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await writeFile(config, JSON.stringify({ identifier: testIdentifier }))
    launchLog = await open(join(output,'launch.log'),'w')
    child = spawn(process.execPath, [resolve('node_modules/@tauri-apps/cli/tauri.js'), 'dev', '--config', config], { windowsHide: true, env, stdio: ['ignore',launchLog.fd,launchLog.fd] })
    child.on('error',error=>{launchError=error})
    childClosed = new Promise(resolve => child.once('close', resolve))
  }
  let target
  for (let i = 0; i < 600; i++) {
    if (launchError) throw launchError
    if (child && child.exitCode !== null) throw new Error('Development launch failed; see '+join(output,'launch.log'))
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && t.url.includes('localhost:1420')); if (target) break } catch {}
    await delay(500)
  }
  if (!target) throw new Error('No SlideApp development WebView2 target. Start npm run tauri dev with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=' + port)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id); clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
  await send('Page.enable'); await send('Runtime.enable')
  await waitFor('!!window.__TAURI_INTERNALS__ && !!document.querySelector(".empty-open-button")')
  await writeFile(join(output,'environment.json'),JSON.stringify({version:await send('Browser.getVersion'),targetUrl:target.url,fixture},null,2))
  const stageRoot = `document.querySelector('.stage-host').shadowRoot`
  const boxPoint = async selector => evaluate(`(() => { const e = ${stageRoot}.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing ' + ${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  const gesture = async (p, dx, dy, cancel = false) => {
    await mouse('mouseMoved', p); await mouse('mousePressed', p, { button:'left', buttons:1, clickCount:1 })
    await mouse('mouseMoved', {x:p.x+dx,y:p.y+dy}, {button:'left',buttons:1}); await delay(100)
    if (cancel) await key('Escape')
    await mouse('mouseReleased', {x:p.x+dx,y:p.y+dy}, {button:'left',buttons:0,clickCount:1}); await delay(250)
  }
  const clickBold = async () => {
    const p = await evaluate(`(() => { const r = document.querySelector('button[aria-label="太字 (Ctrl+B)"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
    await mouse('mouseMoved', p); await mouse('mousePressed', p, {button:'left',buttons:1,clickCount:1})
    await mouse('mouseReleased', p, {button:'left',buttons:0,clickCount:1}); await delay(250)
  }
  await scenario('bold-key-button-undo-reject', async () => {
    const original = await evaluate('state().text')
    await click(paragraph, 2); await drag(paragraph, 0, 5)
    const chosen = await evaluate('state().selected')
    check(chosen === paragraph.slice(0, 5), 'Bold test selection was not preserved')
    await key('b', 2)
    check((await evaluate('state().modelText')).includes('**' + chosen + '**'), 'Ctrl+B did not add bold')
    check(await evaluate('state().selected') === chosen, 'Ctrl+B did not restore the selection')
    await waitFor(`document.querySelector('button[aria-label="太字 (Ctrl+B)"]').getAttribute('aria-pressed') === 'true'`)
    await clickBold()
    check(await evaluate('state().modelText') === original, 'B did not remove bold')
    await waitFor(`document.querySelector('button[aria-label="太字 (Ctrl+B)"]').getAttribute('aria-pressed') === 'false'`)
    await key('z', 2)
    check((await evaluate('state().modelText')).includes('**' + chosen + '**'), 'One Undo did not restore bold')
    await key('z', 2)
    check(await evaluate('state().modelText') === original, 'One Undo did not remove bold addition')
    await click(paragraph, 2); await key('b', 2)
    check(await evaluate(`trace.some(e => e.type === 'callback.onNotice' && e.detail === 'bold-invalid-position')`), 'Collapsed plain selection was not rejected')
    check(await evaluate('state().modelText') === original, 'Rejected bold changed the document')
  })
  await scenario('bold-box', async () => {
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.insertText', {text:'box text'}); await delay(250)
    await click('box text', 3); await key('Home', 8)
    check(await evaluate('state().selected') === 'box', 'Box text selection failed')
    await clickBold()
    check((await evaluate('state().modelText')).includes('**box** text'), 'B did not add bold inside box')
    await key('b', 2)
    check((await evaluate('state().modelText')).includes('box text'), 'Ctrl+B did not remove bold inside box')
    await key('z', 2)
    check((await evaluate('state().modelText')).includes('**box** text'), 'Undo did not restore box bold')
  })
  const selectedBold = async (text, expected) => {
    await click(text, 1); await key('Escape')
    check(await evaluate(`!!${stageRoot}.querySelector('[data-sm-selected]')`), 'Element was not selected')
    const original = await evaluate('state().modelText')
    await clickBold()
    check((await evaluate('state().modelText')).includes(expected), 'B did not bold the element')
    check(await evaluate(`!!${stageRoot}.querySelector('[data-sm-selected]')`), 'Element selection was not restored')
    check(await evaluate(`document.querySelector('button[aria-label="太字 (Ctrl+B)"]').getAttribute('aria-pressed') === 'true'`), 'B was not pressed')
    await key('b', 2)
    check(await evaluate('state().modelText') === original, 'Ctrl+B did not remove element bold')
    check(await evaluate(`!!${stageRoot}.querySelector('[data-sm-selected]')`), 'Element selection was lost after removal')
    await key('z', 2)
    check((await evaluate('state().modelText')).includes(expected), 'One Undo did not restore element bold')
  }
  await scenario('element-bold-paragraph', async () => {
    await selectedBold(paragraph, '**' + paragraph + '**')
  })
  await scenario('element-bold-box', async () => {
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.insertText', {text:'box text'}); await waitFor(`!![...${stageRoot}.querySelectorAll('[data-sm-run]')].find(e => e.textContent === 'box text')`)
    await selectedBold('box text', '**box text**')
  })
  try {
    await writeFile(fixture, Buffer.from(sample.toString().replaceAll('<br>', '')))
    await scenario('element-bold-table', async () => {
      await selectedBold('表見出し', '| **表見出し** | **列見出し** |')
      check((await evaluate('state().modelText')).includes('**表の前表の後**'), 'Table body was not bold')
    })
  } finally { await writeFile(fixture, sample) }
  try {
    const source = '# Elements\n\n```\ncode sample\n```\n\n![w:300](probe.png)\n\n---\n\n# Second'
    await writeFile(fixture, Buffer.from(source))
    await scenario('element-bold-code-image-disabled', async () => {
      const button = `document.querySelector('button[aria-label="太字 (Ctrl+B)"]')`
      await evaluate(`document.querySelector('.slide-list-host').shadowRoot.querySelectorAll('.slot')[0].click()`)
      await waitFor(`!!${stageRoot}.querySelector('marp-pre[data-sm-element]') && !!${stageRoot}.querySelector('[data-sm-element] img')`)
      for (const selector of ['marp-pre code', '[data-sm-element] img']) {
        const p = await boxPoint(selector)
        await mouse('mouseMoved', p); await mouse('mousePressed', p, {button:'left', buttons:1, clickCount:1})
        await mouse('mouseReleased', p, {button:'left', buttons:0, clickCount:1}); await delay(250)
        check(await evaluate(`!!${stageRoot}.querySelector('[data-sm-selected]') && ${button}.disabled`), 'B remained enabled for ' + selector)
        const original = await evaluate('state().modelText')
        await key('b', 2)
        check(await evaluate('state().modelText') === original, 'Ctrl+B changed disabled element')
      }
    })
  } finally { await writeFile(fixture, sample) }
  await scenario('bold-ime-ignored', async () => {
    await click(paragraph, 3)
    await send('Input.imeSetComposition', {text:'てん',selectionStart:2,selectionEnd:2})
    const before = await evaluate('state().modelText')
    await key('b', 2)
    check(await evaluate('state().pendingComposition'), 'Ctrl+B interrupted IME composition')
    check(await evaluate('state().modelText') === before, 'Ctrl+B changed source during IME composition')
    await send('Input.insertText', {text:'点'})
  })
  await scenario('bold-conflict-disabled', async () => {
    await click(paragraph, 3); await send('Input.insertText', {text:'追加'}); await delay(200)
    const before = await evaluate('state().modelText')
    try {
      await writeFile(fixture, Buffer.concat([sample, Buffer.from('\nexternal change\n')]))
      await waitFor(`document.querySelector('button[aria-label="太字 (Ctrl+B)"]').title === 'ファイルが競合しているため操作できません'`)
      check(await evaluate(`document.querySelector('button[aria-label="太字 (Ctrl+B)"]').disabled`), 'Bold button remained enabled during conflict')
      await key('b', 2)
      check(await evaluate('state().modelText') === before, 'Ctrl+B changed source during conflict')
    } finally { await writeFile(fixture, sample) }
  })
  try {
    await writeFile(fixture, Buffer.concat([sample, Buffer.from('\0')]))
    await scenario('bold-readonly-disabled', async () => {
      const button = `document.querySelector('button[aria-label="太字 (Ctrl+B)"]')`
      check(await evaluate(`${button}.disabled && ${button}.title === '読み取り専用のため操作できません'`), 'Bold button remained enabled in a read-only document')
    })
  } finally { await writeFile(fixture, sample) }
  await scenario('box-move-resize-cancel-arrows-undo', async () => {
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.insertText', {text:'操作する箱'}); await delay(200); await key('Escape')
    const original = await evaluate('state().modelText')
    const p = await boxPoint('[data-box][data-sm-selected]')
    await gesture(p, 40, 30, true)
    check(await evaluate('state().modelText') === original, 'Escape committed a box drag')
    await gesture(p, 40, 30)
    const moved = await evaluate('state().modelText')
    check(moved !== original, 'Drag did not move the box')
    await key('ArrowRight'); const arrow = await evaluate('state().modelText')
    check(arrow !== moved, 'Arrow key did not move the box')
    await key('ArrowDown', 8); check(await evaluate('state().modelText') !== arrow, 'Shift arrow did not move the box')
    await key('z', 2); await key('z', 2)
    check(await evaluate('state().modelText') === moved, 'Arrow key undo did not restore position')
    // Undo clears selection; select the box again by its border.
    const edge = await evaluate(`(() => {const r=${stageRoot}.querySelector('[data-box]').getBoundingClientRect(); return {x:r.left+1,y:r.top+r.height/2}})()`)
    await gesture(edge, 0, 0)
    const handle = await boxPoint('[data-sm-box-handle="right"]')
    await gesture(handle, 30, 0)
    check(await evaluate('state().modelText') !== moved, 'Resize did not change width')
    await key('z', 2); check(await evaluate('state().modelText') === moved, 'Resize undo failed')
    await key('z', 2); check(await evaluate('state().modelText') === original, 'Move undo failed')
  })
  await scenario('box-drag-cancel-on-undo', async () => {
    const original = await evaluate('editor.options.latest().analysis.text')
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.insertText', {text:'取消対象'}); await delay(200); await key('Escape')
    const p = await boxPoint('[data-box][data-sm-selected]')
    await mouse('mouseMoved',p); await mouse('mousePressed',p,{button:'left',buttons:1,clickCount:1})
    await mouse('mouseMoved',{x:p.x+35,y:p.y+20},{button:'left',buttons:1})
    await key('z',2)
    await mouse('mouseReleased',{x:p.x+35,y:p.y+20},{button:'left',buttons:0,clickCount:1}); await delay(250)
    check(await evaluate('state().modelText') === original, 'Undo during drag committed a stale gesture')
  })
  await scenario('box-drag-cancel-on-external-change', async () => {
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.insertText', {text:'外部変更'}); await delay(200); await key('Escape')
    const before = await evaluate('state().modelText'), p = await boxPoint('[data-box][data-sm-selected]')
    try {
      await mouse('mouseMoved',p); await mouse('mousePressed',p,{button:'left',buttons:1,clickCount:1})
      await mouse('mouseMoved',{x:p.x+35,y:p.y+20},{button:'left',buttons:1})
      await writeFile(fixture, Buffer.concat([sample, Buffer.from('\nexternal change\n')]))
      await waitFor(`!editor.cancelHandleDrag`)
      await mouse('mouseReleased',{x:p.x+35,y:p.y+20},{button:'left',buttons:0,clickCount:1}); await delay(250)
      check(await evaluate('state().modelText') === before, 'External change committed a stale gesture')
    } finally { await writeFile(fixture, sample) }
  })
  await scenario('box-convert-paragraph-undo', async () => {
    const original = await evaluate('editor.options.latest().analysis.text')
    await click(paragraph, 3); await key('Escape')
    const p = await boxPoint('[data-sm-selected]')
    await gesture(p, 35, 25)
    check((await evaluate('state().modelText')).includes('data-box'), 'Paragraph was not converted')
    await key('z', 2); check(await evaluate('state().modelText') === original, 'Paragraph conversion undo failed')
  })
  await scenario('box-convert-image-undo', async () => {
    await evaluate(`document.querySelector('.slide-list-host').shadowRoot.querySelectorAll('.slot')[1].click()`); await delay(250)
    const original = await evaluate('editor.options.latest().analysis.text')
    const p = await boxPoint('img')
    await mouse('mouseMoved',p); await mouse('mousePressed',p,{button:'left',buttons:1,clickCount:1}); await mouse('mouseReleased',p,{button:'left',buttons:0,clickCount:1}); await delay(200)
    await gesture(p, 35, 25)
    check((await evaluate('state().modelText')).includes('data-box'), 'Image was not converted')
    await key('z', 2); check(await evaluate('state().modelText') === original, 'Image conversion undo failed')
  })
  await scenario('box-empty-cancel', async () => {
    const original = await evaluate('editor.options.latest().analysis.text')
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await key('Escape')
    check(await evaluate('editor.options.latest().analysis.text') === original, 'Empty box was not cancelled')
  })
  await scenario('box-input-select-size-delete-undo', async () => {
    const original = await evaluate('editor.options.latest().analysis.text')
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.insertText', { text: '箱の文字' }); await delay(250)
    check((await evaluate('state().modelText'))?.includes('箱の文字'), 'Box input was not committed')
    await key('Escape')
    check(await evaluate(`!!document.querySelector('.stage-host').shadowRoot.querySelector('[data-box][data-sm-selected]')`), 'Escape did not select the box')
    await evaluate(`(() => { const select = document.querySelector('select[aria-label="文字サイズ"]'); if (select.disabled) throw new Error('Font size is disabled'); select.value = '32'; select.dispatchEvent(new Event('change', {bubbles:true})) })()`)
    await waitFor(`state().modelText.includes('font-size:32pt')`)
    await key('z', 2)
    check(!(await evaluate('state().modelText')).includes('font-size:32pt'), 'One undo did not restore the box font size')
    await click('箱の文字'); await key('Escape'); await key('Delete')
    check(!(await evaluate('state().modelText')).includes('箱の文字'), 'Delete did not remove the box')
    await key('z', 2)
    check((await evaluate('state().modelText')).includes('箱の文字'), 'One undo did not restore the box')
    await key('z', 2)
    check(await evaluate('state().modelText') === original, 'One undo did not restore the original before box insertion')
  })
  await scenario('box-ime-first-input-undo', async () => {
    const original = await evaluate('editor.options.latest().analysis.text')
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.imeSetComposition', {text:'にほん', selectionStart:3, selectionEnd:3})
    check(await evaluate('state().pendingComposition && state().modelDraft'), 'Box IME did not retain its draft')
    await send('Input.insertText', {text:'日本'}); await delay(250)
    check((await evaluate('state().modelText')).includes('日本'), 'Box IME text was not committed')
    await key('z', 2)
    check(await evaluate('state().modelText') === original, 'One undo did not remove box and IME input')
  })
  await scenario('box-gesture-during-ime', async () => {
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.imeSetComposition', {text:'にほん', selectionStart:3, selectionEnd:3})
    check(await evaluate('state().pendingComposition'), 'IME composition did not start')
    const before = await evaluate('state().modelText')
    await evaluate(`(() => { const box = ${stageRoot}.querySelector('[data-box]'); const r = box.getBoundingClientRect(); box.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,button:0,pointerId:77,clientX:r.left+1,clientY:r.top+r.height/2})) })()`)
    check(await evaluate('state().pendingComposition && !editor.cancelHandleDrag && !editor.selectedElement'), 'A box gesture started during IME composition')
    check(await evaluate('state().modelText') === before, 'IME gesture changed the source')
    await send('Input.insertText', {text:'日本'}); await delay(250)
    check((await evaluate('state().modelText')).includes('日本'), 'IME input could not finish after the rejected gesture')
  })
  await scenario('box-empty-after-deletion', async () => {
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.insertText', {text:'X'}); await delay(200)
    await key('Backspace')
    check((await evaluate('state().modelText')).includes('data-box') && !await evaluate('state().draft'), 'Deleting the last character removed the box')
    await send('Input.insertText', {text:'Y'}); await delay(200)
    check((await evaluate('state().modelText')).includes('Y'), 'Empty existing box did not accept input')
  })
  await scenario('box-font-size-during-editing', async () => {
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.insertText', {text:'編集サイズ'}); await delay(200)
    check(await evaluate(`state().editing && !document.querySelector('select[aria-label="文字サイズ"]').disabled`), 'Font size is disabled while editing box text')
    await evaluate(`(() => { const select = document.querySelector('select[aria-label="文字サイズ"]'); select.value = '24'; select.dispatchEvent(new Event('change', {bubbles:true})) })()`)
    await waitFor(`state().modelText.includes('font-size:24pt')`)
  })
  await scenario('box-theme-position-and-export', async () => {
    const measured = await evaluate(`(async () => {
      const { createBoxMarp } = await import('/src/marp/boxHtml.ts');
      const { svgHtmlAllowlist } = await import('/src/export/pptx/svgAllowlist.ts');
      const { measureDeck } = await import('/src/export/pptx/index.ts');
      const { generatePptx } = await import('/src/export/pptx/generate.ts');
      const source = theme => '---\\ntheme: ' + theme + '\\n---\\n\\n<div data-box style="position:absolute; left:320px; top:240px; width:640px; font-size:32pt">\\n\\nHello box\\n\\n</div>';
      const themes = [];
      for (const theme of ['default', 'gaia', 'uncover']) {
        const rendered = createBoxMarp().render(source(theme));
        const host = document.createElement('div'), root = host.attachShadow({mode:'open'});
        root.innerHTML = '<style>' + rendered.css + '</style>' + rendered.html;
        document.body.append(host);
        const section = root.querySelector('section'), box = root.querySelector('[data-box]');
        const s = section.getBoundingClientRect(), b = box.getBoundingClientRect();
        themes.push({ theme, position:getComputedStyle(section).position, parent:box.offsetParent === section,
          left:(b.left-s.left)*1280/s.width, top:(b.top-s.top)*1280/s.width, width:b.width*1280/s.width });
        host.remove();
      }
      const exported = await measureDeck({markdown:source('default'), marp:createBoxMarp({svgHtmlAllowlist}), baseDir:''}, {fontEmbedCSS:' '});
      const bytes = await generatePptx(exported.slides);
      let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return {themes, parts:exported.slides[0].parts, report:exported.report, pptx:btoa(binary)};
    })()`)
    for (const theme of measured.themes) {
      check(theme.position === 'relative' && theme.parent && Math.abs(theme.left - 320) < 1 && Math.abs(theme.top - 240) < 1 && Math.abs(theme.width - 640) < 1,
        'Incorrect containing block: ' + JSON.stringify(theme))
    }
    const text = measured.parts.find(part => part.kind === 'text' && part.paragraph.runs.some(run => run.text.includes('Hello box')))
    check(!!text, 'PPTX box text was not native: ' + JSON.stringify(measured.report))
    check(Math.abs(text.paragraph.rect.x - 320) < 2 && Math.abs(text.paragraph.rect.width - 640) < 2 &&
      Math.abs(text.paragraph.runs[0].style.fontSize - 32 * 96 / 72) < 1, 'PPTX box geometry or font size differs: ' + JSON.stringify(text))
    const archive = await JSZip.loadAsync(Buffer.from(measured.pptx, 'base64'))
    const xml = await archive.file('ppt/slides/slide1.xml').async('string')
    check(xml.includes('Hello box') && /sz="3200"/.test(xml), 'Generated PPTX does not contain the editable text at 32pt')
  })
  await scenario('table-cell-edit-and-break-undo', async () => {
    await click('表セル'); await send('Input.insertText', { text: '修正' }); await delay(180)
    check((await evaluate('state().modelText'))?.includes('| 表の前<br>表の後 | 表セル修正<br> |'), 'Table cell text was not edited')
    await click('表の後', 0); await key('Backspace')
    check((await evaluate('state().modelText'))?.includes('| 表の前表の後 | 表セル修正<br> |'), 'Table break was not deleted')
    await key('z', 2)
    check((await evaluate('state().modelText'))?.includes('| 表の前<br>表の後 | 表セル修正<br> |'), 'One undo did not restore the table break')
    await click('表セル修正'); await key('Delete')
    check((await evaluate('state().modelText'))?.includes('| 表の前<br>表の後 | 表セル修正 |'), 'Trailing table break was not deleted')
    await key('z', 2)
    check((await evaluate('state().modelText'))?.includes('| 表の前<br>表の後 | 表セル修正<br> |'), 'One undo did not restore the trailing table break')
    await click('表セル修正'); await key('Tab')
    check(await evaluate(`trace.some(e => e.type === 'callback.onNotice' && e.detail === 'table-input')`), 'Table Tab did not report its rejection')
  })
  await scenario('paragraph-enter-direct', async () => {
    await click(paragraph); await key('Enter')
    check(!!await evaluate('state().draft && state().editing && state().adapter'), 'Direct paragraph Enter did not retain a draft')
  })
  await scenario('paragraph-enter', async () => {
    await click(paragraph); await key('ArrowLeft'); await key('End'); await key('Enter')
    const s = await evaluate('state()')
    check(s.draft && s.editing && s.adapter, 'Paragraph Enter did not retain an editable empty draft')
    await send('Input.insertText', { text: '次' }); await delay(200)
    check((await evaluate('state()')).modelText.includes(paragraph + '\n\n次'), 'Text did not commit into the new paragraph')
  })
  await scenario('backspace-after-enter', async () => {
    await click(paragraph); await key('ArrowLeft'); await key('End'); await key('Enter'); await key('Backspace'); await key('Backspace')
    check((await evaluate('state()')).modelText?.includes(paragraph.slice(0, -1)+'\n'), 'Backspace could not delete after cancelling the empty paragraph')
  })
  await scenario('draft-navigation', async () => {
    await click(paragraph); await key('Enter',8); await key('ArrowUp')
    let s = await evaluate('state()')
    check(!s.draft && !s.modelDraft, 'Navigating away retained an empty draft')
    await click(paragraph); await key('Backspace')
    s = await evaluate('state()')
    check(s.modelText?.includes(paragraph.slice(0,-1)+'\n'), 'Backspace failed after navigating away from a draft')
    check(!await evaluate(`trace.some(e => e.type === 'model.edit:error')`), 'Document model rejected a later edit')
  })
  await scenario('draft-click-away', async () => {
    await click(paragraph); await key('Enter'); await click('SlideApp 動作確認')
    check(!await evaluate('state().modelDraft'), 'Clicking away retained a model draft')
    await click(paragraph); await key('Backspace')
    check((await evaluate('state()')).modelText?.includes(paragraph.slice(0,-1)+'\n'), 'Backspace failed after clicking away from a draft')
    check(!await evaluate(`trace.some(e => e.type === 'model.edit:error')`), 'Document model rejected a later edit')
  })
  await scenario('shift-enter', async () => {
    await click(paragraph); await key('Enter',8)
    check(!!await evaluate('state().draft'), 'Shift+Enter lost its draft')
    await send('Input.insertText',{text:'次'}); await delay(180)
    check((await evaluate('state()')).modelText?.includes(paragraph+'\n次'), 'Shift+Enter did not commit a softbreak')
    await key('Backspace')
    // Emptying an entire text run is conservatively rejected by the engine;
    // use undo to remove the accepted softbreak and first input as one edit.
    await key('z',2)
    check(!(await evaluate('state()')).modelText?.includes(paragraph+'\n次'), 'Undo did not restore the softbreak')
  })
  await scenario('list-enter', async () => {
    await evaluate(`document.querySelector('.slide-list-host').shadowRoot.querySelector('[data-index="1"]').click()`)
    await delay(200)
    const item = 'この行をクリックして、日本語を入力・変換してみる'
    await click(item); await key('Enter')
    check((await evaluate('state()')).text.includes(item+'\n- '), 'List Enter did not create a new item')
    await send('Input.insertText',{text:'次'}); await delay(180)
    check((await evaluate('state()')).modelText?.includes(item+'\n- 次'), 'New list item did not accept text')
  })
  await scenario('list-tab', async () => {
    await evaluate(`document.querySelector('.slide-list-host').shadowRoot.querySelector('[data-index="1"]').click()`)
    await delay(200)
    await click('太字の部分', 2); await key('ArrowLeft')
    const original = await evaluate('state().text')
    const offset = await evaluate('state().scoped.anchorOffset')
    await key('Tab')
    check(await evaluate('state().modelText') === original.replace('\n- **太字', '\n  - **太字'), 'Tab did not indent only the selected item')
    check(await evaluate('state().scoped.anchorOffset') === offset, 'Tab did not restore the character offset')
    check(await evaluate(`state().scoped.anchor?.text === '太字の部分' && state().editing`), 'Tab lost the editing caret')
    await key('Tab', 8)
    check(await evaluate('state().modelText') === original, 'Shift+Tab did not restore the original hierarchy')
    await key('z', 2)
    check(await evaluate('state().modelText') === original.replace('\n- **太字', '\n  - **太字'), 'One Undo did not undo Shift+Tab')
    await key('z', 2)
    check(await evaluate('state().modelText') === original, 'One Undo did not undo Tab')
  })
  await scenario('paragraph-tab-rejected', async () => {
    await click(paragraph, 3); await key('Tab')
    check(await evaluate(`trace.some(e => e.type === 'callback.onNotice' && e.detail === 'list-indent-target')`), 'Paragraph Tab did not report its rejection')
    check(await evaluate('state().editing && state().scoped.anchorOffset === 3'), 'Rejected Tab moved the editing caret')
  })
  await scenario('ime-confirmation', async () => {
    await click(paragraph)
    await send('Input.imeSetComposition',{text:'てん',selectionStart:2,selectionEnd:2})
    check(await evaluate('state().pendingComposition'), 'CDP composition did not begin')
    await send('Input.imeSetComposition',{text:'・',selectionStart:1,selectionEnd:1})
    await send('Input.insertText',{text:'・'})
    // Simulate an unflagged TSF replay immediately, before the 100ms guard expires.
    await key('Enter')
    let s = await evaluate('state()')
    check(!s.pendingComposition && !s.draft, 'Confirmation Enter started a newline or composition stayed pending')
    check(s.modelText?.includes(paragraph+'・'), 'Converted composition was not committed')
    await key('Backspace')
    s = await evaluate('state()')
    check(s.modelText?.includes(paragraph+'\n'), 'Backspace failed after composition confirmation')
    await key('Enter'); await send('Input.insertText',{text:'次'}); await delay(180)
    check((await evaluate('state()')).modelText?.includes(paragraph+'\n\n次'), 'Deliberate Enter failed after composition confirmation')
  })
  await scenario('drag-selection', async () => {
    await click(paragraph)
    await drag(paragraph,1,8)
    check((await evaluate('state()')).selected === paragraph.slice(1,8), 'Dragged selection collapsed or changed')
    await key('c',2)
    check((await evaluate(`trace.some(e => e.type === 'copy:capture')`)), 'Ctrl+C did not dispatch copy')
    check(await clipboardText() === paragraph.slice(1,8), 'Ctrl+C did not copy the selected text to the Windows clipboard')
  })
  await scenario('element-selection-delete-undo', async () => {
    const original = await evaluate('editor.options.latest().analysis.text')
    await click(paragraph, 3)
    await key('Escape')
    check(await evaluate(`!!document.querySelector('.stage-host').shadowRoot.querySelector('[data-sm-selected]')`), 'Escape did not select the element')
    await key('Escape')
    check(!await evaluate(`document.querySelector('.stage-host').shadowRoot.querySelector('[data-sm-selected]')`), 'Second Escape did not clear selection')
    await click(paragraph, 3); await key('Escape'); await key('Delete')
    check(!await evaluate(`editor.options.latest().analysis.text.includes(${JSON.stringify(paragraph)})`), 'Delete did not remove the selected element')
    await key('z', 2)
    check(await evaluate('editor.options.latest().analysis.text') === original, 'One Undo did not restore the deleted element')
  })
  await scenario('drag-before-editing', async () => {
    await drag(paragraph,1,8)
    const s = await evaluate('state()')
    check(s.selected === paragraph.slice(1,8) && !s.editing, 'Dragging from idle did not preserve the selection without editing')
    await key('c',2)
    check(await evaluate(`trace.some(e => e.type === 'copy:capture')`), 'Ctrl+C did not dispatch copy from idle')
    check(await clipboardText() === paragraph.slice(1,8), 'Ctrl+C did not copy text from idle to the Windows clipboard')
  })
  await scenario('slide-controls-and-history', async () => {
    const initial = await evaluate('editor.options.latest().analysis.text')
    const clickControl = async (expression, button = 'left') => {
      const p = await evaluate(`(() => { const r = (${expression}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
      await mouse('mouseMoved', p)
      await mouse('mousePressed', p, { button, buttons: button === 'left' ? 1 : 2, clickCount: 1 })
      await mouse('mouseReleased', p, { button, buttons: 0, clickCount: 1 })
      await delay(200)
    }
    const list = `document.querySelector('.tab-workspace:not([hidden]) .slide-list-host').shadowRoot`
    const selected = () => evaluate(`${list}.querySelector('.slot[aria-current]').dataset.index`)
    const count = () => evaluate(`${list}.querySelectorAll('.slide-row').length`)
    await clickControl(`document.querySelector('.tab-workspace:not([hidden]) .sidebar-footer button')`)
    check(await count() === 3 && await selected() === '1', 'Plus did not add and select an empty slide')
    await key('m', 2)
    check(await count() === 4 && await selected() === '2', 'Ctrl+M did not add after the displayed slide')
    await key('z', 2)
    check(await count() === 3 && await selected() === '1', 'Undo did not restore the previous slide selection')
    await key('y', 2)
    check(await count() === 4 && await selected() === '2', 'Redo did not restore the new slide selection')
    await key('z', 2); await key('z', 2)
    check(await evaluate('editor.options.latest().analysis.text') === initial && await selected() === '0', 'Undo did not restore the initial source and selection')
    await clickControl(`${list}.querySelector('.slot')`, 'right')
    await clickControl(`${list}.querySelector('[data-command="duplicate"]')`)
    check(await count() === 3 && await selected() === '1', 'Context menu did not duplicate and select the slide')
    await clickControl(`${list}.querySelectorAll('.slot')[1]`, 'right')
    await clickControl(`${list}.querySelector('[data-command="delete"]')`)
    check(await count() === 2 && await selected() === '1', 'Context menu did not delete the slide')
    await key('z', 2)
    check(await count() === 3 && await selected() === '1', 'Undo did not restore the deleted slide')
    await key('z', 2)
    check(await evaluate('editor.options.latest().analysis.text') === initial && await selected() === '0', 'Undo did not restore the source before duplication')
  })
  await scenario('slide-context-menu-after-text-edit', async () => {
    await click(paragraph, paragraph.length)
    await send('Input.insertText', { text: '一覧操作' })
    check(await evaluate('editor.editing'), 'Text editing ended before opening the menu')
    const list = `document.querySelector('.tab-workspace:not([hidden]) .slide-list-host').shadowRoot`
    const p = await evaluate(`(() => { const r = ${list}.querySelector('.slide-row').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
    await mouse('mouseMoved', p)
    await mouse('mousePressed', p, { button: 'right', buttons: 2, clickCount: 1 })
    await mouse('mouseReleased', p, { button: 'right', buttons: 0, clickCount: 1 })
    await delay(250)
    check(await evaluate(`!!${list}.querySelector('.slide-menu')`), 'Text-edit thumbnail update dismissed the context menu')
    check(await evaluate(`${list}.activeElement?.dataset.command`) === 'add', 'Text-edit thumbnail update stole menu focus')
    check(!await evaluate('editor.editing'), 'Opening the context menu did not finish text editing')
    await key('ArrowDown'); await key('Enter')
    check(await evaluate(`${list}.querySelectorAll('.slide-row').length`) === 3, 'The context menu could not duplicate after text editing')
    check(await evaluate('editor.options.latest().analysis.text.split("一覧操作").length') === 3, 'Duplication lost the committed text edit')
  })
  await scenario('slide-drag-after-text-edit-and-history', async () => {
    await click(paragraph, paragraph.length)
    await send('Input.insertText', { text: 'ドラッグ操作' })
    check(await evaluate('editor.editing'), 'Text editing ended before dragging')
    const initial = await evaluate('editor.options.latest().analysis.text')
    const points = await evaluate(`(() => {
      const rows = [...document.querySelector('.tab-workspace:not([hidden]) .slide-list-host').shadowRoot.querySelectorAll('.slide-row')];
      const a = rows[0].getBoundingClientRect(), b = rows[1].getBoundingClientRect();
      return {a:{x:a.x+a.width/2,y:a.y+a.height/2},b:{x:b.x+b.width/2,y:b.bottom-4}};
    })()`)
    await mouse('mouseMoved', points.a)
    await mouse('mousePressed', points.a, { button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 12; i++) {
      await mouse('mouseMoved', { x: points.a.x + (points.b.x - points.a.x) * i / 12, y: points.a.y + (points.b.y - points.a.y) * i / 12 }, { button: 'left', buttons: 1 })
      await delay(20)
    }
    await mouse('mouseReleased', points.b, { button: 'left', buttons: 0, clickCount: 1 })
    await delay(200)
    const moved = await evaluate('editor.options.latest().analysis.text')
    check(moved.indexOf('## 日本語入力のテスト') < moved.indexOf('# SlideApp 動作確認'), 'Drag did not reorder the slide bodies')
    check(moved.includes('ドラッグ操作') && !await evaluate('editor.editing'), 'Drag did not commit and preserve the text edit')
    check(await evaluate(`document.querySelector('.slide-list-host').shadowRoot.querySelector('.slot[aria-current]').dataset.index`) === '1', 'Drag did not select the moved slide')
    await key('z', 2)
    check(await evaluate('editor.options.latest().analysis.text') === initial, 'Undo did not restore source after drag')
    await key('y', 2)
    check(await evaluate('editor.options.latest().analysis.text') === moved, 'Redo did not restore dragged source')
  })
  const show = `document.querySelector('[role="region"][aria-label="スライドショー"]')`
  const showText = `${show}?.firstElementChild?.shadowRoot?.querySelector('.frame')?.textContent`
  const startShow = async () => { await evaluate(`document.querySelector('button[title*="F5"]').click()`); await waitFor(`!!${showText}`); await delay(300) }
  const selectSlide = async index => { await evaluate(`document.querySelector('.slide-list-host').shadowRoot.querySelectorAll('.slot')[${index}].click()`); await delay(200) }
  const activeSlide = `document.querySelector('.slide-list-host').shadowRoot.querySelector('.slot[data-active="true"]')`
  await scenario('slideshow-start-navigation-shortcuts-and-window', async () => {
    const windowState = `((await import('/node_modules/.vite/deps/@tauri-apps_api_window.js')).getCurrentWindow())`
    await evaluate(`(async()=>{const w=${windowState}; if(await w.isFullscreen()) await w.setFullscreen(false); if(await w.isMaximized()) await w.unmaximize()})()`)
    const secondFixture = join(fixtureDirectory, 'second.md')
    await writeFile(secondFixture, '# Second tab\n')
    await evaluate(`(async()=>{const {platform}=await import('/src/platform/index.ts'); platform.pickMarkdownFile=async()=>${JSON.stringify(secondFixture)}; document.querySelector('.file-tab-open').click()})()`)
    await waitFor(`document.querySelectorAll('[role="tab"]').length === 2 && [...document.querySelectorAll('[role="tab"]')].some(e=>e.title === ${JSON.stringify(secondFixture)} && e.getAttribute('aria-selected') === 'true')`)
    await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(e=>e.title === ${JSON.stringify(fixture)}).click()`)
    await waitFor(`document.querySelector('[role="tab"][aria-selected="true"]')?.title === ${JSON.stringify(fixture)}`)
    await waitFor(`!!document.querySelector('.stage-host')?.shadowRoot?.querySelector('[data-sm-run]')`)
    await click(paragraph); await send('Input.insertText',{text:'取消防止'}); await delay(200)
    await selectSlide(1); await startShow()
    check((await evaluate(showText)).includes('SlideApp 動作確認'), 'Toolbar did not start on first slide')
    check(await evaluate(`(async()=>await ${windowState}.isFullscreen())()`), 'Window did not enter fullscreen')
    await key('ArrowRight'); check((await evaluate(showText)).includes('日本語入力のテスト'), 'Right did not advance')
    await key('ArrowLeft'); check((await evaluate(showText)).includes('SlideApp 動作確認'), 'Left did not go back')
    await mouse('mouseWheel', {x:100,y:100}, {deltaX:0,deltaY:100}); await delay(200)
    check((await evaluate(showText)).includes('日本語入力のテスト'), 'Wheel down did not advance')
    await mouse('mouseWheel', {x:100,y:100}, {deltaX:0,deltaY:-100}); await delay(200)
    check((await evaluate(showText)).includes('SlideApp 動作確認'), 'Wheel up did not go back')
    await key('End'); check((await evaluate(showText)).includes('日本語入力のテスト'), 'End did not select last slide')
    await key('Home'); check((await evaluate(showText)).includes('SlideApp 動作確認'), 'Home did not select first slide')
    await key('2'); await key('Enter')
    check((await evaluate(showText)).includes('日本語入力のテスト'), 'Number and Enter did not navigate')
    await key('b'); check(await evaluate(`${show}.firstElementChild.style.display === 'none' && ${show}.style.background === 'rgb(0, 0, 0)'`), 'B did not blank black')
    await key('w'); check(await evaluate(`${show}.style.background === 'rgb(255, 255, 255)'`), 'W did not blank white')
    await key('w'); check(await evaluate(`${show}.firstElementChild.style.display !== 'none'`), 'W did not restore slide')
    await evaluate(`(async()=>{ const {platform}=await import('/src/platform/index.ts'); const save=platform.saveFile; window.showSaveCount=0; platform.saveFile=(...args)=>{ window.showSaveCount++; return save(...args) } })()` )
    const beforeShortcuts = await evaluate(`JSON.stringify({text:state().modelText, tab:document.querySelector('[role=tab][aria-selected=true]')?.textContent})`)
    await key('s',2); await key('z',2); await key('Tab',2)
    check(await evaluate(`!!${show} && JSON.stringify({text:state().modelText, tab:document.querySelector('[role=tab][aria-selected=true]')?.textContent}) === ${JSON.stringify(beforeShortcuts)} && window.showSaveCount === 0`), 'Application shortcut escaped slideshow')
    await key('Escape'); await waitFor(`!${show}`)
    check(await evaluate(`${activeSlide} === document.querySelector('.slide-list-host').shadowRoot.querySelectorAll('.slot')[1]`), 'Exit did not select current slide')
    check(!await evaluate(`(async()=>await ${windowState}.isFullscreen())()`), 'Normal window was not restored')
    await evaluate(`(async()=>await ${windowState}.maximize())()`); await delay(250)
    await evaluate(`document.querySelector('button[aria-haspopup="menu"][aria-label="スライドショー"]').click()`)
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('現在のスライドから')).click()`)
    await waitFor(`!!${showText}`); check((await evaluate(showText)).includes('日本語入力のテスト'), 'Menu did not start at current slide')
    await key('Escape'); await waitFor(`!${show}`)
    check(await evaluate(`(async()=>await ${windowState}.isMaximized())()`), 'Maximized window was not restored')
    await evaluate(`(async()=>await ${windowState}.unmaximize())()`); await delay(200)
    await key('F5'); await waitFor(`!!${showText}`); check((await evaluate(showText)).includes('SlideApp 動作確認'), 'F5 did not start first')
    await key('Escape'); await waitFor(`!${show}`); await selectSlide(1)
    await key('F5',8); await waitFor(`!!${showText}`); check((await evaluate(showText)).includes('日本語入力のテスト'), 'Shift+F5 did not start current')
    await mouse('mousePressed',{x:100,y:100},{button:'left',buttons:1,clickCount:1}); await mouse('mouseReleased',{x:100,y:100},{button:'left',buttons:0,clickCount:1})
    await waitFor(`${show}.textContent.includes('スライドショーの最後です')`)
    await key('ArrowLeft'); check((await evaluate(showText)).includes('日本語入力のテスト'), 'Previous from end did not return')
    await key('ArrowRight')
    await mouse('mousePressed',{x:100,y:100},{button:'left',buttons:1,clickCount:1}); await mouse('mouseReleased',{x:100,y:100},{button:'left',buttons:0,clickCount:1})
    await waitFor(`!${show}`)
    await evaluate(`(async()=>await ${windowState}.setFullscreen(true))()`); await delay(300)
    await startShow(); await key('Escape'); await waitFor(`!${show}`)
    check(await evaluate(`(async()=>await ${windowState}.isFullscreen())()`), 'Originally fullscreen window was not preserved')
    await evaluate(`(async()=>await ${windowState}.setFullscreen(false))()`); await delay(300)
  })
  await scenario('slideshow-edit-and-external-change', async () => {
    await click(paragraph, paragraph.length)
    await send('Input.insertText',{text:'確定済み'}); await delay(200)
    await startShow()
    check((await evaluate(showText)).includes('確定済み'), 'Slideshow omitted the committed edit')
    check(!await evaluate('state().editing'), 'Editing was not finished')
    try {
      await writeFile(fixture, Buffer.concat([sample, Buffer.from('\n外部変更スライドショー\n')]))
      await delay(1800)
      check(!(await evaluate(showText)).includes('外部変更スライドショー'), 'External change altered slideshow snapshot')
      check(!await evaluate(`document.body.textContent.includes('このファイルは外部で変更されました。')`), 'External conflict appeared during slideshow')
      await key('Escape'); await waitFor(`!${show}`)
      await waitFor(`document.body.textContent.includes('このファイルは外部で変更されました。')`)
    } finally { await writeFile(fixture, sample) }
  })
  await scenario('slideshow-waits-for-composition', async () => {
    await click(paragraph)
    await send('Input.imeSetComposition', {text:'てん', selectionStart:2, selectionEnd:2})
    check(await evaluate('state().pendingComposition'), 'Composition did not begin')
    await evaluate(`document.querySelector('button[title*="F5"]').click()`)
    await delay(200)
    check(!await evaluate(`!!${show}`), 'Slideshow started during composition')
    await send('Input.imeSetComposition', {text:'点', selectionStart:1, selectionEnd:1})
    await send('Input.insertText', {text:'点'})
    await waitFor(`${showText}?.includes('点')`)
    check(!await evaluate('state().editing'), 'Composition was not committed before slideshow')
    await key('Escape'); await waitFor(`!${show}`)
  })
  await scenario('slideshow-layout-matches-preview', async () => {
    await evaluate(`document.querySelector('button[title="テキストボックスを挿入"]').click()`)
    await waitFor('!!state().draft && !!state().editing')
    await send('Input.insertText', {text:'配置比較の箱'}); await delay(200); await key('Escape')
    const bounds = (root, selector) => `(() => {
      const root=${root}, section=root.querySelector('section'), element=root.querySelector(${JSON.stringify(selector)});
      if (!section || !element) throw Error('Missing layout element: ' + ${JSON.stringify(selector)});
      const a=section.getBoundingClientRect(), b=element.getBoundingClientRect();
      return [(b.left-a.left)/a.width,(b.top-a.top)/a.height,b.width/a.width,b.height/a.height];
    })()`
    const checkBounds = (a,b,name) => check(a.every((value,i) => Math.abs(value-b[i]) < 0.025), name + ' placement differs: ' + JSON.stringify({preview:a,show:b}))
    const stage = `document.querySelector('.stage-host').shadowRoot.querySelector('.slot[data-active="true"]')`
    const showRoot = `${show}.firstElementChild.shadowRoot`
    const table = await evaluate(bounds(stage,'table')), box = await evaluate(bounds(stage,'[data-box]'))
    await startShow()
    checkBounds(table, await evaluate(bounds(showRoot,'table')), 'Table')
    checkBounds(box, await evaluate(bounds(showRoot,'[data-box]')), 'Text box')
    check(await evaluate(`!${showRoot}.querySelector('[data-sm-selected], [data-sm-box-handle], [contenteditable="true"]')`), 'Editing decorations leaked into slideshow')
    await key('ArrowRight'); await waitFor(`${showText}?.includes('日本語入力のテスト')`)
    await key('Escape'); await waitFor(`!${show}`)
    await waitFor(`${stage}.querySelector('section')?.getBoundingClientRect().width > 0 && !!${stage}.querySelector('img')`)
    const image = await evaluate(bounds(stage,'img'))
    await evaluate(`document.querySelector('button[aria-haspopup="menu"][aria-label="スライドショー"]').click()`)
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('現在のスライドから')).click()`)
    await waitFor(`!!${showText}`)
    checkBounds(image, await evaluate(bounds(showRoot,'img')), 'Image')
    await key('Escape'); await waitFor(`!${show}`)
  })
  await writeFile(join(output,'results.json'), JSON.stringify(results,null,2))
  console.log('Traces: ' + output)
  check((await readFile(fixture)).equals(sample), 'The on-disk fixture was unexpectedly modified')
  if (results.some(r=>!r.passed)) process.exitCode = 1
} finally {
  ws?.close()
  if (child?.pid) spawnSync('taskkill', ['/PID',String(child.pid),'/T','/F'], { windowsHide:true, stdio:'ignore' })
  const stopped = !child || await Promise.race([childClosed.then(() => true), delay(10000).then(() => false)])
  await launchLog?.close()
  if (!stopped) console.warn('Warning: test process did not exit; leaving its profiles in place')
  else if (child?.pid) for (const path of profilePaths) {
    try { await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
    catch (error) { console.warn('Warning: could not remove test profile ' + path + ': ' + error.message) }
  }
}
