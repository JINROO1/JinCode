import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent, applyLiveFrame, emptyTranscript, textOf, type Transcript } from '../src/transcript/reducer.ts'
import { applyFollowFrame, normalizeCatalog } from '../src/app/session-client.ts'

function run(events: Array<{ type: string; seq: number; data: unknown }>): Transcript {
  return events.reduce((state, event) => applyEvent(state, event), emptyTranscript())
}

test('user messages from the user are shown; runtime context is not', () => {
  const state = run([
    { type: 'user/message', seq: 1, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hola' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { id: 'c1', role: 'user', content: [{ type: 'text', text: '<system-reminder>cwd</system-reminder>' }], source: { kind: 'runtime-context' } } },
    { type: 'user/message', seq: 3, data: { id: 'c2', role: 'user', content: [{ type: 'text', text: 'hora' }], source: { kind: 'time-context' } } },
  ])
  assert.deepEqual(state.items, [{ kind: 'user', id: 'u1', text: 'hola' }])
})

test('system prompt messages never reach the transcript', () => {
  const state = run([{ type: 'system/message', seq: 1, data: { message: { id: 's', role: 'system', content: [{ type: 'text', text: 'PROMPT' }] } } }])
  assert.equal(state.items.length, 0)
})

test('replayed events at or below lastSeq are ignored', () => {
  const event = { type: 'user/message', seq: 5, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } } }
  const once = applyEvent(emptyTranscript(), event)
  const twice = applyEvent(once, event)
  assert.equal(twice, once)
  assert.equal(twice.lastSeq, 5)
})

test('a turn opens and closes; an error reason is shown as a system row', () => {
  const state = run([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    {
      type: 'turn/end',
      seq: 2,
      data: { turn: 1, reason: { kind: 'error', error: { message: 'no credential for provider route "jincode"' } } },
    },
  ])
  assert.equal(state.running, false)
  const turn = state.items.find(item => item.kind === 'turn')
  assert.deepEqual(turn, { kind: 'turn', turn: 1, ended: true, reason: 'error' })
  const error = state.items.find(item => item.kind === 'system')
  assert.ok(error && error.kind === 'system' && error.text.includes('no credential'))
})

test('a failed turn with no text leaves no empty assistant row', () => {
  const state = run([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } },
  ])
  assert.equal(state.items.some(item => item.kind === 'assistant'), false)
})

test('assistant deltas accumulate and the committed message replaces them', () => {
  let state = run([{ type: 'turn/start', seq: 1, data: { turn: 1 } }])
  state = applyEvent(state, { type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hola' } } })
  state = applyEvent(state, { type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: ', mundo' } } })
  state = applyEvent(state, { type: 'assistant/chunk', seq: 4, data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 2, text: 'pienso' } } })
  const live = state.items.find(item => item.kind === 'assistant')
  assert.ok(live && live.kind === 'assistant' && live.text === 'Hola, mundo' && live.reasoning === 'pienso' && !live.done)
  state = applyEvent(state, {
    type: 'assistant/message',
    seq: 5,
    data: { turn: 1, step: 1, message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'Hola, mundo.' }] } },
  })
  const done = state.items.find(item => item.kind === 'assistant')
  assert.ok(done && done.kind === 'assistant' && done.text === 'Hola, mundo.' && done.done)
})

test('live assistant-stream frames update the row of their attempt', () => {
  let state = emptyTranscript()
  state = applyLiveFrame(state, { type: 'start', attemptId: 'a1', turn: 2, step: 1 })
  state = applyLiveFrame(state, { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', index: 0, text: 'en vivo' } })
  state = applyLiveFrame(state, { type: 'chunk', attemptId: 'unknown', chunk: { type: 'text-delta', index: 0, text: 'x' } })
  const row = state.items[0]
  assert.ok(row && row.kind === 'assistant' && row.text === 'en vivo' && row.turn === 2)
})

test('tool calls become running cards and results close them with their output', () => {
  const state = run([
    { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' } },
    {
      type: 'tool/result',
      seq: 2,
      data: { turn: 1, step: 1, message: { id: 'r', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'a.txt' }] }] } },
    },
  ])
  const card = state.items.find(item => item.kind === 'tool')
  assert.deepEqual(card, { kind: 'tool', turn: 1, callId: 'call-1', name: 'bash', args: '{"command":"ls"}', output: 'a.txt', status: 'done' })
})

