// Pi Desktop bridge extension.
//
// Registers browser_* tools that drive the in-app browser (right panel) via
// the local bridge HTTP server started by the app's main process. The bridge
// URL and a per-chat bearer token are injected by Pi Desktop through env vars;
// outside Pi Desktop this extension registers nothing.
//
// Deliberately dependency-free: `parameters` are plain JSON Schema objects and
// only fetch() is used, so the same file loads under both the installed and
// the bundled pi runtime without needing pi's own node_modules.

const BRIDGE_URL = process.env.PI_DESKTOP_BRIDGE_URL
const BRIDGE_TOKEN = process.env.PI_DESKTOP_BRIDGE_TOKEN

async function callBridge(tool, params) {
  let res
  try {
    res = await fetch(`${BRIDGE_URL}/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${BRIDGE_TOKEN}`
      },
      body: JSON.stringify({ tool, params: params ?? {} })
    })
  } catch (error) {
    throw new Error(
      `Pi Desktop browser bridge unreachable: ${error instanceof Error ? error.message : error}`,
      { cause: error }
    )
  }
  const body = await res.json().catch(() => null)
  if (!res.ok || !body || body.ok !== true) {
    const message = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
    throw new Error(`Pi Desktop browser tool failed: ${message}`)
  }
  return body.result
}

function toResult(result) {
  const content = []
  if (result && result.image && typeof result.image.data === 'string') {
    content.push({
      type: 'image',
      data: result.image.data,
      mimeType: result.image.mimeType || 'image/jpeg'
    })
  }
  content.push({ type: 'text', text: (result && result.text) || 'Done' })
  return { content, details: (result && result.details) || {} }
}

function register(pi, tool) {
  pi.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.schema,
    execute: async (_toolCallId, params) => toResult(await callBridge(tool.name, params))
  })
}

const SHARED_DESCRIPTION =
  "Pi Desktop's built-in browser, visible to the user in the app's right panel."

export default function piDesktopBrowser(pi) {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    return
  }

  register(pi, {
    name: 'browser_open',
    label: 'Browser Open',
    description: `${SHARED_DESCRIPTION} Use it to open and test web apps, e.g. a dev server on http://localhost:5173. Opens the chat's browser tab (creating it if needed), navigates to url and waits for the load. "action" navigates the history instead of opening a URL. Returns the final URL, title and a snapshot of interactive elements.`,
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) or localhost URL to open' },
        action: {
          type: 'string',
          enum: ['back', 'forward', 'reload'],
          description: 'History navigation instead of opening a URL'
        }
      }
    }
  })

  register(pi, {
    name: 'browser_tabs',
    label: 'Browser Tabs',
    description: `${SHARED_DESCRIPTION} List the app's open browser tabs (url, title, whether this chat's agent tab).`,
    schema: { type: 'object', properties: {} }
  })

  register(pi, {
    name: 'browser_close',
    label: 'Browser Close',
    description: `${SHARED_DESCRIPTION} Close this chat's browser tab.`,
    schema: { type: 'object', properties: {} }
  })

  register(pi, {
    name: 'browser_snapshot',
    label: 'Browser Snapshot',
    description: `${SHARED_DESCRIPTION} Return a compact accessibility-tree snapshot of the page. Interactive elements get refs like "e3" that browser_click, browser_type and browser_scroll accept. Refs are invalidated by navigation — snapshot again after the page changes.`,
    schema: { type: 'object', properties: {} }
  })

  register(pi, {
    name: 'browser_click',
    label: 'Browser Click',
    description: `${SHARED_DESCRIPTION} Click an element by its ref from browser_snapshot.`,
    schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref like "e3" from browser_snapshot' }
      },
      required: ['ref']
    }
  })

  register(pi, {
    name: 'browser_type',
    label: 'Browser Type',
    description: `${SHARED_DESCRIPTION} Focus an element by ref and type text into it. "clear" selects and deletes existing content first, "submit" presses Enter afterwards.`,
    schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref like "e3" from browser_snapshot' },
        text: { type: 'string', description: 'Text to insert' },
        clear: { type: 'boolean', description: 'Clear existing content first' },
        submit: { type: 'boolean', description: 'Press Enter after typing' }
      },
      required: ['ref', 'text']
    }
  })

  register(pi, {
    name: 'browser_press',
    label: 'Browser Press',
    description: `${SHARED_DESCRIPTION} Press a key: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character.`,
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name (e.g. "Enter", "Tab", "ArrowDown")' }
      },
      required: ['key']
    }
  })

  register(pi, {
    name: 'browser_scroll',
    label: 'Browser Scroll',
    description: `${SHARED_DESCRIPTION} Scroll the page (direction up/down/left/right, amount in px, default 600) or scroll an element into view by ref.`,
    schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref to scroll into view' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Pixels to scroll (default 600)' }
      }
    }
  })

  register(pi, {
    name: 'browser_screenshot',
    label: 'Browser Screenshot',
    description: `${SHARED_DESCRIPTION} Capture the current page as a JPEG image (fullPage captures the whole document). Returns the image plus a caption.`,
    schema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page' }
      }
    }
  })

  register(pi, {
    name: 'browser_evaluate',
    label: 'Browser Evaluate',
    description: `${SHARED_DESCRIPTION} Evaluate a JavaScript expression in the page (awaited, JSON result, 10s timeout). Use for DOM reads, not for actions covered by the other tools.`,
    schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate' }
      },
      required: ['expression']
    }
  })

  register(pi, {
    name: 'browser_console',
    label: 'Browser Console',
    description: `${SHARED_DESCRIPTION} Return console messages, uncaught exceptions and failed network requests buffered since the last call.`,
    schema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Also clear the buffer (buffers are always drained)' }
      }
    }
  })

  register(pi, {
    name: 'browser_wait',
    label: 'Browser Wait',
    description: `${SHARED_DESCRIPTION} Wait for a number of milliseconds, or until text appears on the page (polls, timeoutMs default 15000).`,
    schema: {
      type: 'object',
      properties: {
        ms: { type: 'number', description: 'Milliseconds to wait' },
        text: { type: 'string', description: 'Text to wait for on the page' },
        timeoutMs: { type: 'number', description: 'Max wait for text (default 15000)' }
      }
    }
  })
}
