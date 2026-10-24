// Real WebView2 input regression runner. See docs/webview2-editing.md.
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const port = Number(process.env.CDP_PORT ?? 9222)
const output = resolve(process.env.TRACE_DIR ?? await mkdtemp(join(tmpdir(), 'slideapp-webview2-')))
await mkdir(output, { recursive: true })
const fixtureDirectory = await mkdtemp(join(output, 'fixture-'))
const fixture = join(fixtureDirectory, 'sample.md')
const sample = process.env.SAMPLE_MD
  ? await readFile(process.env.SAMPLE_MD)
  : Buffer.from('---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# SlideApp 動作確認\n\n文字をクリックして直接編集できるか試すためのサンプル。・・\n\n---\n\n## 日本語入力のテスト\n\n- この行をクリックして、日本語を入力・変換してみる\n- **太字の部分**と*斜体の部分*も編集してみる\n')
await writeFile(fixture, sample)
let child, appChild, ws, launchLog, launchError
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
  const code = { Tab: 9, Enter: 13, Backspace: 8, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, c: 67, m: 77, y: 89, z: 90 }[key]
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
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {source:`window.editingProbeNavigation = ${JSON.stringify(navigation)}`})
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
    document.querySelector('.empty-open-button').click();
  })()`)
  await waitFor(`!!window.editor?.adapter && !!document.querySelector('.stage-host')?.shadowRoot?.querySelector('[data-sm-run]')`)
  await delay(250)
}
async function scenario(name, run) {
  await setup()
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
  if (process.argv.includes('--launch')) {
    for (const url of [`http://localhost:${port}/json/version`,'http://localhost:1420/']) {
      const occupied = await fetch(url).then(()=>true,()=>false)
      if (occupied) throw new Error('Refusing to launch while a required port is occupied: '+url)
    }
    const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }
    // An existing Tauri *debug* executable can host this checkout's Vite code
    // when the local MSVC build environment is unavailable. No backend is mocked.
    const hostExe = process.env.WEBVIEW2_HOST_EXE
    launchLog = await open(join(output,'launch.log'),'w')
    child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d','/s','/c',hostExe ? 'npm.cmd run dev' : 'npm.cmd run tauri dev'], { windowsHide: true, env, stdio: ['ignore',launchLog.fd,launchLog.fd] })
    child.on('error',error=>{launchError=error})
    if (hostExe) {
      for (let i=0;i<100;i++) {
        if (launchError) throw launchError
        if (child.exitCode !== null) throw new Error('Vite launch failed; see '+join(output,'launch.log'))
        if (await fetch('http://localhost:1420/').then(()=>true,()=>false)) break
        await delay(200)
      }
      appChild = spawn(hostExe,[],{windowsHide:true,env,stdio:['ignore',launchLog.fd,launchLog.fd]})
      appChild.on('error',error=>{launchError=error})
    }
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
  await writeFile(join(output,'results.json'), JSON.stringify(results,null,2))
  console.log('Traces: ' + output)
  check((await readFile(fixture)).equals(sample), 'The on-disk fixture was unexpectedly modified')
  if (results.some(r=>!r.passed)) process.exitCode = 1
} finally {
  ws?.close()
  if (appChild?.pid) spawnSync('taskkill', ['/PID',String(appChild.pid),'/T','/F'], { windowsHide:true, stdio:'ignore' })
  if (child?.pid) spawnSync('taskkill', ['/PID',String(child.pid),'/T','/F'], { windowsHide:true, stdio:'ignore' })
  await launchLog?.close()
}