test('a failed tool result marks the card as an error', () => {
  const state = run([
    { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 2,
      data: { turn: 1, step: 1, message: { id: 'r', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'denied' }] }] }, error: { name: 'E', code: 'X' } },
    },
  ])
  const card = state.items.find(item => item.kind === 'tool')
  assert.ok(card && card.kind === 'tool' && card.status === 'error' && card.output === 'denied')
})

test('the follow snapshot replays its records and then applies live frames', () => {
  const snapshot = {
    type: 'snapshot',
    cursor: 2,
    hasMore: false,
    records: [
      { type: 'event', event: { type: 'user/message', seq: 1, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'pregunta' }], source: { kind: 'user' } } } },
      { type: 'event', event: { type: 'turn/start', seq: 2, data: { turn: 1 } } },
    ],
  }
  let state = applyFollowFrame(emptyTranscript(), snapshot)
  assert.equal(state.items.length, 2)
  state = applyFollowFrame(state, { type: 'assistant-stream', frame: { type: 'start', attemptId: 'z', turn: 1, step: 1 } })
  state = applyFollowFrame(state, { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'z', chunk: { type: 'text-delta', index: 0, text: 'ok' } } })
  const row = state.items.find(item => item.kind === 'assistant')
  assert.ok(row && row.kind === 'assistant' && row.text === 'ok')
})

test('textOf joins text blocks and ignores other blocks', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image', attachment: {} }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOf('plain'), 'plain')
  assert.equal(textOf(undefined), '')
})

test('normalizeCatalog accepts arrays and items wrappers and drops malformed rows', () => {
  assert.deepEqual(normalizeCatalog([{ provider: 'jincode', model: 'gpt-4o-mini', reasoningEfforts: ['low', 2] }, { nope: true }]), [
    { provider: 'jincode', model: 'gpt-4o-mini', reasoningEfforts: ['low'] },
  ])
  assert.deepEqual(normalizeCatalog({ items: [{ provider: 'p', id: 'm' }] }), [{ provider: 'p', model: 'm' }])
  assert.deepEqual(normalizeCatalog(null), [])
})

test('the same call id in two turns makes two cards, each closed by its own result', () => {
  const call = (turn: number) => ({ type: 'tool/call', seq: 0, data: { turn, step: 1, callId: 'call_1', name: 'bash', arguments: '{}' } })
  const result = (turn: number, text: string) => ({
    type: 'tool/result',
    seq: 0,
    data: { turn, step: 1, message: { role: 'tool', toolCallId: 'call_1', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'text', text }] } },
  })
  let state = emptyTranscript()
  let seq = 0
  const apply = (event: { type: string; data: unknown }): void => {
    state = applyEvent(state, { ...event, seq: ++seq })
  }
  apply(call(1))
  apply(result(1, 'primera'))
  apply(call(2))
  apply(result(2, 'segunda'))
  const cards = state.items.filter(item => item.kind === 'tool')
  assert.equal(cards.length, 2)
  assert.deepEqual(cards.map(card => card.kind === 'tool' ? [card.turn, card.output, card.status] : []), [[1, 'primera', 'done'], [2, 'segunda', 'done']])
})

test('a tool result flagged as an error closes its card as failed', () => {
  const state = run([
    { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'x', name: 'bash', arguments: '{}' } },
    { type: 'tool/result', seq: 2, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'x', isError: true, content: [{ type: 'text', text: 'boom' }] } } },
  ])
  const card = state.items.find(item => item.kind === 'tool')
  assert.ok(card && card.kind === 'tool' && card.status === 'error' && card.output === 'boom')
})
