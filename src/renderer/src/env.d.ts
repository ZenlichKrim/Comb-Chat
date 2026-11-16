/// <reference types="vite/client" />

import type { CombApi } from '../../shared/types'

declare global {
  interface Window {
    comb: CombApi & { ui: { onCommand: (cb: (cmd: string) => void) => () => void } }
  }
}

export {}
