import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Build of `pi-remote`, the headless remote-control host (src/host). The
// main-process modules it shares with the desktop app import `electron`;
// here that resolves to a small shim with no window behind it. npm
// dependencies stay external and are installed with the package.
const root = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  version: string
}

export default defineConfig({
  resolve: {
    alias: { electron: resolve(root, 'src/host/electron-shim.ts') }
  },
  define: {
    __HOST_VERSION__: JSON.stringify(version)
  },
  build: {
    ssr: resolve(root, 'src/host/cli.ts'),
    outDir: 'out/host',
    target: 'node20',
    minify: false,
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'pi-remote.mjs',
        banner: '#!/usr/bin/env node',
        inlineDynamicImports: true
      }
    }
  },
  ssr: {
    // Bundle our own sources (and the shim); keep real packages external.
    noExternal: [],
    external: ['ws', 'tweetnacl', 'qrcode', 'node-pty']
  }
})
