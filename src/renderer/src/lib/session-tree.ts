import type { AgentMessage, PiTreeNode, PiTreeResult } from '../../../shared/pi-types'
import { collapseWhitespace } from '../../../shared/text'

/** One line of the session tree, ready to render. */
export interface TreeRow {
  id: string
  /** Indent level: grows only where the conversation branches. */
  depth: number
  /** user / assistant / toolResult, or the entry type (compaction, model_change…). */
  role: string
  snippet: string
  /** On the branch pi is on now (root to leaf). */
  active: boolean
  leaf: boolean
  /** The first entry of a branch next to others (a fork happened above). */
  branchStart: boolean
  /** A user message: "fork from here" makes sense. */
  forkable: boolean
}

export function messageSnippet(message: AgentMessage | undefined, max = 90): string {
  if (!message) {
    return ''
  }
  const content = 'content' in message ? message.content : undefined
  if (typeof content === 'string') {
    return collapseWhitespace(content).slice(0, max)
  }
  if (Array.isArray(content)) {
    const text = content.find((c) => c.type === 'text')
    if (text && 'text' in text) {
      return collapseWhitespace(text.text).slice(0, max)
    }
    const call = content.find((c) => c.type === 'toolCall')
    if (call && 'name' in call) {
      return `→ ${String(call.name)}`
    }
    const thinking = content.find((c) => c.type === 'thinking')
    if (thinking && 'thinking' in thinking) {
      return collapseWhitespace(thinking.thinking).slice(0, max)
    }
    return `[${content.map((c) => c.type).join(', ')}]`
  }
  return ''
}

/**
 * Flatten pi's session tree for a list. A linear conversation stays flat
 * (indenting every message would push a long chat off the screen); only
 * branches indent, and the branch pi is on is marked.
 */
export function flattenSessionTree(result: PiTreeResult): TreeRow[] {
  const parents = new Map<string, string | null>()
  const pending: { node: PiTreeNode; parent: string | null }[] = result.tree.map((node) => ({
    node,
    parent: null
  }))
  while (pending.length > 0) {
    const { node, parent } = pending.pop()!
    parents.set(node.entry.id, parent)
    for (const child of node.children) {
      pending.push({ node: child, parent: node.entry.id })
    }
  }
  const active = new Set<string>()
  for (let id = result.leafId; id; id = parents.get(id) ?? null) {
    active.add(id)
  }

  const rows: TreeRow[] = []
  // Iterative: sessions can be thousands of entries deep.
  const stack: { node: PiTreeNode; depth: number; branchStart: boolean }[] = []
  const push = (nodes: PiTreeNode[], depth: number): void => {
    const branched = nodes.length > 1
    // The active branch first, then the others; reversed onto the stack.
    const ordered = [...nodes].sort((a, b) => Number(active.has(b.entry.id)) - Number(active.has(a.entry.id)))
    for (let i = ordered.length - 1; i >= 0; i--) {
      stack.push({ node: ordered[i]!, depth: branched ? depth + 1 : depth, branchStart: branched })
    }
  }
  push(result.tree, -1)
  while (stack.length > 0) {
    const { node, depth, branchStart } = stack.pop()!
    const { entry } = node
    const role = entry.message?.role ?? entry.type
    rows.push({
      id: entry.id,
      depth: Math.max(depth, 0),
      role,
      snippet: collapseWhitespace(node.label ?? entry.label ?? messageSnippet(entry.message)) || entry.type,
      active: active.has(entry.id),
      leaf: entry.id === result.leafId,
      branchStart,
      forkable: role === 'user'
    })
    push(node.children, Math.max(depth, 0))
  }
  return rows
}
