// Repository's documented WebView2 CDP verification workflow. Start serve.mjs + SlideApp first.
import { readFile, readdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { regressionCases } from '../../../tests/export/regressions.mjs'
const page=(await fetch('http://127.0.0.1:9338/json/list').then(r=>r.json())).find(p=>p.type==='page'&&p.url.includes('127.0.0.1:1422'))
if(!page) throw Error('SlideApp WebView2 target not found')
const socket=new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok,fail)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',fail,{once:true})})
let serial=0;const pending=new Map()
socket.addEventListener('message',({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(m.error):p.resolve(m.result)}})
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error(`${method} timed out`))},120000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
const outputDir=await mkdtemp(join(tmpdir(),'slideapp-css-audit-')),baseDir=resolve('tests/fixtures/export')
const styled=(css,body)=>`<style>${css}</style>\n\n${body}`
const cases={
  'audit-solid-list':styled('ul {background-color:#222;color:white;border:3px solid #08a;padding:20px 60px} li:nth-child(2) {background-color:#753}', '# Solid list\n\n- Editable white first\n- Editable white second'),
  'audit-marker':styled('li::marker {content:"✓ ";color:#008000;font-family:Arial;font-size:40px}', '# Custom native marker\n\n- Editable first\n- Editable second'),
  'audit-marker-alpha':styled('li::marker {content:"✓ ";color:rgba(255,0,0,.5);font-family:Arial;font-size:24px}', '# Alpha marker\n\n- Editable first'),
  'audit-marker-complex':styled('li::marker {content:"OK ";color:red}', '# Complex marker\n\n- Raster list'),
  'audit-marker-image':styled('li::marker {content:url("./picture.png")}', '# Image marker\n\n- Raster list'),
  'audit-marker-list-none':styled('ul {list-style-type:none} li::marker {content:"✓ ";color:#008000;font-family:Arial;font-size:40px}', '# Custom marker over none\n\n- Editable first'),
  'audit-marker-none':styled('li::marker {content:none}', '# No marker\n\n- Editable without bullet'),
  'audit-marker-default-style':styled('li::marker {color:#008000;font-family:Arial;font-size:40px}', '# Styled default marker\n\n1. Editable number\n2. Editable number'),
  'audit-decorations':styled('ul {background:linear-gradient(#222,#666);color:white;border-radius:0 30px;outline:3px dashed #f00} li {box-shadow:5px 5px 2px #555}', '# Decorated native list\n\n- Editable first\n- Editable second'),
  'audit-cell-decoration':styled('thead {background:#222;color:white} tbody {background:#ddd} td {background:linear-gradient(#afa,#8d8);border-radius:12px}', '# Editable decorated table\n\n| A | B |\n| - | - |\n| One | Two |'),
  'audit-inline-decoration':styled('mark,strong {background:linear-gradient(#ff0,#fa0);border-radius:8px;outline:2px solid #0a0}', '# Inline decoration\n\nBody **editable emphasized** body.'),
  'audit-first-letter':styled('p::first-letter {font-size:80px;color:red}', '# First letter\n\nLarge initial letter.'),
  'audit-first-line':styled('p::first-line {color:red;font-weight:bold}', '# First line\n\nStyled first line of text.'),
  'audit-columns':styled('ul {column-count:2}', '# Columns\n\n- First\n- Second\n- Third\n- Fourth'),
  'audit-overflow':styled('p {height:25px;overflow:hidden}', '# Clip\n\n'+'Long clipped text that wraps across several lines because the width is limited. '.repeat(2)),
  'audit-clamp':styled('p {display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden}', '# Clamp\n\n'+'Long clamped text '.repeat(40)),
  'audit-float':styled('strong {float:right}', '# Float\n\nText **floating text** around.'),
  'audit-position':styled('strong {position:absolute;left:400px;top:200px}', '# Positioned inline\n\nText **positioned text** around.'),
  'audit-stacking':styled('p {position:absolute;top:260px;background:#222;color:white} p:first-of-type {z-index:2}', '# Layering\n\nTop paragraph\n\nBack paragraph'),
  'audit-blending':styled('strong {mix-blend-mode:multiply;color:red}', '# Blending\n\nText **blended text** around.'),
  'audit-approximation':styled('p {letter-spacing:.5px}', '# Approximation\n\nEditable slightly spaced text'),
  'audit-inline-margin':styled('strong {margin-left:60px}', '# Margin\n\nText **offset** around.'),
  'audit-table-spacing':styled('table {border-collapse:separate;border-spacing:20px}', '# Spaced cells\n\n| A | B |\n| - | - |\n| One | Two |'),
  'audit-pseudo-stack':styled('p::before {content:"Top decoration";position:absolute;z-index:2;background:#fc0}', '# Pseudo stacking\n\nBody text'),
  'audit-hidden':styled('li:first-child {display:none} strong {visibility:hidden}', '# Hidden\n\n- HIDDEN_ITEM\n- Visible item\n\nBody **HIDDEN_INLINE** end.'),
}
const summary=[]
try {
 console.log(JSON.stringify({outputDir}))
 await evaluate("import('/src/export/pptx/devHarness.ts').then(()=>true)")
 await evaluate(`import('/node_modules/@tauri-apps/api/core.js').then(m=>m.invoke('open_file',{path:${JSON.stringify(join(baseDir,'default.md'))}}))`)
 const all=[...Object.entries(cases)]
 if(!process.argv.includes('--audit-only')) {
  for(const file of await readdir(baseDir)) if(file.endsWith('.md')) all.push([file.slice(0,-3),await readFile(join(baseDir,file),'utf8')])
  all.push(...Object.entries(regressionCases).map(([name,md])=>[`review-${name}`,md]))
 }
 for(const [name,md] of all) {
  const result=await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.exportFixtureForCDP(${JSON.stringify(md)},${JSON.stringify(baseDir)}))`)
  const {base64,...model}=result,bytes=Buffer.from(base64,'base64')
  await writeFile(join(outputDir,`${name}.pptx`),bytes);await writeFile(join(outputDir,`${name}.json`),JSON.stringify(model,null,2))
  assert.equal(model.report.errors?.length??0,name==='review-failed-element'?1:0,`${name}: unexpected export error`)
  const first=model.slides[0], native=first.parts.filter(p=>['text','list','table'].includes(p.kind))
  if(['audit-solid-list','audit-marker','audit-marker-alpha','audit-marker-none','audit-marker-default-style','audit-decorations'].includes(name)) assert.ok(first.parts.some(p=>p.kind==='list'),`${name}: editable list missing`)
  if(name==='default') {const code=model.slides[2].parts.find(p=>p.kind==='text'&&p.paragraph.runs.some(r=>r.text==='const'));assert.ok(code,'Syntax-highlighted code must remain native');assert.ok(code.paragraph.runs.some(r=>r.style.color==='CF222E'),'Code syntax color must survive')}
  if(name==='audit-solid-list') {assert.ok(first.parts.some(p=>p.kind==='box'&&p.fill.color==='222222'));assert.equal(model.report.rasterizedElements.length,0)}
  if(name==='audit-cell-decoration') assert.ok(first.parts.some(p=>p.kind==='table'),'table editability')
  if(name==='audit-inline-decoration') assert.ok(native.length>=2,'inline decoration must preserve editable text')
  if(/^audit-(first-letter|first-line|columns|overflow|clamp|float|position|marker-complex|marker-image|stacking|blending|inline-margin|table-spacing|pseudo-stack)$/.test(name)) assert.ok(model.report.rasterizedElements.length>0,`${name}: missing fallback reason`)
  if(name==='audit-approximation') assert.ok(model.report.approximatedElements.some(p=>p.property==='letter-spacing'))
  if(name==='audit-hidden') assert.ok(!JSON.stringify(model.slides).includes('HIDDEN_'))
  if(/^review-native-(default|gaia|uncover)-theme$/.test(name)) for(const slide of model.slides) assert.ok(slide.parts.some(p=>p.kind==='text'),`${name}: native heading regression`)
  const zip=await JSZip.loadAsync(bytes),xml=await zip.file('ppt/slides/slide1.xml').async('string')
  if(['audit-marker','audit-marker-alpha'].includes(name)) {assert.ok(xml.includes('char="&#x2713;"'));assert.ok(xml.includes('<a:buFont typeface="Arial"/>'));assert.ok(xml.includes(name==='audit-marker'?'<a:buSzPts val="3000"/>':'<a:buSzPts val="1800"/>'))}
  for(let i=0;i<model.slides.length;i++) {
   const viewport=await evaluate(`import('/src/export/pptx/devHarness.ts').then(m=>m.showFixtureForCDP(${JSON.stringify(md)},${JSON.stringify(baseDir)},${i}))`)
   await command('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:false})
   const shot=await command('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:viewport.width,height:viewport.height,scale:1}})
   await writeFile(join(outputDir,`${name}-${i+1}-webview2.png`),Buffer.from(shot.data,'base64'))
   await evaluate("import('/src/export/pptx/devHarness.ts').then(m=>m.hideFixtureForCDP())")
  }
  const record={name,slides:model.slides.length,native:first.parts.map(p=>p.kind),report:model.report};summary.push(record)
  console.log(JSON.stringify(record))
 }
 await writeFile(join(outputDir,'summary.json'),JSON.stringify(summary,null,2))
} finally {
 await command('Emulation.clearDeviceMetricsOverride').catch(()=>{})
 await evaluate("import('/src/export/pptx/devHarness.ts').then(m=>m.hideFixtureForCDP())").catch(()=>{})
 await evaluate("import('/node_modules/@tauri-apps/api/core.js').then(m=>m.invoke('stop_watching'))").catch(()=>{})
 socket.close()
}
