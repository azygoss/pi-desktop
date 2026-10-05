import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createConnection } from 'node:net'

import type { RemoteStatus } from '../main/remote/remote-server'
import { resolvePiRuntime } from '../main/pi/locator'
import { callControl } from './control'

/**
 * pi-remote's upkeep commands: doctor (is everything in place, and what to
 * do if not), logs, update and removing the service. Plain output for a
 * terminal over SSH; every finding says what to run next.
 */

const REPO = 'azygoss/pi-desktop'
const SERVICE = 'pi-remote'

type Log = (line: string) => void

function run(
  command: string,
  args: string[],
  timeoutMs = 10_000
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, out: `${stdout}${stderr}`.trim() })
    })
  })
}

export function serviceUnitPath(): string {
  return join(
    process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'),
    'systemd',
    'user',
    `${SERVICE}.service`
  )
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolvePromise(ok)
    }
    socket.setTimeout(3000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Check the installation end to end. Resolves false when something needs fixing. */
export async function doctor(options: {
  dataDir: string
  socket: string
  log: Log
}): Promise<boolean> {
  const { log } = options
  let healthy = true
  const ok = (text: string) => log(`  ✓ ${text}`)
  const warn = (text: string, fix?: string) => {
    log(`  ! ${text}${fix ? `\n      → ${fix}` : ''}`)
  }
  const fail = (text: string, fix: string) => {
    healthy = false
    log(`  ✗ ${text}\n      → ${fix}`)
  }

  log('pi-remote doctor')
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  if (major > 22 || (major === 22 && minor >= 19)) {
    ok(`Node.js ${process.versions.node}`)
  } else {
    fail(
      `Node.js ${process.versions.node} is too old`,
      'Install Node.js 22.19 or newer (https://nodejs.org)'
    )
  }

  try {
    const runtime = await resolvePiRuntime({
      ...(process.env['PI_DESKTOP_PI_COMMAND']
        ? { customPath: process.env['PI_DESKTOP_PI_COMMAND'] }
        : {})
    })
    ok(
      `pi ${runtime.version ?? '(unknown version)'} (${runtime.kind}: ${basename(runtime.command)})`
    )
  } catch (error) {
    fail(
      `pi cannot be started: ${error instanceof Error ? error.message : String(error)}`,
      'npm install -g @earendil-works/pi-coding-agent, then run `pi` once to log in'
    )
  }

  const dir = await stat(options.dataDir).catch(() => null)
  if (!dir) {
    warn(`No data directory yet (${options.dataDir})`, 'It is created by `pi-remote start`')
  } else if ((dir.mode & 0o077) !== 0) {
    fail(`${options.dataDir} is readable by others`, `chmod 700 ${options.dataDir}`)
  } else {
    ok(`Data directory ${options.dataDir}`)
  }
  const store = await stat(join(options.dataDir, 'remote.json')).catch(() => null)
  if (store && (store.mode & 0o077) !== 0) {
    fail(
      'remote.json (the host key) is readable by others',
      `chmod 600 ${join(options.dataDir, 'remote.json')}`
    )
  }

  const status = (await callControl(options.socket, { cmd: 'status' }, 4000).catch(
    () => null
  )) as RemoteStatus | null
  if (!status) {
    fail(
      'The host is not running',
      existsSync(serviceUnitPath())
        ? 'systemctl --user start pi-remote'
        : 'pi-remote start (or pi-remote service install)'
    )
  } else {
    ok(`Host running on port ${status.port}`)
    if (status.port !== null && !(await portAnswers(status.port))) {
      fail(`Port ${status.port} does not answer locally`, 'Check `pi-remote logs` for errors')
    }
    if (status.addresses.length === 0) {
      fail(
        'The pairing code has no address',
        'Start with --host <public IP, domain or Tailscale name>'
      )
    } else {
      ok(`Phones connect to ${status.addresses.join(', ')}`)
    }
    if (status.devices.length === 0) {
      warn('No paired phones', 'pi-remote pair')
    } else {
      const connected = status.devices.filter((d) => d.connected).length
      ok(
        `${status.devices.length} paired phone${status.devices.length === 1 ? '' : 's'} (${connected} connected)`
      )
    }
  }

  if (process.platform === 'linux') {
    if (existsSync(serviceUnitPath())) {
      const enabled = await run('systemctl', ['--user', 'is-enabled', SERVICE])
      if (enabled.out === 'enabled') {
        ok('systemd service enabled')
      } else {
        warn(
          'The systemd service is installed but not enabled',
          'systemctl --user enable --now pi-remote'
        )
      }
      const user = process.env['USER'] ?? ''
      const linger = await run('loginctl', ['show-user', user, '-p', 'Linger'])
      if (linger.ok && !linger.out.includes('Linger=yes')) {
        warn('The service stops when you log out', `sudo loginctl enable-linger ${user}`)
      }
    } else {
      warn(
        'No systemd service: the host runs only while this terminal does',
        'pi-remote service install --host <address>'
      )
    }
    if (status?.port) {
      const ufw = await run('ufw', ['status'])
      if (
        ufw.ok &&
        /Status: active/.test(ufw.out) &&
        !new RegExp(`\\b${status.port}(/tcp)?\\b`).test(ufw.out)
      ) {
        warn(
          `The firewall (ufw) is on and port ${status.port} is not listed`,
          `sudo ufw allow ${status.port}/tcp (or use Tailscale)`
        )
      }
    }
  }
  log(
    healthy
      ? 'Everything looks right.'
      : 'Fix the ✗ items above, then run `pi-remote doctor` again.'
  )
  return healthy
}

/** Follow the service's journal (Linux) or say where the log is. */
export function logs(follow: boolean, log: Log): Promise<number> {
  if (process.platform !== 'linux') {
    log('Logs: pi-remote prints them where it runs (systemd keeps them on Linux).')
    return Promise.resolve(1)
  }
  return new Promise((resolvePromise) => {
    const child = spawn(
      'journalctl',
      ['--user', '-u', SERVICE, '--no-pager', '-n', '200', ...(follow ? ['-f'] : [])],
      {
        stdio: 'inherit'
      }
    )
    child.once('exit', (code) => resolvePromise(code ?? 0))
    child.once('error', () => {
      log('journalctl is not available here.')
      resolvePromise(1)
    })
  })
}

/** Newest release with a pi-remote package, from GitHub. */
async function latestRelease(): Promise<{ version: string; url: string } | null> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'pi-remote' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}`)
  }
  const release = (await response.json()) as {
    assets?: { name?: string; browser_download_url?: string }[]
  }
  for (const asset of release.assets ?? []) {
    const match = /^pi-remote-host-(\d+\.\d+\.\d+)\.tgz$/.exec(asset.name ?? '')
    if (match && asset.browser_download_url) {
      return { version: match[1]!, url: asset.browser_download_url }
    }
  }
  return null
}

function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
      return (pa[i] ?? 0) > (pb[i] ?? 0)
    }
  }
  return false
}

/** Install the newest release over this one and restart the service. */
export async function update(
  current: string,
  options: { check: boolean; log: Log }
): Promise<boolean> {
  const { log } = options
  const latest = await latestRelease()
  if (!latest) {
    log('No pi-remote package in the latest release.')
    return false
  }
  if (!newer(latest.version, current)) {
    log(`pi-remote ${current} is up to date.`)
    return true
  }
  log(`pi-remote ${latest.version} is available (this is ${current}).`)
  if (options.check) {
    log('Run `pi-remote update` to install it.')
    return true
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const install = await new Promise<number>((resolvePromise) => {
    const child = spawn(npm, ['install', '-g', latest.url], { stdio: 'inherit' })
    child.once('exit', (code) => resolvePromise(code ?? 1))
    child.once('error', () => resolvePromise(1))
  })
  if (install !== 0) {
    log('The install failed. If npm needs root here, run: sudo npm install -g ' + latest.url)
    return false
  }
  if (process.platform === 'linux' && existsSync(serviceUnitPath())) {
    const active = await run('systemctl', ['--user', 'is-active', SERVICE])
    if (active.out === 'active') {
      const restarted = await run('systemctl', ['--user', 'restart', SERVICE], 30_000)
      log(
        restarted.ok
          ? 'Service restarted on the new version.'
          : 'Restart it: systemctl --user restart pi-remote'
      )
    }
  } else {
    log('Restart pi-remote to use the new version.')
  }
  log(`pi-remote ${latest.version} installed.`)
  return true
}

/** Stop, disable and remove the systemd user service. */
export async function uninstallService(log: Log): Promise<boolean> {
  const path = serviceUnitPath()
  if (!existsSync(path)) {
    log('No pi-remote service is installed.')
    return true
  }
  await run('systemctl', ['--user', 'disable', '--now', SERVICE], 30_000)
  // The unit was generated by `service install`; nothing of the user's is in it.
  await unlink(path)
  await run('systemctl', ['--user', 'daemon-reload'])
  log(`Removed ${path}. Paired phones and the host key stay in the data directory.`)
  return true
}
