export type AnsiDoc = { path: string; lines: string[]; top: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Meter = { limits: Limit[]; contextPercent: number | null }

declare module 'claude-code' {
  interface PluginState {
    'skynet-panel': { doc: Shaped<AnsiDoc | null>; meter: Shaped<Meter> }
  }
}
