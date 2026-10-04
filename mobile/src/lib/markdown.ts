/**
 * A small markdown parser for chat replies: the constructs models actually
 * write (headings, lists, code, quotes, tables, emphasis, links), parsed
 * into a tree the app renders with native text. No dependencies and no
 * regular-expression features beyond what every JS engine has.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' }

export interface ListItem {
  blocks: Block[]
  /** Task list state; undefined for ordinary items. */
  checked?: boolean
}

export type Block =
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'hr' }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const QUOTE = /^ {0,3}>\s?/
const URL_END = /[\s<>]/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) {
    row = row.slice(1)
  }
  if (row.endsWith('|') && !row.endsWith('\\|')) {
    row = row.slice(0, -1)
  }
  const cells: string[] = []
  let cell = ''
  let inCode = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!
    if (ch === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
    } else if (ch === '`') {
      inCode = !inCode
      cell += ch
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell.trim())
  return cells
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-'))
  )
}

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'))
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length) {
        const candidate = lines[i]!.trim()
        if (
          candidate.startsWith(marker[0]!.repeat(marker.length)) &&
          candidate.replace(/[`~]/g, '') === ''
        ) {
          break
        }
        body.push(lines[i]!)
        i++
      }
      i++ // the closing fence (or the end of a reply still streaming)
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, inline: parseInline(heading[2]!) })
      i++
      continue
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && !isBlank(lines[i]!) && (QUOTE.test(lines[i]!) || inner.length > 0)) {
        if (!QUOTE.test(lines[i]!) && startsBlock(lines[i]!, lines[i + 1])) {
          break
        }
        inner.push(lines[i]!.replace(QUOTE, ''))
        i++
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) })
      continue
    }

    const next = lines[i + 1]
    if (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-')) {
      const header = splitRow(line).map(parseInline)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|')) {
        const cells = splitRow(lines[i]!).map(parseInline)
        while (cells.length < header.length) {
          cells.push([])
        }
        rows.push(cells.slice(0, header.length))
        i++
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item) {
      const [list, consumed] = parseList(lines, i)
      blocks.push(list)
      i = consumed
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && !isBlank(lines[i]!)) {
      if (paragraph.length > 0 && (startsBlock(lines[i]!, lines[i + 1]) || LIST_ITEM.test(lines[i]!))) {
        break
      }
      paragraph.push(lines[i]!)
      i++
    }
    blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) })
  }
  return blocks
}

function indentOf(line: string): number {
  let n = 0
  while (n < line.length && line[n] === ' ') {
    n++
  }
  return n
}

function parseList(lines: string[], start: number): [Block, number] {
  const first = LIST_ITEM.exec(lines[start]!)!
  const baseIndent = first[1]!.length
  const ordered = /\d/.test(first[2]!)
  const items: ListItem[] = []
  let i = start
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]!)
    if (!match || match[1]!.length !== baseIndent || /\d/.test(match[2]!) !== ordered) {
      break
    }
    const contentIndent = baseIndent + match[2]!.length + Math.min(Math.max(match[3]!.length, 1), 4)
    const body: string[] = [match[4]!]
    i++
    while (i < lines.length) {
      const line = lines[i]!
      if (isBlank(line)) {
        // A blank line stays in the item only if indented content follows.
        const after = lines[i + 1]
        if (after !== undefined && !isBlank(after) && indentOf(after) >= contentIndent) {
          body.push('')
          i++
          continue
        }
        break
      }
      if (indentOf(line) >= contentIndent) {
        body.push(line.slice(contentIndent))
        i++
        continue
      }
      const sibling = LIST_ITEM.exec(line)
      if (sibling && sibling[1]!.length > baseIndent) {
        body.push(line.slice(Math.min(indentOf(line), contentIndent)))
        i++
        continue
      }
      if (sibling || startsBlock(line, lines[i + 1])) {
        break
      }
      body.push(line.trim()) // lazy continuation of the item's paragraph
      i++
    }
    const listItem: ListItem = { blocks: [] }
    const task = /^\[([ xX])\]\s+/.exec(body[0]!)
    if (task) {
      listItem.checked = task[1] !== ' '
      body[0] = body[0]!.slice(task[0].length)
    }
    listItem.blocks = parseBlocks(body)
    items.push(listItem)
    // Blank lines between items of the same list.
    let peek = i
    while (peek < lines.length && isBlank(lines[peek]!)) {
      peek++
    }
    const nextItem = peek < lines.length ? LIST_ITEM.exec(lines[peek]!) : null
    if (peek > i && nextItem && nextItem[1]!.length === baseIndent && /\d/.test(nextItem[2]!) === ordered) {
      i = peek
    }
  }
  return [{ type: 'list', ordered, start: ordered ? parseInt(first[2]!, 10) || 1 : 1, items }, i]
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch)
}

/** Index of the delimiter that closes one opened at `from`, or -1. */
function findClose(text: string, delimiter: string, from: number): number {
  let i = from
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      i = end === -1 ? i + 1 : end + 1
      continue
    }
    if (text.startsWith(delimiter, i)) {
      const before = text[i - 1]
      const after = text[i + delimiter.length]
      const single = delimiter.length === 1
      if (
        before !== undefined &&
        before !== ' ' &&
        before !== '\n' &&
        !(single && (after === delimiter || before === delimiter)) &&
        !(delimiter === '_' && isWordChar(after))
      ) {
        return i
      }
    }
    i++
  }
  return -1
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer) {
      out.push({ type: 'text', text: buffer })
      buffer = ''
    }
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    if (ch === '\\' && i + 1 < text.length) {
      if (text[i + 1] === '\n') {
        flush()
        out.push({ type: 'br' })
      } else {
        buffer += text[i + 1]
      }
      i += 2
      continue
    }

    if (ch === '`') {
      let run = 1
      while (text[i + run] === '`') {
        run++
      }
      const fence = '`'.repeat(run)
      const end = text.indexOf(fence, i + run)
      if (end !== -1) {
        flush()
        out.push({ type: 'code', text: text.slice(i + run, end).replace(/\n/g, ' ') })
        i = end + run
        continue
      }
      buffer += fence
      i += run
      continue
    }

    if (ch === '\n') {
      if (buffer.endsWith('  ')) {
        buffer = buffer.replace(/ +$/, '')
        flush()
        out.push({ type: 'br' })
      } else {
        buffer += ' '
      }
      i++
      continue
    }

    if (ch === '!' && text[i + 1] === '[') {
      i++ // an image renders as its link
      continue
    }

    if (ch === '[') {
      const close = findBracket(text, i)
      if (close !== -1 && text[close + 1] === '(') {
        const end = text.indexOf(')', close + 2)
        if (end !== -1) {
          const href = text.slice(close + 2, end).trim().split(/\s+/)[0] ?? ''
          flush()
          out.push({ type: 'link', href, children: parseInline(text.slice(i + 1, close)) })
          i = end + 1
          continue
        }
      }
    }

    if (ch === '<') {
      const end = text.indexOf('>', i + 1)
      const inner = end === -1 ? '' : text.slice(i + 1, end)
      if (/^https?:\/\/\S+$/.test(inner)) {
        flush()
        out.push({ type: 'link', href: inner, children: [{ type: 'text', text: inner }] })
        i = end + 1
        continue
      }
    }

    if ((ch === 'h' && text.startsWith('http://', i)) || text.startsWith('https://', i)) {
      if (!isWordChar(text[i - 1])) {
        let end = i
        while (end < text.length && !URL_END.test(text[end]!)) {
          end++
        }
        // Sentence punctuation after a URL is not part of it.
        while (end > i && /[.,;:!?)\]'"]/.test(text[end - 1]!)) {
          end--
        }
        const href = text.slice(i, end)
        if (href.length > 8) {
          flush()
          out.push({ type: 'link', href, children: [{ type: 'text', text: href }] })
          i = end
          continue
        }
      }
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const double = text[i + 1] === ch
      const delimiter = double ? ch + ch : ch
      const opens =
        text[i + delimiter.length] !== undefined &&
        text[i + delimiter.length] !== ' ' &&
        text[i + delimiter.length] !== '\n' &&
        !(ch === '_' && isWordChar(text[i - 1])) &&
        !(ch === '~' && !double)
      if (opens) {
        const close = findClose(text, delimiter, i + delimiter.length + 1)
        if (close !== -1) {
          const children = parseInline(text.slice(i + delimiter.length, close))
          flush()
          out.push(
            ch === '~'
              ? { type: 'del', children }
              : double
                ? { type: 'strong', children }
                : { type: 'em', children }
          )
          i = close + delimiter.length
          continue
        }
      }
      buffer += delimiter
      i += delimiter.length
      continue
    }

    buffer += ch
    i++
  }
  flush()
  return out
}

function findBracket(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\') {
      i++
    } else if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) {
        return i
      }
    } else if (ch === '\n' && text[i + 1] === '\n') {
      return -1
    }
  }
  return -1
}

/** The plain text of inline nodes (accessibility labels, table sizing). */
export function inlineText(nodes: Inline[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'code') {
      out += node.text
    } else if (node.type === 'br') {
      out += '\n'
    } else {
      out += inlineText(node.children)
    }
  }
  return out
}
