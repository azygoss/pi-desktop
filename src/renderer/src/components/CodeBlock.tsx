import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const htmlCache = new Map<string, Promise<string>>()

function highlight(code: string, lang: string): Promise<string> {
  const key = `${lang} ${code}`
  let cached = htmlCache.get(key)
  if (!cached) {
    cached = import('shiki')
      .then((shiki) =>
        shiki.codeToHtml(code, {
          lang,
          themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
          defaultColor: false
        })
      )
      .catch(() => '')
    htmlCache.set(key, cached)
    if (htmlCache.size > 500) {
      const first = htmlCache.keys().next().value
      if (first !== undefined) {
        htmlCache.delete(first)
      }
    }
  }
  return cached
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lang = language && /^[a-zA-Z0-9#+-]+$/.test(language) ? language : 'text'
  const cacheKey = `${lang} ${code}`
  const [htmlState, setHtmlState] = useState<{ key: string; html: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  const html = htmlState?.key === cacheKey ? htmlState.html : ''

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void highlight(code, lang).then((out) => {
      if (!cancelled && mounted.current && out) {
        setHtmlState({ key: `${lang} ${code}`, html: out })
      }
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-lang">{lang}</span>
        <button type="button" className="code-copy" onClick={() => void copy()}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {html ? (
        <div className="code-block-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-block-body">
          <code dangerouslySetInnerHTML={{ __html: escapeHtml(code) }} />
        </pre>
      )}
    </div>
  )
}
