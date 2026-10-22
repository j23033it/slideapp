// package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json の版が一致するか検査する。
// 使い方: node scripts/check-version.mjs
// タグを渡すと（node scripts/check-version.mjs v0.2.0）、版とも一致するか検査する。
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** [package] セクションの version を読む（依存クレートの version と取り違えない） */
export function cargoPackageVersion(toml) {
  let inPackage = false

  for (const line of toml.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (section) {
      inPackage = section[1].trim() === 'package'
      continue
    }
    if (!inPackage) continue

    const version = /^\s*version\s*=\s*"([^"]+)"/.exec(line)
    if (version) return version[1]
  }

  return null
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const cargoToml = await readFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
  const tauriConf = JSON.parse(
    await readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  )

  const versions = [
    ['package.json', packageJson.version],
    ['src-tauri/Cargo.toml', cargoPackageVersion(cargoToml)],
    ['src-tauri/tauri.conf.json', tauriConf.version],
  ]

  const missing = versions.filter(([, version]) => typeof version !== 'string' || version === '')
  if (missing.length > 0) {
    console.error(`版を読めませんでした: ${missing.map(([file]) => file).join(', ')}`)
    process.exitCode = 1
    return
  }

  const [file, version] = versions[0]
  const mismatched = versions.filter(([, other]) => other !== version)
  if (mismatched.length > 0) {
    console.error('版が一致していません。3ファイルを同じ値にしてください。')
    for (const [name, value] of versions) {
      console.error(`  ${name}: ${value}`)
    }
    process.exitCode = 1
    return
  }

  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? ''
  if (tag.startsWith('v') && tag.slice(1) !== version) {
    console.error(`タグ ${tag} と版 ${version} が一致しません（${file}）。`)
    process.exitCode = 1
    return
  }

  console.log(`版は一致しています: ${version}${tag ? `（タグ ${tag}）` : ''}`)
}

await main()
