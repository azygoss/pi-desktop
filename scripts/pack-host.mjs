#!/usr/bin/env node
// Build pi-remote (the headless remote-control host) and pack it as an npm
// package: release/pi-remote-host-<version>.tgz. Install it on a server with
//   npm install -g ./pi-remote-host-<version>.tgz   (or the release URL)
// The bundle holds the app's own code; ws, tweetnacl, qrcode and pi itself
// are ordinary npm dependencies, installed next to it.

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const stage = join(root, 'out', 'host-package')
const release = join(root, 'release')

execFileSync(
  process.execPath,
  [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'host.vite.config.ts'],
  {
    cwd: root,
    stdio: 'inherit'
  }
)

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
copyFileSync(join(root, 'out/host/pi-remote.mjs'), join(stage, 'pi-remote.mjs'))
chmodSync(join(stage, 'pi-remote.mjs'), 0o755)
copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'))
copyFileSync(join(root, 'docs/pi-remote.md'), join(stage, 'README.md'))

const pick = (name) => {
  const version = app.dependencies[name]
  if (!version) {
    throw new Error(`${name} is not a dependency of the app`)
  }
  return version
}
const manifest = {
  name: 'pi-remote-host',
  version: app.version,
  description:
    'Remote control for the pi coding agent without the desktop app: pair the Pi Remote phone app with a server.',
  license: app.license,
  type: 'module',
  bin: { 'pi-remote': 'pi-remote.mjs' },
  files: ['pi-remote.mjs', 'README.md', 'LICENSE'],
  engines: { node: '>=22.19' }, // pi needs it
  os: ['linux', 'darwin'],
  dependencies: {
    '@earendil-works/pi-coding-agent': pick('@earendil-works/pi-coding-agent'),
    qrcode: pick('qrcode'),
    tweetnacl: pick('tweetnacl'),
    ws: pick('ws')
  }
}
writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

mkdirSync(release, { recursive: true })
const out = execFileSync('npm', ['pack', '--pack-destination', release], {
  cwd: stage,
  encoding: 'utf8'
})
console.log(`pack-host: ${join(release, out.trim().split('\n').pop())}`)
