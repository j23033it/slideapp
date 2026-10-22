// Offline/local inspection harness. No extra browser automation dependency.
// node src/export/pptx/inspect-chrome.mjs input.md [--inspect-dir temp-dir]
// Add --fixtures to retain every fixture/review deck for the existing COM audit.
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdtemp, mkdir, readdir } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { regressionCases } from '../../../tests/export/regressions.mjs'

const args = process.argv.slice(2), options = {}, sources = []
while (args.length) {
  const arg = args.shift()
  if (arg === '--fixtures') options.fixtures = true
  else if (['--inspect-dir', '--browser-path'].includes(arg) && args.length) options[arg] = args.shift()
  else if (arg.startsWith('--')) throw Error(`Unknown option: ${arg}`)
  else sources.push(resolve(arg))
}
const root = process.cwd(), fixtureDir = join(root, 'tests/fixtures/export')
if (!sources.length && !options.fixtures) sources.push(join(fixtureDir, 'parity.md'))
const outputDir = options['--inspect-dir'] ? resolve(options['--inspect-dir']) : await mkdtemp(join(tmpdir(), 'slideapp-inspect-'))
await mkdir(outputDir, { recursive: true })
const cases = []
for (const source of sources) cases.push({ name: basename(source).replace(/\.md$/i, ''), markdown: await readFile(source, 'utf8'), base: dirname(source) })
if (options.fixtures) {
  for (const file of await readdir(fixtureDir)) if (file.endsWith('.md')) cases.push({ name: file.slice(0, -3), markdown: await readFile(join(fixtureDir, file), 'utf8'), base: fixtureDir })
  cases.push(...Object.entries(regressionCases).map(([name, markdown]) => ({ name: `review-${name}`, markdown, base: fixtureDir })))
}
if (new Set(cases.map(c => c.name)).size !== cases.length) throw Error('Duplicate inspection names')
const server = await createServer({ root, cacheDir: join(outputDir, '.vite'), server: { host: '127.0.0.1', port: 0, fs: { allow: [root, ...cases.map(c => c.base)] } }, optimizeDeps: { include: ['html-to-image', 'pptxgenjs', 'jszip'] } })
const profile = await mkdtemp(join(tmpdir(), 'slideapp-inspect-chrome-'))
let browserProcess, browserSocket, socket
let serial = 0
const pending = new Map()
function connect(url) {
  const connection = new WebSocket(url)
  connection.addEventListener('message', ({data}) => { const m = JSON.parse(data), p = pending.get(m.id); if (p) {pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)} })
  return new Promise((ok, fail) => { connection.addEventListener('open', () => ok(connection), {once:true}); connection.addEventListener('error', fail, {once:true}) })
}
const command = (method, params = {}, target = socket) => new Promise((resolve, reject) => {
  const id = ++serial, timer = setTimeout(() => {pending.delete(id);reject(Error(`${method} timed out`))}, 120000)
  pending.set(id, {resolve,reject,timer});target.send(JSON.stringify({id,method,params}))
})
const evaluate = async expression => { const r = await command('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));return r.result.value }
const pause = ms => new Promise(ok => setTimeout(ok, ms))
try {
  await server.listen()
  const url = server.resolvedUrls.local[0]
  browserProcess = spawn(options['--browser-path'] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide:true, stdio:'ignore' })
  let spawnError
  browserProcess.on('error', error => {spawnError = error})
  let port
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);break } catch { await pause(100) }
  }
  if (!port) throw Error('Chrome did not expose its inspection port')
  const endpoint = `http://127.0.0.1:${port}`
  const version = await fetch(`${endpoint}/json/version`).then(r => r.json())
  browserSocket = await connect(version.webSocketDebuggerUrl)
  const target = (await fetch(`${endpoint}/json/list`).then(r => r.json())).find(p => p.type === 'page')
  socket = await connect(target.webSocketDebuggerUrl)
  await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', {width:1280,height:720,deviceScaleFactor:1,mobile:false})
  await command('Page.navigate', {url})
  // Wait on actual document/module readiness. Vite can reload after discovery.
  let ready = false
  for (let i = 0; i < 60; i++) {
    await pause(250)
    try { ready = await evaluate("location.href.startsWith('http:') && document.readyState==='complete' && import('/src/export/pptx/devHarness.ts').then(()=>true)");if(ready)break } catch { /* a Vite dependency reload can invalidate a context */ }
  }
  if (!ready) throw Error('Inspection page did not become ready')
  await pause(500)
  const summary = []
  console.log(JSON.stringify({outputDir,browser:version.Browser}))
  for (const item of cases) {
    const result = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.inspectFixtureForCDP(${JSON.stringify(item.markdown)},${JSON.stringify(item.base)}))`)
    const { base64, inspection, ...model } = result
    await writeFile(join(outputDir, `${item.name}.pptx`), Buffer.from(base64, 'base64'))
    await writeFile(join(outputDir, `${item.name}.json`), JSON.stringify(model, null, 2))
    for (const snapshot of inspection) {
      await writeFile(join(outputDir, `${item.name}-dom-${snapshot.slide}.png`), Buffer.from(snapshot.png.split(',')[1], 'base64'))
      await writeFile(join(outputDir, `${item.name}-${snapshot.slide}.html`), snapshot.html)
    }
    const record = {name:item.name,slides:model.slides.length,rasterized:model.report.rasterizedElements,errors:model.report.errors??[]}
    summary.push(record);console.log(JSON.stringify(record))
  }
  await writeFile(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2))
} finally {
  if (browserSocket) await command('Browser.close', {}, browserSocket).catch(() => {})
  socket?.close();browserSocket?.close()
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
  if (browserProcess && browserProcess.exitCode === null) {
    await Promise.race([new Promise(ok => browserProcess.once('exit', ok)), pause(3000)])
    if (browserProcess.exitCode === null) browserProcess.kill()
  }
  await server.close()
}
