import { systemPreferences } from 'electron'

import type { CuaService } from './cua-service'

/**
 * computer_* tool dispatch: the pi extension's calls arrive over the bridge
 * and are translated into helper commands. Results mirror BrowserToolBridge's
 * shape ({text, image?, details}) so the extension's toResult works for both.
 */

/** Bundle ids the agent must never control — the app itself and dev Electron. */
/** Pi Desktop's own bundle id (electron-builder appId). */
export const APP_BUNDLE_ID = 'io.github.azygoss.pidesktop'

export const SELF_BUNDLE_IDS = new Set([
  APP_BUNDLE_ID,
  'com.github.Electron'
])

const STOP_MESSAGE = 'Computer use stopped by the user'

export interface ComputerToolDeps {
  /** Settings gate — read fresh so a settings change applies immediately. */
  isEnabled(): Promise<boolean>
}

interface HelperAppState {
  app?: { name?: string; bundleId?: string; pid?: number }
  window?: { title?: string; x?: number; y?: number; width?: number; height?: number } | null
  tree?: string
  diff?: boolean
  screenshot?: { jpegBase64?: string; width?: number; height?: number; scale?: number }
  screenshotError?: string
}

interface HelperActionResult {
  app?: string
  element?: { role?: string; label?: string }
  settledMs?: number
  staleId?: boolean
  timings?: {
    resolveMs?: number
    activateMs?: number
    actionMs?: number
    settleMs?: number
    totalMs?: number
  }
}

interface HelperShot {
  jpegBase64?: string
  width?: number
  height?: number
  scale?: number
  window?: string
}

export interface ComputerToolResult {
  text: string
  image?: { data: string; mimeType: string }
  details?: Record<string, unknown>
}

function toolError(message: string): Error {
  return new Error(message)
}

export class ComputerToolBridge {
  /** The system prompt fires at most once per app run. */
  private accessibilityPrompted = false
  /** Positive permission results cached 30s; negatives never cached. */
  private permsCache: { at: number; value: { accessibility: boolean; screenRecording: boolean } } | null =
    null

  constructor(
    private readonly service: CuaService,
    private readonly deps: ComputerToolDeps
  ) {}

  private async gate(app?: string, needsScreen = false): Promise<void> {
    if (!(await this.deps.isEnabled())) {
      throw toolError('Computer use is disabled in Pi Desktop settings')
    }
    if (app) {
      const lower = app.trim().toLowerCase()
      if (
        SELF_BUNDLE_IDS.has(app.trim()) ||
        lower === 'pi desktop' ||
        lower === 'electron'
      ) {
        throw toolError('Pi Desktop cannot control itself')
      }
    }
    const perms = await this.permissions()
    if (perms.accessibility !== true) {
      if (!this.accessibilityPrompted) {
        this.accessibilityPrompted = true
        // Registers Pi Desktop in the Accessibility list so the user can
        // toggle it — the helper itself can't appear there on its own.
        systemPreferences?.isTrustedAccessibilityClient?.(true)
      }
      throw toolError(
        'Accessibility permission is required. Grant it in System Settings → ' +
          'Privacy & Security → Accessibility for Pi Desktop, then retry. If Pi Desktop ' +
          'is already switched on there, the entry belongs to an older build: use ' +
          'Reset permissions in Pi Desktop Settings → Computer use and grant it again.'
      )
    }
    if (needsScreen && perms.screenRecording !== true) {
      throw toolError(
        'Screen Recording permission is required. Grant it in System Settings → ' +
          'Privacy & Security → Screen Recording for Pi Desktop, then retry. If Pi ' +
          'Desktop is already switched on there, use Reset permissions in Pi Desktop ' +
          'Settings → Computer use and grant it again.'
      )
    }
  }

