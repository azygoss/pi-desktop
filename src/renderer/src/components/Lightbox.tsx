import { X } from 'lucide-react'
import { useEffect } from 'react'

import { useAppStore } from '../state/app-store'

/**
 * Full-window image viewer for screenshots and attachments. Click anywhere
 * or press Esc to close.
 */
export function Lightbox() {
  const src = useAppStore((s) => s.lightbox)
  useEffect(() => {
    if (!src) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        useAppStore.getState().setLightbox(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [src])
  if (!src) {
    return null
  }
  const close = () => useAppStore.getState().setLightbox(null)
  return (
    <div className="lightbox" role="dialog" aria-label="Image" onClick={close}>
      <img src={src} alt="" />
      <button type="button" className="icon-btn lightbox-close" title="Close (Esc)" onClick={close}>
        <X size={16} />
      </button>
    </div>
  )
}

/** Open an inline image in the lightbox. */
export function zoomImage(mimeType: string, data: string): void {
  useAppStore.getState().setLightbox(`data:${mimeType};base64,${data}`)
}
