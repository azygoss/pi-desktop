import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

// Strict CSP for the renderer. In dev mode the page is served by the Vite dev
// server, which needs inline module scripts (react-refresh preamble) and
// websocket HMR, so only the production policy is fully locked down.
// https: in img-src is for browser-tab favicons; http only in dev for local
// pages the panel browser can visit (favicons load from the page origin).
const CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https: http://localhost:* http://127.0.0.1:*; connect-src 'self'; font-src 'self'; object-src 'none'; " +
  "base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https: http://localhost:* http://127.0.0.1:*; " +
  "connect-src 'self' ws://localhost:* http://localhost:*; " +
  "font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"

function cspPlugin(): Plugin {
  return {
    name: 'pi-desktop-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        return html.replace('%PI_DESKTOP_CSP%', ctx.server ? CSP_DEV : CSP_PROD)
      }
    }
  }
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        output: {
          // Sandboxed preload scripts must be CommonJS.
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    build: {
      outDir: 'out/renderer',
      // electron-vite leaves renderer output unminified; minified chunks
      // parse and compile noticeably faster at startup and on lazy loads.
      minify: 'esbuild',
      cssMinify: true,
      // shiki's grammar chunks (cpp, emacs-lisp, wasm…) are big but only load
      // when a code block in that language appears.
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          // React + scheduler load as a stable vendor chunk; browsers cache
          // it across app updates and the app entry stays small.
          manualChunks(id: string) {
            if (
              id.includes('node_modules/react-dom') ||
              id.includes('node_modules/react/') ||
              id.includes('node_modules/scheduler') ||
              id.includes('node_modules/react/jsx-runtime')
            ) {
              return 'vendor-react'
            }
            return undefined
          }
        }
      }
    },
    plugins: [react(), tailwindcss(), cspPlugin()]
  }
})