  private async permissions(): Promise<{
    accessibility: boolean
    screenRecording: boolean
  }> {
    if (this.permsCache && Date.now() - this.permsCache.at < 30_000) {
      return this.permsCache.value
    }
    const result = (await this.service.call('permissions', {})) as {
      accessibility?: boolean
      screenRecording?: boolean
    }
    const value = {
      accessibility: result.accessibility === true,
      screenRecording: result.screenRecording === true
    }
    // Only a granted state is trustworthy enough to cache: a denied user may
    // flip the switch in System Settings mid-session and expect it to work,
    // and the next check must come from a fresh helper to see it.
    if (value.accessibility) {
      this.permsCache = { at: Date.now(), value }
    } else {
      this.service.recycle()
    }
    return value
  }

  /** Drop cached permissions (called when a helper command reports one). */
  invalidatePermissions(): void {
    this.permsCache = null
  }

  /**
   * Helper call with permission recovery: a failure that names a permission
   * drops the cache, re-checks, and retries once when the user has since
   * granted access (e.g. just flipped the switch in System Settings).
   */
  private async callHelper(
    cmd: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    try {
      return await this.service.call(cmd, args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/permission/i.test(message)) {
        throw error
      }
      this.invalidatePermissions()
      const perms = await this.permissions()
      if (perms.accessibility) {
        return await this.service.call(cmd, args)
      }
      throw error
    }
  }

  private selfExclusions(): Record<string, unknown> {
    return { excludeBundleIds: [...SELF_BUNDLE_IDS] }
  }

  async call(
    chatId: string,
    tool: string,
    params: Record<string, unknown>
  ): Promise<ComputerToolResult> {
    const app = typeof params['app'] === 'string' ? params['app'] : undefined
    const summary = this.summaryFor(tool, app, params)
    this.service.emitActivity({
      chatId,
      phase: 'start',
      cmd: tool,
      app,
      summary
    })
    try {
      const result = await this.dispatch(chatId, tool, params)
      this.service.emitActivity({ chatId, phase: 'end', cmd: tool, app, summary })
      return result
    } catch (error) {
      this.service.emitActivity({ chatId, phase: 'end', cmd: tool, app, summary })
      throw error
    }
  }

