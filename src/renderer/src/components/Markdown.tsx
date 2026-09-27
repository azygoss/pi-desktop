import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { usePanelStore } from '../state/panel-store'
import { CodeBlock } from './CodeBlock'

/**
 * Links open in the in-app browser panel; ⌘/Ctrl-click (or a middle click)
 * goes to the system browser, and non-http(s) links are always external.
 */
function openLink(e: React.MouseEvent<HTMLAnchorElement>, href?: string): void {
  e.preventDefault()
  if (!href) {
    return
  }
  if (e.metaKey || e.ctrlKey || e.button === 1 || !/^https?:\/\//i.test(href)) {
    void window.piDesktop.app.openExternal(href).catch(() => {})
    return
  }
  usePanelStore.getState().openBrowser(href)
}

/**
 * Render assistant markdown; fenced code blocks get shiki highlighting.
 * Memoized on `text`: during a stream only the in-flight block re-parses —
 * finalized blocks keep the same string and skip ReactMarkdown entirely.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const components = useMemo(
    () => ({
      code(props: { className?: string; children?: React.ReactNode }) {
        const { className, children } = props
        const match = /language-([^\s]+)/.exec(className ?? '')
        const raw = String(children ?? '')
        if (match || raw.includes('\n')) {
          return <CodeBlock code={raw.replace(/\n$/, '')} language={match?.[1]} />
        }
        return <code className="inline-code">{raw}</code>
      },
      a(props: { href?: string; children?: React.ReactNode }) {
        return (
          <a
            href={props.href}
            onClick={(e) => openLink(e, props.href)}
            onAuxClick={(e) => openLink(e, props.href)}
          >
            {props.children}
          </a>
        )
      },
      // Wide tables scroll inside a wrapper instead of breaking the column.
      table(props: { children?: React.ReactNode }) {
        return (
          <div className="table-scroll">
            <table>{props.children}</table>
          </div>
        )
      }
    }),
    []
  )

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
