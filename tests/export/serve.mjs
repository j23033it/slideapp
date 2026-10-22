// Development verification server: writes actual browser exports only to a temp directory.
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const outputDir = await mkdtemp(join(tmpdir(), 'slideapp-pptx-'))
const server = await createServer({ cacheDir: join(outputDir, '.vite'), server: { host: '127.0.0.1', port: 1422, strictPort: true }, plugins: [{ name: 'export-artifacts', configureServer(server) {
server.middlewares.use('/__export_info', (_request, response) => {
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ outputDir, baseDir: join(process.cwd(), 'tests/fixtures/export') }))
})
server.middlewares.use('/__export_artifact', async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    const name = basename(url.searchParams.get('name') ?? '')
    if (!/^[\w-]+\.(pptx|json|png)$/.test(name) || request.method !== 'POST') { response.statusCode = 400; response.end(); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    await writeFile(join(outputDir, name), Buffer.concat(chunks))
    response.end('ok')
  } catch (error) { response.statusCode = 500; response.end(String(error)) }
})
} }] })
await server.listen()
console.log(JSON.stringify({ url: 'http://127.0.0.1:1422', outputDir }))
