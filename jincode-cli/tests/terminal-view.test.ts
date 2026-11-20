import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render } from 'ink-testing-library'
import { TerminalScreen } from '../src/ui/TerminalScreen.tsx'
import { ScreenBuffer } from '../src/app/terminal-screen.ts'
import { terminalLine } from '../src/ui/Panel.tsx'
import type { AppState, TerminalView } from '../src/app/controller.ts'
import type { TerminalInfo } from '../src/app/terminal-model.ts'

const shell = { path: '/bin/bash', args: [], name: 'bash' }
const info = (overrides: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: 't-1', title: 'bash', shell, cwd: '/w', cols: 80, rows: 24, state: 'running', exitCode: undefined,
  error: undefined, origin: 'user', control: 'user', sandboxMode: undefined, ...overrides,
})

function viewOf(overrides: Partial<TerminalView>): AppState {
  const terminal: TerminalView = { sessionId: 's-1', id: 't-1', phase: 'connected', info: info(), writable: true, notice: undefined, revision: 0, ...overrides }
  return { terminal } as unknown as AppState
}

test('terminal view: the header names the terminal and says how it ends; the screen fills the rows', async () => {
  const screen = new ScreenBuffer(20, 4)
  await screen.write('$ ls\r\nfoo')
  const lines = screen.lines()
  const running = render(React.createElement(TerminalScreen, { state: viewOf({}), lines, columns: 60, rows: 10 }))
  assert.match(running.lastFrame() ?? '', /▣ bash · \/w/, 'a title equal to the shell name is not repeated')
  assert.match(running.lastFrame() ?? '', /\$ ls/)
  running.unmount()

  const exited = render(React.createElement(TerminalScreen, {
    state: viewOf({ info: info({ state: 'exited', exitCode: 0 }), writable: false, notice: 'La terminal terminó (código 0). Pulsa Enter para ver su última pantalla.' }),
    lines, columns: 60, rows: 10,
  }))
  assert.match(exited.lastFrame() ?? '', /terminó \(código 0\)/)
  assert.doesNotMatch(exited.lastFrame() ?? '', /solo lectura/, 'an ended terminal is not described as read-only')
  assert.match(exited.lastFrame() ?? '', /Pulsa Enter/)
  exited.unmount()

  const readOnly = render(React.createElement(TerminalScreen, { state: viewOf({ writable: false }), lines, columns: 60, rows: 10 }))
  assert.match(readOnly.lastFrame() ?? '', /solo lectura/)
  readOnly.unmount()
})

test('terminal lines in the panel name the shell only when the title says something else', () => {
  assert.equal(terminalLine(info({ title: 'Build' })), 'Build · bash · en ejecución · usuario')
  assert.equal(terminalLine(info({ title: 'bash' })), 'bash · en ejecución · usuario')
  assert.equal(terminalLine(info({ state: 'exited', exitCode: 2, origin: 'agent', control: 'agent', sandboxMode: 'read-only' })), 'bash · terminó (código 2) · agente · sandbox read-only')
  assert.equal(terminalLine(info({ state: 'failed', error: 'sin pty' })), 'bash · error: sin pty · usuario')
})