  private async dispatch(
    _chatId: string,
    tool: string,
    params: Record<string, unknown>
  ): Promise<ComputerToolResult> {
    switch (tool) {
      case 'computer_apps': {
        await this.gate()
        const list = await this.callHelper('list_apps', this.selfExclusions())
        const apps = (Array.isArray(list) ? list : []) as {
          name?: string
          bundleId?: string
          running?: boolean
          windows?: string[]
        }[]
        const lines = apps.map(
          (a) =>
            `${a.name ?? '?'} — ${a.bundleId ?? ''}${a.running ? ' (running)' : ''}${
              a.windows?.length ? ` — ${a.windows.join(', ')}` : ''
            }`
        )
        return {
          text: lines.length ? lines.join('\n') : 'No apps found.',
          details: { count: apps.length }
        }
      }

      case 'computer_state': {
        const app = this.requireApp(params)
        await this.gate(app, params['screenshot'] === true)
        const result = (await this.callHelper('app_state', {
          ...this.selfExclusions(),
          app,
          full: params['full'] === true,
          screenshot: params['screenshot'] === true,
          ...(typeof params['query'] === 'string' ? { query: params['query'] } : {})
        })) as HelperAppState
        return this.stateResult(result)
      }

      case 'computer_click': {
        const appName = this.requireApp(params)
        await this.gate(appName)
        const args: Record<string, unknown> = { ...this.selfExclusions(), app: appName }
        if (params['element'] !== undefined) {
          args['element'] = this.requireInt(params['element'], 'element')
        } else {
          args['x'] = this.requireNumber(params['x'], 'x')
          args['y'] = this.requireNumber(params['y'], 'y')
        }
        if (params['button'] !== undefined) {
          args['button'] = this.oneOf(params['button'], ['left', 'right', 'middle'], 'button')
        }
        if (params['count'] !== undefined) {
          args['count'] = this.requireInt(params['count'], 'count')
        }
        const result = (await this.callHelper('click', args)) as HelperActionResult
        return { text: this.actionText('Clicked', result), details: result as never }
      }

      case 'computer_set_value': {
        const appName = this.requireApp(params)
        await this.gate(appName)
        const result = (await this.callHelper('set_value', {
          ...this.selfExclusions(),
          app: appName,
          element: this.requireInt(params['element'], 'element'),
          value: this.requireString(params['value'], 'value')
        })) as HelperActionResult
        return { text: this.actionText('Set value on', result), details: result as never }
      }

      case 'computer_type': {
        const appName = this.requireApp(params)
        await this.gate(appName)
        const text = this.requireString(params['text'], 'text')
        const result = (await this.callHelper('type_text', {
          ...this.selfExclusions(),
          app: appName,
          text,
          submit: params['submit'] === true
        })) as HelperActionResult
        return {
          text: `Typed ${text.length} characters in ${result.app ?? appName}`,
          details: result as never
        }
      }

      case 'computer_key': {
        const appName = this.requireApp(params)
        await this.gate(appName)
        const key = this.requireString(params['key'], 'key')
        const result = (await this.callHelper('press_key', {
          ...this.selfExclusions(),
          app: appName,
          key
        })) as HelperActionResult
        return {
          text: `Pressed ${key} in ${result.app ?? appName}`,
          details: result as never
        }
      }

      case 'computer_scroll': {
        const appName = this.requireApp(params)
        await this.gate(appName)
        const result = (await this.callHelper('scroll', {
          ...this.selfExclusions(),
          app: appName,
          ...(params['element'] !== undefined
            ? { element: this.requireInt(params['element'], 'element') }
            : {}),
          direction: this.oneOf(params['direction'], ['up', 'down', 'left', 'right'], 'direction'),
          ...(params['pages'] !== undefined
            ? { pages: this.requireNumber(params['pages'], 'pages') }
            : {})
        })) as HelperActionResult
        return { text: this.actionText('Scrolled', result), details: result as never }
      }

      case 'computer_drag': {
        const appName = this.requireApp(params)
        await this.gate(appName)
        const args: Record<string, unknown> = { ...this.selfExclusions(), app: appName }
        for (const key of ['fromElement', 'toElement'] as const) {
          if (params[key] !== undefined) {
            args[key] = this.requireInt(params[key], key)
          }
        }
        for (const key of ['fromX', 'fromY', 'toX', 'toY'] as const) {
          if (params[key] !== undefined) {
            args[key] = this.requireNumber(params[key], key)
          }
        }
        if (args['fromElement'] === undefined && args['fromX'] === undefined) {
          throw toolError('computer_drag needs fromElement or fromX+fromY')
        }
        if (args['toElement'] === undefined && args['toX'] === undefined) {
          throw toolError('computer_drag needs toElement or toX+toY')
        }
        const result = (await this.callHelper('drag', args)) as HelperActionResult
        return { text: this.actionText('Dragged', result), details: result as never }
      }

      case 'computer_action': {
        const appName = this.requireApp(params)
        await this.gate(appName)
        const result = (await this.callHelper('secondary_action', {
          ...this.selfExclusions(),
          app: appName,
          element: this.requireInt(params['element'], 'element'),
          action: this.requireString(params['action'], 'action')
        })) as HelperActionResult
        return { text: this.actionText('Performed', result), details: result as never }
      }

      case 'computer_screenshot': {
        const appName =
          typeof params['app'] === 'string' && params['app'] ? params['app'] : undefined
        await this.gate(appName, true)
        const result = (await this.callHelper('screenshot', {
          ...this.selfExclusions(),
          ...(appName ? { app: appName } : {}),
          screen: params['screen'] === true
        })) as HelperShot
        if (typeof result.jpegBase64 !== 'string') {
          throw toolError('screenshot failed')
        }
        const pxPerPt = result.scale ?? 1
        return {
          text:
            `Screenshot${result.window ? ` of "${result.window}"` : ''} ` +
            `(${result.width}x${result.height}, 1 px = ${pxPerPt.toFixed(2)} pt)`,
          image: { data: result.jpegBase64, mimeType: 'image/jpeg' },
          details: result as never
        }
      }

      default:
        // computer_confirm is answered in the extension (ctx.ui.confirm);
        // anything else is unknown.
        throw toolError(`unknown computer tool: ${tool}`)
    }
  }

