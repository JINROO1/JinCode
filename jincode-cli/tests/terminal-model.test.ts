import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  keyBytes, normalizeEnvironment, normalizeInfos, normalizeShells, parseTerminalFrame,
  TerminalError, TerminalInputQueue, type TerminalCommand,
} from '../src/app/terminal-model.ts'

const shell = { path: '/bin/bash', args: ['-l'], name: 'bash' }
const info = (overrides: Record<string, unknown> = {}) => ({
  id: 't-1', title: 'Build', shell, cwd: '/w', cols: 80, rows: 24, state: 'running', exitCode: null,
  origin: 'agent', control: 'agent', sandboxMode: 'workspace-write', ...overrides,
})

test('terminal: the Host lists are read tolerantly and malformed entries are dropped', () => {
  assert.deepEqual(normalizeShells([shell, { path: 3 }, null]), [{ path: '/bin/bash', args: ['-l'], name: 'bash' }])
  const [first, ...rest] = normalizeInfos([info(), info({ state: 'paused' }), info({ id: 't-2', exitCode: 2, state: 'exited', origin: 'user', control: 'user', sandboxMode: undefined })])
  assert.equal(rest.length, 1, 'a terminal with an unknown state is dropped')
  assert.equal(first?.origin, 'agent')
  assert.equal(first?.exitCode, undefined, 'a null exit code is not a number')
  assert.equal(rest[0]?.exitCode, 2)
  assert.equal(rest[0]?.sandboxMode, undefined, 'user terminals omit the sandbox')
  assert.equal(normalizeEnvironment({ cwd: '/w', maxInputBytes: 10, maxBufferedBytes: 20, maxCols: 300, maxRows: 100, scrollback: 500 })?.maxBufferedBytes, 20)
  assert.equal(normalizeEnvironment({ cwd: '/w' }), undefined)
})

test('terminal: attachment frames are checked; unknown types are skipped and malformed ones throw', () => {
  const snapshot = parseTerminalFrame({ type: 'snapshot', sequence: 4, screen: '$ ', info: info(), writable: true, inputWindow: { maxBytes: 100, frameOverheadBytes: 12 } })
  assert.equal(snapshot?.type, 'snapshot')
  assert.deepEqual(snapshot?.type === 'snapshot' ? snapshot.inputWindow : undefined, { maxBytes: 100, frameOverheadBytes: 12 })
  assert.equal(parseTerminalFrame({ type: 'telemetry' }), undefined)
  assert.deepEqual(parseTerminalFrame({ type: 'ack', sequence: 2, refusal: 'read-only' }), { type: 'ack', sequence: 2, refusal: 'read-only' })
  assert.throws(() => parseTerminalFrame({ type: 'output', sequence: 'x', data: '' }), (error: unknown) => error instanceof TerminalError && error.issue === 'invalidOutput')
  assert.throws(() => parseTerminalFrame('nope'), TerminalError)
})

test('terminal input: commands wait for the window, go out in order, and acknowledgements free the window', () => {
  const sent: TerminalCommand[] = []
  const window = { maxBytes: 2 * (12 + Buffer.byteLength(JSON.stringify({ type: 'write', sequence: 1, data: 'a', typed: true }))), frameOverheadBytes: 12 }
  const queue = new TerminalInputQueue({ maxInputBytes: 100, maxBufferedBytes: 10_000 }, window, command => sent.push(command))
  queue.write('a')
  queue.write('b')
  queue.write('c')
  assert.deepEqual(sent.map(command => command.sequence), [1, 2], 'the third command waits behind the window')
  queue.ack(1, undefined)
  assert.deepEqual(sent.map(command => command.sequence), [1, 2, 3], 'an acknowledgement sends the waiting command')
  assert.throws(() => queue.ack(5, undefined), (error: unknown) => error instanceof TerminalError && error.issue === 'invalidOutput', 'out-of-order acknowledgements are a protocol error')
  assert.equal(queue.ack(2, 'not-running'), 'not-running')
  queue.ack(3, undefined)
  assert.equal(queue.pendingRawBytes(), 0)
})

test('terminal input: the raw budget refuses input before it is sent', () => {
  const sent: TerminalCommand[] = []
  const queue = new TerminalInputQueue({ maxInputBytes: 4, maxBufferedBytes: 1000 }, undefined, command => sent.push(command))
  queue.write('abc')
  assert.throws(() => queue.write('de'), (error: unknown) => error instanceof TerminalError && error.issue === 'inputFull')
  assert.equal(sent.length, 1, 'the refused input was not sent')
  queue.resize(100, 30)
  assert.deepEqual(sent[1], { type: 'resize', sequence: 2, cols: 100, rows: 30 }, 'resizes are sequenced like input')
  queue.reset(undefined)
  queue.write('ok')
  assert.equal(sent[2]?.sequence, 1, 'a reset starts a new sequence')
})

test('terminal keys: Ink key flags become the xterm encoding', () => {
  assert.equal(keyBytes('', { return: true }), '\r')
  assert.equal(keyBytes('', { backspace: true }), '\x7f')
  assert.equal(keyBytes('', { escape: true }), '\x1b')
  assert.equal(keyBytes('', { tab: true }), '\t')
  assert.equal(keyBytes('', { tab: true, shift: true }), '\x1b[Z')
  assert.equal(keyBytes('', { upArrow: true }), '\x1b[A')
  assert.equal(keyBytes('', { upArrow: true }, true), '\x1bOA', 'application cursor mode changes arrows')
  assert.equal(keyBytes('', { pageDown: true }), '\x1b[6~')
  assert.equal(keyBytes('c', { ctrl: true }), '\x03', 'Ctrl+C reaches the shell as ETX')
  assert.equal(keyBytes('d', { ctrl: true }), '\x04')
  assert.equal(keyBytes(']', { ctrl: true }), '\x1d')
  assert.equal(keyBytes('x', { meta: true }), '\x1bx')
  assert.equal(keyBytes('\x1bx', { meta: true }), '\x1bx', 'Ink reports Alt+x already prefixed: it is not prefixed twice')
  assert.equal(keyBytes('', { home: true }), '\x1b[H')
  assert.equal(keyBytes('', { end: true }, true), '\x1bOF')
  assert.equal(keyBytes('\x1d', {}), '\x1d', 'Ctrl+] arrives as the raw control byte and is sent as is')
  assert.equal(keyBytes('hola', {}), 'hola')
  assert.equal(keyBytes('', {}), undefined)
})
