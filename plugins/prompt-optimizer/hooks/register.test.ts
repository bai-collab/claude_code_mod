import { describe, expect, test } from 'claude-code/testing'

import { GUIDANCE } from './register'

const composer = { kind: 'composer' } as const

describe('prompt-optimizer', () => {
  test('attaches guidance to a short prompt', async ($, on) => {
    let seen: readonly string[] | undefined
    on('prompt.submit', (_, e) => {
      seen = e.context
      return { text: e.text }
    })

    await $.prompt.submit({ text: 'fix the bug', wait: false, origin: composer })

    expect(seen).toEqual([GUIDANCE])
  })

  test('leaves a long prompt alone', async ($, on) => {
    let seen: readonly string[] | undefined = ['unset']
    on('prompt.submit', (_, e) => {
      seen = e.context
      return { text: e.text }
    })

    await $.prompt.submit({ text: 'x'.repeat(200), wait: false, origin: composer })

    expect(seen).toEqual(undefined)
  })

  test('the bypass prefix strips itself and skips guidance', async ($, on) => {
    let text = ''
    let seen: readonly string[] | undefined = ['unset']
    on('prompt.submit', (_, e) => {
      text = e.text
      seen = e.context
      return { text: e.text }
    })

    await $.prompt.submit({ text: '* fix the bug', wait: false, origin: composer })

    expect(text).toBe('fix the bug')
    expect(seen).toEqual(undefined)
  })

  test('ignores prompts not typed by the person', async ($, on) => {
    let seen: readonly string[] | undefined = ['unset']
    on('prompt.submit', (_, e) => {
      seen = e.context
      return { text: e.text }
    })

    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'task-notification' } })

    expect(seen).toEqual(undefined)
  })

  test('always mode guides long prompts too', { options: { mode: 'always' } }, async ($, on) => {
    let seen: readonly string[] | undefined
    on('prompt.submit', (_, e) => {
      seen = e.context
      return { text: e.text }
    })

    await $.prompt.submit({ text: 'x'.repeat(200), wait: false, origin: composer })

    expect(seen).toEqual([GUIDANCE])
  })

  test('the command pauses guidance', async ($, on) => {
    let seen: readonly string[] | undefined = ['unset']
    on('prompt.submit', (_, e) => {
      seen = e.context
      return { text: e.text }
    })
    on('command.run', () => ({ text: '' }))

    const ran = await $.command.run({ command: 'prompt-optimizer', args: '', origin: composer } as never)
    await $.prompt.submit({ text: 'fix the bug', wait: false, origin: composer })

    expect(ran).toEqual({ text: 'prompt-optimizer paused for this session.' })
    expect(seen).toEqual(undefined)
  })

  test('a bare "* " is sent as typed, never emptied', async ($, on) => {
    let text = 'unset'
    on('prompt.submit', (_, e) => {
      text = e.text
      return { text: e.text }
    })

    await $.prompt.submit({ text: '*  ', wait: false, origin: composer })

    expect(text).toBe('*  ')
  })

  test('a long prompt keeps its leading "* "', async ($, on) => {
    const list = '* ' + 'item '.repeat(40)
    let text = ''
    on('prompt.submit', (_, e) => {
      text = e.text
      return { text: e.text }
    })

    await $.prompt.submit({ text: list, wait: false, origin: composer })

    expect(text).toBe(list)
  })

  test('off mode keeps the leading "* "', { options: { mode: 'off' } }, async ($, on) => {
    let text = ''
    on('prompt.submit', (_, e) => {
      text = e.text
      return { text: e.text }
    })

    await $.prompt.submit({ text: '* fix', wait: false, origin: composer })

    expect(text).toBe('* fix')
  })
})
