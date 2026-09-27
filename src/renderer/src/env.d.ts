/// <reference types="vite/client" />

import type { PiDesktopApi } from '../../shared/api'

declare global {
  interface Window {
    piDesktop: PiDesktopApi
  }
}

export {}
