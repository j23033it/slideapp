// Run the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9338.
// This verification entry point speaks CDP directly to the application, never to another user's tab.
import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import assert from 'node:assert/strict'
import { regressionCases } from './regressions.mjs'

const pages = await fetch('http://127.0.0.1:9338/json/list').then(r => r.json())
const page = pages.find(p => p.type === 'page' && p.url.includes('127.0.0.1:1422'))
if (!page) throw new Error('SlideApp WebView2 CDP target not found')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }) })
let serial = 0
const pending = new Map()
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  const request = pending.get(message.id)
  if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(message.error) : request.resolve(message.result) }
})
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 120000)
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const outputDir = await mkdtemp(join(tmpdir(), 'slideapp-pptx-webview2-'))
const baseDir = resolve('tests/fixtures/export')
const summary = []
const pixelChecks = []
const escapeXml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&apos;').replaceAll('"', '&quot;')
try {
  console.log(JSON.stringify({ outputDir, userAgent: await evaluate('navigator.userAgent') }))
  // Vite dependency discovery can reload the page once. Import before starting fixture work.
  await evaluate("import('/src/export/pptx/devHarness.ts').then(() => true)")
  await evaluate(`import('/node_modules/@tauri-apps/api/core.js').then(m => m.invoke('open_file',{path:${JSON.stringify(join(baseDir, 'default.md'))}}))`)
  const cases = await Promise.all((await readdir(baseDir)).filter(n => n.endsWith('.md')).map(async name => [name, await readFile(join(baseDir, name), 'utf8')]))
  cases.push(...Object.entries(regressionCases).map(([name, markdown]) => [`review-${name}.md`, markdown]))
  for (const [name, markdown] of cases) {
    const result = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m => m.exportFixtureForCDP(${JSON.stringify(markdown)},${JSON.stringify(baseDir)}))`)
    const bytes = Buffer.from(result.base64, 'base64')
    const stem = name.slice(0, -3)
    await writeFile(join(outputDir, `${stem}.pptx`), bytes)
    const { base64: _base64, ...model } = result
    if (/^review-(inline-image|table-image|list-heading|inline-fill|nested-bg|text-transform|pseudo-img|pseudo-bg|pseudo-empty|pseudo-overflow|section-pseudo|section-css|section-filter|section-effects-bg|raster-shadow|raster-filter)\.md$/.test(name)) {
      assert.ok(model.report.rasterizedCount > 0, `${name}: unsupported appearance must be reported`)
      assert.ok(model.slides[0].parts.some(part => part.kind === 'image'))
    }
    if (name === 'review-hidden.md') assert.ok(!JSON.stringify(model.slides).includes('HIDDEN_'))
    if (name === 'review-transparent-text.md' || name === 'review-half-alpha.md') {
      const runs = model.slides[0].parts.filter(part => part.kind === 'text').flatMap(part => part.paragraph.runs)
      assert.equal(runs.find(run => /INVISIBLE|FAINT/.test(run.text)).style.transparency, name.includes('half-alpha') ? 75 : 100)
    }
    if (name === 'review-table-style.md') assert.ok(model.slides[0].parts.find(part => part.kind === 'table').rows[1].every(cell => cell.valign === 'bottom'))
    if (name === 'review-raster-shadow.md') {
      const rect = model.slides[0].parts.find(part => part.kind === 'image').rect
      const { heading } = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.showFixtureForCDP(${JSON.stringify(markdown)},${JSON.stringify(baseDir)},0))`)
      assert.ok(rect.x <= heading.left && rect.x + rect.width >= heading.right + 20, 'Shadow image must expand beyond the heading border box')
    }
    if (name === 'fit.md') {
      const heading = model.slides[0].parts.find(p => p.kind === 'text')
      assert.ok(heading.paragraph.runs[0].style.fontSize < 40, 'Auto-fit font size must use the actual SVG scale')
      assert.equal(heading.paragraph.wrap, false, 'A fitted single-line heading must stay on one line in Office')
    }
    if (name === 'default.md') {
      assert.ok(model.slides[2].parts.some(p => p.kind === 'table'), 'The representative table must remain native')
      const lists = model.slides[1].parts.filter(p => p.kind === 'list')
      assert.deepEqual(lists[0].paragraphs.map(p => p.list.level), [0, 1, 2, 0])
      assert.deepEqual(lists[1].paragraphs.map(p => p.list.start), [3, 4])
      // A nonempty rounded code background is insufficient: actual syntax glyphs must exist.
      const codeImage = model.slides[2].parts.find(p => p.kind === 'image')
      const redPixels = await evaluate(`(async()=>{const image=new Image();image.src=${JSON.stringify(codeImage.data)};await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]>150&&d[i+1]<100&&d[i+2]<100&&d[i+3]>0)n++;return n})()`)
      assert.ok(redPixels > 50, 'Marp shadow-SVG slot content must survive rasterization')
    }
    await writeFile(join(outputDir, `${stem}.json`), JSON.stringify(model, null, 2))
    const zip = await JSZip.loadAsync(bytes)
    const paths = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    assert.equal(paths.length, model.slides.length)
    for (let i = 0; i < model.slides.length; i++) {
      const slide = model.slides[i]
      const xml = await zip.file(`ppt/slides/slide${i + 1}.xml`).async('string')
      for (const [index, list] of slide.parts.filter(p => p.kind === 'list').entries()) {
        const shape = [...xml.matchAll(/<p:sp>.*?<\/p:sp>/gs)].find(m => m[0].includes(`name="SlideApp list ${index + 1}"`))?.[0]
        assert.ok(shape, 'Each whole list must have one native text box')
        const paragraphs = [...shape.matchAll(/<a:p>(.*?)<\/a:p>/gs)].map(m => m[1])
        assert.equal(paragraphs.length, list.paragraphs.length)
        for (const [j, p] of list.paragraphs.entries()) {
          assert.ok(paragraphs[j].includes(`lvl="${Math.min(8, p.list?.level ?? 0)}"`))
          assert.ok(paragraphs[j].includes(`marL="${Math.round((p.rect.x - list.rect.x) * 9525)}"`))
          for (const run of p.runs) for (const line of run.text.split('\n')) assert.ok(paragraphs[j].includes(escapeXml(line)))
          if (p.list?.type === 'decimal') assert.ok(paragraphs[j].includes(`startAt="${p.list.start}"`))
        }
      }
      for (const table of slide.parts.filter(p => p.kind === 'table')) {
        for (const width of table.columnWidths) assert.ok(xml.includes(`<a:gridCol w="${Math.round(width * 9525)}"/>`))
        for (const height of table.rowHeights) assert.ok(xml.includes(`<a:tr h="${Math.round(height * 9525)}">`))
        for (const cell of table.rows.flat()) {
          const [top, right, bottom, left] = cell.style.padding.map(px => Math.round(px * 9525))
          assert.ok(xml.includes(`marL="${left}" marR="${right}" marT="${top}" marB="${bottom}"`))
        }
      }
      for (const part of slide.parts.filter(p => p.kind === 'text')) {
        const text = part.paragraph.runs.map(r => r.text).join('')
        assert.ok(xml.includes(escapeXml(text)) || part.paragraph.runs.every(r => xml.includes(escapeXml(r.text))), `Missing editable text: ${text}`)
        const p = part.paragraph
        const x = Math.round((p.rect.x - (p.list && p.list.type !== 'none' ? p.list.indent : 0)) * 9525)
        const y = Math.round(p.rect.y * 9525)
        assert.ok([...xml.matchAll(/<a:off x="([\d-]+)" y="([\d-]+)"\/>/g)].some(m => Math.abs(Number(m[1]) - x) <= 1 && Math.abs(Number(m[2]) - y) <= 1), `Position mismatch: ${text}`)
      }
      if (slide.notes.length) {
        const notes = await zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`).async('string')
        for (const note of slide.notes) assert.ok(notes.replaceAll('\r\n', '\n').includes(escapeXml(note)))
      }
      const viewport = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m => m.showFixtureForCDP(${JSON.stringify(markdown)},${JSON.stringify(baseDir)},${i}))`)
      await command('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false })
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 } })
      await writeFile(join(outputDir, `${stem}-${i + 1}-webview2.png`), Buffer.from(screenshot.data, 'base64'))
      if (name === 'math.md' || /^review-(table-image|inline-image|list-heading|hidden|inline-fill|nested-bg|text-transform|pseudo-.+|section-.+|raster-.+)\.md$/.test(name)) {
        const results = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.compareRasterForCDP(${JSON.stringify(`data:image/png;base64,${screenshot.data}`)},${JSON.stringify(slide.parts.filter(part => part.kind === 'image'))}))`)
        pixelChecks.push({ name, slide: i + 1, results })
        await writeFile(join(outputDir, 'pixel-checks.json'), JSON.stringify(pixelChecks, null, 2))
        // A coarse paint-loss check supplements model/XML assertions and manual
        // Office comparison; LCD text and grayscale SVG text have different AA.
        for (const result of results) assert.ok(result.ratio < .35, `${name}: raster lost or moved visible pixels (${result.ratio})`)
        if (name === 'review-inline-image.md') {
          const emptyParts = slide.parts.filter(part => part.kind === 'image').map(part => ({...part, data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='}))
          const lost = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.compareRasterForCDP(${JSON.stringify(`data:image/png;base64,${screenshot.data}`)},${JSON.stringify(emptyParts)}))`)
          assert.ok(lost.some(result => result.ratio > .35), 'Pixel check must detect a replaced/lost image')
        }
      }
      await evaluate("import('/src/export/pptx/devHarness.ts').then(m => m.hideFixtureForCDP())")
    }
    summary.push({ name, bytes: bytes.length, slides: paths.length, report: model.report })
    console.log(JSON.stringify(summary.at(-1)))
  }
  const failureChecks = []
  for (const property of ['content:url("./does-not-exist.png")', 'content:"";background-image:url("./does-not-exist.png")']) {
    const markdown = `<style>h1::before {${property};display:block;width:100px;height:100px}</style>\n\n# Missing pseudo asset`
    const error = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.exportFixtureForCDP(${JSON.stringify(markdown)},${JSON.stringify(baseDir)})).then(()=>null,e=>e.message)`)
    assert.match(error, /h1::before|marp-h1::before/)
    failureChecks.push({ property, error })
  }
  await writeFile(join(outputDir, 'asset-failures.json'), JSON.stringify(failureChecks, null, 2))
  const markdown = '---\nmarp: true\ntheme: gaia\n---\n' + Array.from({length:50}, (_, i) => `# Slide ${i + 1}\n\nText 日本語\n\n<!-- Note ${i + 1} -->`).join('\n\n---\n\n')
  const start = Date.now()
  const performanceResult = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.exportFixtureForCDP(${JSON.stringify(markdown)},${JSON.stringify(baseDir)}))`)
  const elapsedMs = Date.now() - start
  const perfBytes = Buffer.from(performanceResult.base64, 'base64')
  const media = Object.keys((await JSZip.loadAsync(perfBytes)).files).filter(path => /^ppt\/media\/.*\.png$/.test(path))
  assert.equal(media.length, 1, 'Fifty identical gradient backgrounds must share one PNG')
  await writeFile(join(outputDir, 'fifty-gaia.pptx'), perfBytes)
  await writeFile(join(outputDir, 'fifty-gaia.json'), JSON.stringify({slides:performanceResult.slides,report:performanceResult.report}))
  await writeFile(join(outputDir, 'performance.json'), JSON.stringify({elapsedMs, bytes:perfBytes.length, media:media.length}, null, 2))
  console.log(JSON.stringify({performance:{elapsedMs, bytes:perfBytes.length, media:media.length}}))
  for (let index = 0; index < 50; index++) {
    const viewport = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.showFixtureForCDP(${JSON.stringify(markdown)},${JSON.stringify(baseDir)},${index}))`)
    await command('Emulation.setDeviceMetricsOverride', {width:viewport.width, height:viewport.height, deviceScaleFactor:1, mobile:false})
    const screenshot = await command('Page.captureScreenshot', {format:'png', clip:{x:0,y:0,width:viewport.width,height:viewport.height,scale:1}})
    await writeFile(join(outputDir, `fifty-gaia-${index + 1}-webview2.png`), Buffer.from(screenshot.data, 'base64'))
  }
  await writeFile(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2))
  const fontBytes = await readFile('C:/Windows/Fonts/arial.ttf')
  const fontCSS = `@font-face {font-family:SlideAppProbeWebFont;src:url(data:font/ttf;base64,${fontBytes.toString('base64')}) format('truetype');}`
  const probe = await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.probeRasterization('default',${JSON.stringify(fontCSS)}))`)
  assert.ok(probe.nonTransparent > 0)
  await writeFile(join(outputDir, 'raster-probe.json'), JSON.stringify(probe, null, 2))
  console.log(JSON.stringify({ embeddedWebFont: probe }))
} finally {
  await command('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await evaluate("import('/src/export/pptx/devHarness.ts').then(m => m.hideFixtureForCDP())").catch(() => {})
  await evaluate("import('/node_modules/@tauri-apps/api/core.js').then(m=>m.invoke('stop_watching'))").catch(() => {})
  socket.close()
}
