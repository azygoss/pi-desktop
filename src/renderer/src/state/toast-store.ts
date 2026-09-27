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

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

const TOAST_MS = 3500

/** Brief bottom-center notification. */
export function toast(text: string): void {
  const id = ++nextId
  useToastStore.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text }] }))
  setTimeout(() => useToastStore.getState().dismiss(id), TOAST_MS)
}
