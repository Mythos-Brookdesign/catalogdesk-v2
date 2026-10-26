import { useCallback, useEffect, useRef, useState } from 'react'
import type { PendingMedia, ProductImage } from '../../types/desktop'
import { useNotify } from '../../components/notifications/notifications'

export type PendingMap = Map<number, PendingMedia>

// Uploads that wait for the shop, by their (negative) ID, so editors can show their preview.
export function usePendingMedia() {
  const desktop = window.catalogDesk
  const [pending, setPending] = useState<PendingMap>(new Map())
  const [version, setVersion] = useState(0)
  // Reloaded when a sync finished (uploads done or failed).
  useEffect(() => {
    const bump = () => setVersion((value) => value + 1)
    const stops = [desktop?.onMediaChanged(bump), desktop?.onProductsChanged(bump)]
    return () => { for (const stop of stops) stop?.() }
  }, [desktop])
  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    desktop.listPendingMedia().then((result) => {
      if (!cancelled && result.ok) setPending(new Map(result.value.map((entry) => [entry.id, entry])))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [desktop, version])
  const add = useCallback((entry: PendingMedia) => setPending((current) => new Map(current).set(entry.id, entry)), [])
  return { pending, add }
}

// Thumbnail from the local media library (cached on disk, also offline); `src` is the fallback.
export const mediaThumb = (id: number) => `catalog-media://thumb/${id}`
export const imageSource = (image: Pick<ProductImage, 'id' | 'src'>, pending: PendingMap) =>
  image.id < 0 ? pending.get(image.id)?.thumbnail ?? '' : image.src

// Product images as stored in the payload (WooCommerce format), reduced to what the editor changes.
export const toProductImage = (value: unknown): ProductImage | null => {
  if (!value || typeof value !== 'object') return null
  const image = value as Record<string, unknown>
  const id = Number(image.id)
  if (!Number.isSafeInteger(id) || id === 0) return null
  const text = (entry: unknown) => (typeof entry === 'string' ? entry : '')
  return { id, src: text(image.src), name: text(image.name), alt: text(image.alt) }
}

export const acceptedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

// Queues image files for upload (file dialog or drag and drop); returns the queued images in their order.
export function useImageUpload(onAdded: (entry: PendingMedia) => void) {
  const desktop = window.catalogDesk
  const notify = useNotify()
  const [uploading, setUploading] = useState(0)
  const upload = useCallback(async (files: File[]): Promise<ProductImage[]> => {
    if (!desktop || !files.length) return []
    const images = files.filter((file) => acceptedImageTypes.includes(file.type))
    const skipped = files.length - images.length
    if (skipped) notify.warning(skipped === 1 ? 'Datei uebersprungen' : `${skipped} Dateien uebersprungen`, { message: 'Nur Bilder im Format JPG, PNG, GIF oder WebP lassen sich hochladen.' })
    const added: ProductImage[] = []
    setUploading((count) => count + images.length)
    for (const file of images) {
      try {
        const result = await desktop.uploadMedia({ name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) })
        if (!result.ok) throw new Error(result.error)
        onAdded(result.value)
        added.push({ id: result.value.id, src: '', name: result.value.name, alt: '' })
      } catch (reason) {
        notify.error('Bild nicht vorgemerkt', { message: reason instanceof Error ? reason.message : `„${file.name}“ konnte nicht gelesen werden.` })
      } finally { setUploading((count) => count - 1) }
    }
    return added
  }, [desktop, notify, onAdded])
  return { upload, uploading }
}

// Drop target for files from the desktop. Drags inside the page (e.g. reordering images) are ignored.
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)
  const isFileDrag = (event: React.DragEvent) => !disabled && event.dataTransfer.types.includes('Files')
  const reset = () => { depth.current = 0; setActive(false) }
  return {
    active,
    dropProps: {
      onDragEnter: (event: React.DragEvent) => { if (!isFileDrag(event)) return; event.preventDefault(); depth.current++; setActive(true) },
      onDragOver: (event: React.DragEvent) => { if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy' },
      // Counted, because entering a child element fires dragleave on the parent.
      onDragLeave: (event: React.DragEvent) => { if (!isFileDrag(event)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setActive(false) },
      onDrop: (event: React.DragEvent) => {
        if (!isFileDrag(event)) return
        event.preventDefault(); event.stopPropagation(); reset()
        onFiles([...event.dataTransfer.files])
      },
    },
  }
}
