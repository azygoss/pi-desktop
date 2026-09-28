import { create } from 'zustand'

export interface Toast {
  id: number
  text: string
}

interface ToastState {
  toasts: Toast[]
  dismiss(id: number): void
}

let nextId = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  dismiss(id) {
    clearTimeout(timers.get(id))
    timers.delete(id)
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

const TOAST_MS = 3500

/** Brief bottom-center notification. An identical toast already on screen is
 *  kept and its timer refreshed instead of stacking a duplicate. */
export function toast(text: string): void {
  const existing = useToastStore.getState().toasts.find((t) => t.text === text)
  if (existing) {
    scheduleDismiss(existing.id)
    return
  }
  const id = ++nextId
  useToastStore.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text }] }))
  scheduleDismiss(id)
}

function scheduleDismiss(id: number): void {
  clearTimeout(timers.get(id))
  timers.set(
    id,
    setTimeout(() => useToastStore.getState().dismiss(id), TOAST_MS)
  )
}
