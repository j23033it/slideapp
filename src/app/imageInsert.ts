import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { DocumentModel } from '../document'
import { applyElementTransaction } from '../editing/elements'
import type { EditingEngine } from '../editing'
import { strings } from './strings'

export function imageLine(path: string, naturalWidth: number, naturalHeight: number, slideWidth: number, slideHeight: number): string {
  if (![naturalWidth, naturalHeight, slideWidth, slideHeight].every(n => Number.isFinite(n) && n > 0)) throw new Error('image-copy-failed')
  const scale = Math.min(1, slideWidth * .8 / naturalWidth, slideHeight * .6 / naturalHeight)
  return `![${scale < 1 ? `w:${Math.max(1, Math.floor(naturalWidth * scale))}` : ''}](${path})`
}

/** The caller must finish editing and check document state again after this async operation. */
export async function chooseImage(mdPath: string, toAssetUrl: (absolutePath: string) => string): Promise<{ path: string; width: number; height: number } | null> {
  const sourcePath = await open({ multiple: false, filters: [{ name: strings.fileDialog.imageFilter, extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] })
  if (!sourcePath) return null
  if (!/\.(png|jpe?g|gif|webp)$/i.test(sourcePath)) throw new Error('image-unsupported-type')
  const path = await invoke<string>('import_image', { mdPath, sourcePath })
  const directory = mdPath.slice(0, Math.max(mdPath.lastIndexOf('\\'), mdPath.lastIndexOf('/')))
  const { resolveAssetPath } = await import('../marp/urls')
  const absolute = resolveAssetPath(directory, path)
  if (!absolute) throw new Error('image-copy-failed')
  const image = new Image()
  image.src = toAssetUrl(absolute)
  await image.decode()
  return { path, width: image.naturalWidth, height: image.naturalHeight }
}

export function insertImage(model: DocumentModel, engine: EditingEngine, slide: number, line: string, anchor?: string, readonly = false) {
  return applyElementTransaction(model, engine, { kind: 'insert', slide, anchor: anchor ? { elementId: anchor, side: 'after' } : undefined, lines: [line], expectedKinds: ['image'] }, { readonly })
}
