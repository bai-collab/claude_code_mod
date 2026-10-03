export type Paused = boolean

declare module 'claude-code' {
  interface PluginState {
    'prompt-optimizer': { isPaused: Paused }
  }
}