  private stateResult(result: HelperAppState): ComputerToolResult {
    const app = result.app ?? {}
    const window = result.window ?? null
    const header =
      `App: ${app.name ?? '?'} (${app.bundleId ?? '?'})` +
      (window
        ? ` — window "${window.title ?? ''}" ${window.width}x${window.height}`
        : ' — no window')
    const tree =
      result.tree === '(no changes)' ? '(no changes since last state)' : (result.tree ?? '(empty)')
    let text = `${header}\n${tree}`
    const shot = result.screenshot
    let image: ComputerToolResult['image']
    if (typeof shot?.jpegBase64 === 'string') {
      const pxPerPt = shot.scale ?? 1
      text += `\nScreenshot attached (${shot.width}x${shot.height}, 1 px = ${pxPerPt.toFixed(2)} pt)`
      image = { data: shot.jpegBase64, mimeType: 'image/jpeg' }
    }
    if (result.screenshotError) {
      text += `\n${result.screenshotError}`
    }
    return { text, image, details: { app, window, diff: result.diff === true } }
  }

  private actionText(verb: string, result: HelperActionResult): string {
    const target = result.element?.label
      ? `"${result.element.label}"`
      : result.element?.role
    const where = result.app ? ` in ${result.app}` : ''
    const stale = result.staleId === true ? ' (stale element id)' : ''
    return `${verb} ${target ?? 'element'}${where}${stale}`
  }

  private summaryFor(
    tool: string,
    app: string | undefined,
    params: Record<string, unknown>
  ): string {
    const where = app ? ` in ${app}` : ''
    switch (tool) {
      case 'computer_apps':
        return 'Listed apps'
      case 'computer_state':
        return `Read ${app ?? 'app'}`
      case 'computer_click':
        return `Clicked${where}`
      case 'computer_set_value':
        return `Set value${where}`
      case 'computer_type':
        return `Typed ${typeof params['text'] === 'string' ? (params['text'] as string).length : 0} characters${where}`
      case 'computer_key':
        return `Pressed ${String(params['key'] ?? '?')}${where}`
      case 'computer_scroll':
        return `Scrolled ${String(params['direction'] ?? '')}${where}`
      case 'computer_drag':
        return `Dragged${where}`
      case 'computer_action':
        return `Performed ${String(params['action'] ?? '?')}${where}`
      case 'computer_screenshot':
        return `Screenshot of ${app ?? 'screen'}`
      default:
        return tool
    }
  }

  private requireApp(params: Record<string, unknown>): string {
    return this.requireString(params['app'], 'app')
  }

  private requireString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw toolError(`missing required param: ${name}`)
    }
    return value
  }

  private requireNumber(value: unknown, name: string): number {
    const n = Number(value)
    if (!Number.isFinite(n)) {
      throw toolError(`${name} must be a number`)
    }
    return n
  }

  private requireInt(value: unknown, name: string): number {
    const n = Number(value)
    if (!Number.isInteger(n)) {
      throw toolError(`${name} must be an integer`)
    }
    return n
  }

  private oneOf(value: unknown, allowed: string[], name: string): string {
    const s = this.requireString(value, name)
    if (!allowed.includes(s)) {
      throw toolError(`${name} must be one of ${allowed.join(', ')}`)
    }
    return s
  }
}

export { STOP_MESSAGE }
