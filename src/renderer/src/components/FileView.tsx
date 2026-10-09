import { FolderOpen, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { FileReadResult } from '../../../shared/api'
import { ipcErrorMessage } from '../../../shared/ipc-error'
import { CodeBlock } from './CodeBlock'

/** Above this size the file renders plain: highlighting it would stall. */
const HIGHLIGHT_MAX_CHARS = 200_000

const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json',
  md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java', kt: 'kotlin', cs: 'csharp',
  php: 'php', sh: 'bash', zsh: 'bash', bash: 'bash', css: 'css', scss: 'scss',
  html: 'html', vue: 'vue', svelte: 'svelte', sql: 'sql', lua: 'lua', yml: 'yaml',
  yaml: 'yaml', toml: 'toml', xml: 'xml'
}

export function languageForPath(path: string): string {
  const name = path.split('/').pop() ?? ''
  if (name === 'Dockerfile') {
    return 'docker'
  }
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return LANG_BY_EXT[ext] ?? 'text'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Read-only view of a project file in the side panel: what pi read or
 * changed, without leaving the app. Reloads on demand and when the tab is
 * shown again.
 */
export function FileView({ cwd, path, active }: { cwd: string; path: string; active: boolean }) {
  const [file, setFile] = useState<FileReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.piDesktop.files
      .read({ cwd, path })
      .then((result) => {
        setFile(result)
        setError(null)
      })
      .catch((e: unknown) => {
        setError(ipcErrorMessage(e))
      })
  }, [cwd, path])

  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [active, load])

  return (
    <div className="file-view" data-testid="file-view">
      <div className="diff-toolbar">
        <span className="diff-summary" title={file?.path ?? path}>
          {file ? `${file.relativePath} · ${formatBytes(file.size)}` : path}
        </span>
        <span className="file-view-actions">
          {file && (
            <button
              type="button"
              className="icon-btn"
              title="Reveal in Finder"
              onClick={() => void window.piDesktop.app.revealPath(file.path).catch(() => {})}
            >
              <FolderOpen size={13} />
            </button>
          )}
          <button type="button" className="icon-btn" title="Reload file" onClick={load}>
            <RefreshCw size={13} />
          </button>
        </span>
      </div>
      <div className="file-view-body">
        {error && <div className="panel-empty">{error}</div>}
        {!error && file?.binary && <div className="panel-empty">Binary file — not shown.</div>}
        {!error && file && !file.binary && (
          <>
            {file.content.length <= HIGHLIGHT_MAX_CHARS ? (
              <CodeBlock code={file.content.replace(/\n$/, '')} language={languageForPath(file.path)} />
            ) : (
              <pre className="tool-output file-view-plain">{file.content}</pre>
            )}
            {file.truncated && (
              <div className="panel-empty">Showing the first 512 KB of this file.</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
