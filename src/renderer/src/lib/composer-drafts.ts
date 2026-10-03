import type { ImageContent } from '../../../shared/pi-types'

/** A non-image attachment — sent as an @path reference appended to the text. */
export interface FileChip {
  path: string
  name: string
  size: number
}

export interface ComposerDraft {
  text: string
  images: ImageContent[]
  chips: FileChip[]
}

/**
 * Unsent composer content per chat, so switching chats never loses (or leaks)
 * what was being typed. In memory only: drafts are gone after a restart.
 */
const drafts = new Map<string, ComposerDraft>()
/** Fork seeds already applied per chat (a remount must not re-apply one). */
const appliedSeeds = new Map<string, number>()

export function getComposerDraft(chatId: string | undefined): ComposerDraft | undefined {
  return chatId ? drafts.get(chatId) : undefined
}

export function saveComposerDraft(chatId: string | undefined, draft: ComposerDraft): void {
  if (!chatId) {
    return
  }
  if (!draft.text && draft.images.length === 0 && draft.chips.length === 0) {
    drafts.delete(chatId)
  } else {
    drafts.set(chatId, draft)
  }
}

export function dropComposerDraft(chatId: string): void {
  drafts.delete(chatId)
  appliedSeeds.delete(chatId)
}

export function appliedSeedNonce(chatId: string | undefined): number {
  return chatId ? (appliedSeeds.get(chatId) ?? 0) : 0
}

export function markSeedApplied(chatId: string, nonce: number): void {
  appliedSeeds.set(chatId, nonce)
}
