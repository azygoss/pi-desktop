export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…'
}
