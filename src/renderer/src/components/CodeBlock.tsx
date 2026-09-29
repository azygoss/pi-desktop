import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

const htmlCache = new Map<string, Promise<string>>()
/** Settled highlights, readable synchronously so a remount paints colored. */
const resolvedCache = new Map<string, string>()

type Highlighter = Awaited<ReturnType<typeof import('shiki')['createHighlighter']>>

let highlighterPromise: Promise<Highlighter> | null = null

/**
 * One shared highlighter on shiki's JavaScript regex engine. The default
 * Oniguruma engine compiles WebAssembly, which the renderer CSP
 * (script-src 'self') forbids — every highlight used to fail silently and
 * code blocks rendered plain. Grammars load on first use per language.
 */
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= import('shiki').then((shiki) =>
    shiki.createHighlighter({
      themes: ['vitesse-light', 'vitesse-dark'],
      langs: [],
      engine: shiki.createJavaScriptRegexEngine()
    })
  )
  return highlighterPromise
}

async function renderHtml(code: string, lang: string): Promise<string> {
  const [shiki, highlighter] = await Promise.all([import('shiki'), getHighlighter()])
  let language = lang.toLowerCase()
  if (!highlighter.getLoadedLanguages().includes(language)) {
    if (language in shiki.bundledLanguages) {
      await highlighter.loadLanguage(language as keyof typeof shiki.bundledLanguages)
    } else {
      language = 'text'
    }
  }
  return highlighter.codeToHtml(code, {
    lang: language,
    themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
    defaultColor: false
  })
}

function highlight(code: string, lang: string): Promise<string> {
  const key = `${lang} ${code}`
  let cached = htmlCache.get(key)
  if (!cached) {
    cached = renderHtml(code, lang)
      .catch(() => '')
      .then((html) => {
        if (html && htmlCache.has(key)) {
          resolvedCache.set(key, html)
        }
        return html
      })
    htmlCache.set(key, cached)
    if (htmlCache.size > 300) {
      const first = htmlCache.keys().next().value
      if (first !== undefined) {
        htmlCache.delete(first)
        resolvedCache.delete(first)
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

/** Minimum gap between highlight passes while a block is still growing. */
const HIGHLIGHT_INTERVAL_MS = 300

/**
 * Shiki HTML for `prev` with the not-yet-highlighted tail of `code` appended
 * as plain text, so a streaming block keeps its colors instead of flashing
 * back to plain on every delta.
 */
function withPlainTail(prev: { code: string; html: string }, code: string): string {
  const close = prev.html.lastIndexOf('</code></pre>')
  if (close === -1) {
    return ''
  }
  const tail = escapeHtml(code.slice(prev.code.length))
  return prev.html.slice(0, close) + tail + prev.html.slice(close)
}

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lang = language && /^[a-zA-Z0-9#+-]+$/.test(language) ? language : 'text'
  const [highlighted, setHighlighted] = useState<{
    lang: string
    code: string
    html: string
  } | null>(null)
  const [copied, setCopied] = useState(false)
  const lastRunAt = useRef(0)
  const runSeq = useRef(0)
  const appliedSeq = useRef(0)

  let html = resolvedCache.get(`${lang} ${code}`) ?? ''
  if (!html && highlighted && highlighted.lang === lang) {
    if (highlighted.code === code) {
      html = highlighted.html
    } else if (code.startsWith(highlighted.code)) {
      html = withPlainTail(highlighted, code)
    }
  }

  // While a block streams, `code` changes every frame; highlighting each
  // partial would run shiki ~60x/s. Throttle to one pass per interval — the
  // trailing pass always runs, so the settled block ends fully highlighted.
  // Results are applied newest-wins rather than cancelled on change, or a
  // growing block would never show any colors until it settled.
  useEffect(() => {
    if (resolvedCache.has(`${lang} ${code}`)) {
      return
    }
    const run = () => {
      lastRunAt.current = Date.now()
      const seq = ++runSeq.current
      void highlight(code, lang).then((out) => {
        if (out && seq > appliedSeq.current) {
          appliedSeq.current = seq
          setHighlighted({ lang, code, html: out })
        }
      })
    }
    const wait = HIGHLIGHT_INTERVAL_MS - (Date.now() - lastRunAt.current)
    if (wait <= 0) {
      run()
      return
    }
    const timer = setTimeout(run, wait)
    return () => clearTimeout(timer)
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
