import * as Clipboard from 'expo-clipboard'
import { Copy } from 'lucide-react-native'
import { memo, useMemo, type ReactNode } from 'react'
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native'

import { splitMarkdownBlocks } from '../desktop'
import { inlineText, parseMarkdown, type Block, type Inline } from '../lib/markdown'
import { fonts, makeStyles, radius, space, type Theme } from '../theme'
import { IconButton, toast } from '../ui'

const useStyles = makeStyles((t: Theme) => ({
  paragraph: { color: t.text, fontSize: 16, lineHeight: 24 },
  gap: { marginTop: space.md },
  h1: { color: t.text, fontSize: 21, lineHeight: 28, fontWeight: '600' },
  h2: { color: t.text, fontSize: 18, lineHeight: 26, fontWeight: '600' },
  h3: { color: t.text, fontSize: 16, lineHeight: 24, fontWeight: '600' },
  strong: { fontWeight: '600' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through', color: t.muted },
  link: { color: t.accent, textDecorationLine: 'underline' },
  inlineCode: {
    fontFamily: fonts.mono,
    fontSize: 14,
    backgroundColor: t.codeBg,
    color: t.text
  },
  codeBox: {
    backgroundColor: t.codeBg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.border,
    overflow: 'hidden'
  },
  codeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: space.md,
    minHeight: 36,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: t.border
  },
  codeLang: { fontFamily: fonts.mono, fontSize: 12, color: t.muted },
  codeText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 19,
    color: t.text,
    padding: space.md
  },
  quote: { borderLeftWidth: 2, borderLeftColor: t.borderStrong, paddingLeft: space.md },
  listRow: { flexDirection: 'row', gap: space.sm },
  bullet: { color: t.muted, fontSize: 16, lineHeight: 24, minWidth: 18, textAlign: 'right' },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: t.borderStrong },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: t.borderStrong, borderRadius: radius.sm },
  tableRow: { flexDirection: 'row' },
  tableCell: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: t.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.border
  },
  tableHead: { fontWeight: '600' }
}))

type Styles = ReturnType<typeof useStyles>

function openLink(href: string): void {
  if (/^https?:\/\//.test(href)) {
    void Linking.openURL(href).catch(() => toast('Could not open the link'))
  }
}

function renderInline(nodes: Inline[], styles: Styles, keyPrefix = ''): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`
    switch (node.type) {
      case 'text':
        return node.text
      case 'br':
        return '\n'
      case 'code':
        return (
          <Text key={key} style={styles.inlineCode}>
            {node.text}
          </Text>
        )
      case 'strong':
        return (
          <Text key={key} style={styles.strong}>
            {renderInline(node.children, styles, `${key}.`)}
          </Text>
        )
      case 'em':
        return (
          <Text key={key} style={styles.em}>
            {renderInline(node.children, styles, `${key}.`)}
          </Text>
        )
      case 'del':
        return (
          <Text key={key} style={styles.del}>
            {renderInline(node.children, styles, `${key}.`)}
          </Text>
        )
      case 'link':
        return (
          <Text
            key={key}
            style={styles.link}
            accessibilityRole="link"
            onPress={() => openLink(node.href)}
          >
            {renderInline(node.children, styles, `${key}.`)}
          </Text>
        )
    }
  })
}

/** A fenced code block: scrolls sideways instead of wrapping, with a copy button. */
export const CodeBlock = memo(function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const styles = useStyles()
  return (
    <View style={styles.codeBox}>
      <View style={styles.codeHead}>
        <Text style={styles.codeLang}>{lang || 'text'}</Text>
        <IconButton
          icon={Copy}
          label="Copy code"
          size={15}
          tone="muted"
          style={{ width: 44, height: 36 }}
          onPress={() => {
            void Clipboard.setStringAsync(text)
            toast('Copied')
          }}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeText} selectable>
          {text}
        </Text>
      </ScrollView>
    </View>
  )
})

function renderBlocks(blocks: Block[], styles: Styles, selectable: boolean): ReactNode[] {
  return blocks.map((block, index) => {
    const gap = index > 0 ? styles.gap : null
    switch (block.type) {
      case 'paragraph':
        return (
          <Text key={index} style={[styles.paragraph, gap]} selectable={selectable}>
            {renderInline(block.inline, styles)}
          </Text>
        )
      case 'heading':
        return (
          <Text
            key={index}
            accessibilityRole="header"
            style={[block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3, gap]}
            selectable={selectable}
          >
            {renderInline(block.inline, styles)}
          </Text>
        )
      case 'code':
        return (
          <View key={index} style={gap}>
            <CodeBlock text={block.text} lang={block.lang} />
          </View>
        )
      case 'quote':
        return (
          <View key={index} style={[styles.quote, gap]}>
            {renderBlocks(block.blocks, styles, selectable)}
          </View>
        )
      case 'hr':
        return <View key={index} style={[styles.hr, gap]} />
      case 'list':
        return (
          <View key={index} style={[gap, { gap: space.xs }]}>
            {block.items.map((item, i) => (
              <View key={i} style={styles.listRow}>
                <Text style={styles.bullet}>
                  {item.checked !== undefined
                    ? item.checked
                      ? '☑'
                      : '☐'
                    : block.ordered
                      ? `${block.start + i}.`
                      : '•'}
                </Text>
                <View style={{ flex: 1 }}>{renderBlocks(item.blocks, styles, selectable)}</View>
              </View>
            ))}
          </View>
        )
      case 'table': {
        // One width per column (rows lay out on their own, so cells would
        // otherwise disagree): sized by the longest cell, within limits.
        const widths = block.header.map((cell, c) => {
          let longest = inlineText(cell).length
          for (const row of block.rows) {
            longest = Math.max(longest, inlineText(row[c] ?? []).length)
          }
          return Math.min(260, Math.max(80, longest * 8.5 + 28))
        })
        return (
          <ScrollView key={index} horizontal style={gap} showsHorizontalScrollIndicator={false}>
            <View style={styles.table}>
              <View style={styles.tableRow}>
                {block.header.map((cell, c) => (
                  <View key={c} style={[styles.tableCell, { borderTopWidth: 0, width: widths[c] }]}>
                    <Text style={[styles.paragraph, styles.tableHead, { fontSize: 14, lineHeight: 20 }]}>
                      {renderInline(cell, styles)}
                    </Text>
                  </View>
                ))}
              </View>
              {block.rows.map((row, r) => (
                <View key={r} style={styles.tableRow}>
                  {row.map((cell, c) => (
                    <View key={c} style={[styles.tableCell, { width: widths[c] }]}>
                      <Text style={[styles.paragraph, { fontSize: 14, lineHeight: 20 }]}>
                        {renderInline(cell, styles)}
                      </Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        )
      }
    }
  })
}

/** One top-level chunk: parsed once per distinct string. */
const Chunk = memo(function Chunk({ text, selectable }: { text: string; selectable: boolean }) {
  const styles = useStyles()
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <>{renderBlocks(blocks, styles, selectable)}</>
})

/**
 * Markdown as native text. The source is split into top-level chunks that
 * render the same on their own, so a streaming reply re-parses only its
 * last, growing chunk — the earlier ones keep their string and hit the memo.
 */
export const Markdown = memo(function Markdown({
  text,
  selectable = true
}: {
  text: string
  selectable?: boolean
}) {
  const chunks = useMemo(() => splitMarkdownBlocks(text), [text])
  return (
    <View style={{ gap: space.md }}>
      {chunks.map((chunk, index) => (
        <View key={index}>
          <Chunk text={chunk} selectable={selectable} />
        </View>
      ))}
    </View>
  )
})
