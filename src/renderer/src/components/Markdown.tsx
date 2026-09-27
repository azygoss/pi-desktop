import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { CodeBlock } from './CodeBlock'

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
          <a href={props.href} target="_blank" rel="noreferrer noopener">
            {props.children}
          </a>
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
