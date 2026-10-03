/**
 * The chat to switch to when cycling (⌃Tab) through the open chats, in the
 * order they were opened. From the home screen the walk starts at either end.
 */
export function nextOpenChat(
  chatIds: readonly string[],
  current: string | null,
  direction: 1 | -1
): string | null {
  if (chatIds.length === 0) {
    return null
  }
  const at = current === null ? -1 : chatIds.indexOf(current)
  if (at === -1) {
    return direction === 1 ? chatIds[0]! : chatIds[chatIds.length - 1]!
  }
  if (chatIds.length === 1) {
    return null
  }
  return chatIds[(at + direction + chatIds.length) % chatIds.length]!
}
