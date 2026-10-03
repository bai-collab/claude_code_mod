import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const COMMAND = 'prompt-optimizer'
const BYPASS = '*'

// Origins typed by the person; notifications, peers and schedules are left alone.
const HUMAN_ORIGINS = new Set(['composer', 'bridge'])

export const GUIDANCE = [
  '[prompt-optimizer] Before acting, check whether this prompt states its goal, scope and what "done" looks like.',
  '- If a decision only the user can make is missing and cannot be inferred from the code or a sensible default, ask at most 3 short clarifying questions first.',
  '- Otherwise proceed directly, and open your reply with one line naming the assumptions you made.',
].join('\n')

const isPaused = atom({ plugin: 'prompt-optimizer', key: 'isPaused' } as const, false)

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'short-only')
  const minLength = Number(options.minLength ?? 80)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Pause or resume prompt-optimizer for this session',
    })
    $.ui.status(mode === 'off' ? undefined : 'PO: on')

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const paused = await update($, isPaused, was => !was)
    $.ui.status(mode === 'off' || paused ? undefined : 'PO: on')

    return {
      text: paused
        ? 'prompt-optimizer paused for this session.'
        : 'prompt-optimizer resumed for this session.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!HUMAN_ORIGINS.has(e.origin.kind)) {
      return next(e)
    }

    const text = e.text.trimStart()

    // A leading "*" skips the guidance for one prompt.
    if (text.startsWith(BYPASS)) {
      return next({ ...e, text: text.slice(BYPASS.length).trimStart() })
    }

    const isWanted =
      mode === 'always' || (mode === 'short-only' && text.length < minLength)

    if (!isWanted || text.startsWith('/') || (await read($, isPaused))) {
      return next(e)
    }

    return next({ ...e, context: [...(e.context ?? []), GUIDANCE] })
  })
}
