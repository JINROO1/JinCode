import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalFromWaterfall,
  buildAnswers,
  continuedQuestionsOf,
  emptyDrafts,
  isAnswered,
  nextUnconfirmed,
  parseEventsFrame,
  pickRow,
  questionFromWaterfall,
  questionsOf,
  setCustom,
  type QuestionItem,
} from '../src/app/interaction-rules.ts'

const single: QuestionItem = {
  id: 'color', question: 'Que color?', options: [{ label: 'Rojo' }, { label: 'Azul' }], multiSelect: false,
}
const multi: QuestionItem = {
  id: 'fruta', question: 'Frutas?', header: 'Comida', options: [{ label: 'Pera' }, { label: 'Uva' }, { label: 'Kiwi' }], multiSelect: true,
}
const free: QuestionItem = { id: 'nombre', question: 'Tu nombre?', options: [], multiSelect: false }

test('parseEventsFrame reads each downlink frame and rejects other shapes', () => {
  assert.deepEqual(parseEventsFrame({ type: 'ready', clientId: 'c1', host: { home: '/h' } }), { type: 'ready', clientId: 'c1' })
  assert.deepEqual(parseEventsFrame({ type: 'cancel', eventId: 'e1' }), { type: 'cancel', eventId: 'e1' })
  assert.deepEqual(parseEventsFrame({ type: 'emit', event: 'api-session/status', args: ['s', true] }), {
    type: 'emit', event: 'api-session/status', args: ['s', true],
  })
  const waterfall = parseEventsFrame({ type: 'waterfall', event: 'approval/request', eventId: 'e2', agentId: 's1', request: { toolName: 'bash' } })
  assert.equal(waterfall?.type, 'waterfall')
  assert.equal(parseEventsFrame({ type: 'waterfall', event: 'x', eventId: 'e2', agentId: 's1' }), undefined)
  assert.equal(parseEventsFrame({ type: 'unknown' }), undefined)
  assert.equal(parseEventsFrame('text'), undefined)
})

test('questionsOf keeps valid questions and drops the rest', () => {
  const parsed = questionsOf([
    { id: 'a', question: 'Uno?', options: [{ label: 'Sí' }, { description: 'sin etiqueta' }], multiSelect: true },
    { question: 'sin id' },
    { id: 'b', question: 'Dos?' },
  ])
  assert.deepEqual(parsed, [
    { id: 'a', question: 'Uno?', options: [{ label: 'Sí' }], multiSelect: true },
    { id: 'b', question: 'Dos?', options: [], multiSelect: false },
  ])
  assert.equal(questionsOf([{ question: 'sin id' }]), undefined)
  assert.equal(questionsOf('no es lista'), undefined)
})

test('questionFromWaterfall maps the call id and the session', () => {
  const frame = parseEventsFrame({
    type: 'waterfall', event: 'user-questions/request', eventId: 'ev1', agentId: 'session-1',
    request: { questions: [single], wait: { callId: 'call-9', timed: false } },
  })
  assert.equal(frame?.type, 'waterfall')
  if (frame?.type !== 'waterfall') return
  assert.deepEqual(questionFromWaterfall(frame), {
    kind: 'question', key: 'waterfall:ev1', source: 'waterfall', sessionId: 'session-1', eventId: 'ev1', callId: 'call-9', questions: [single],
  })
  const bare = { ...frame, request: { questions: [single] } }
  assert.equal(questionFromWaterfall(bare)?.callId, undefined)
  assert.equal(questionFromWaterfall({ ...frame, request: {} }), undefined)
})

test('approvalFromWaterfall needs a tool name and keeps the reason', () => {
  const frame = parseEventsFrame({
    type: 'waterfall', event: 'approval/request', eventId: 'ev2', agentId: 'session-2',
    request: { toolName: 'bash', callId: 'call-1', reason: 'borrar' },
  })
  if (frame?.type !== 'waterfall') throw new Error('frame')
  assert.deepEqual(approvalFromWaterfall(frame), {
    kind: 'approval', key: 'approval:ev2', eventId: 'ev2', sessionId: 'session-2', toolName: 'bash', callId: 'call-1', reason: 'borrar',
  })
  assert.equal(approvalFromWaterfall({ ...frame, request: {} }), undefined)
})

test('continuedQuestionsOf lists only the calls that are continued', () => {
  const projection = {
    active: [
      { callId: 'c1', state: 'continued', questions: [single] },
      { callId: 'c2', state: 'open', questions: [single] },
      { callId: 'c3', state: 'continued', questions: [] },
      { state: 'continued', questions: [single] },
    ],
    settled: [],
  }
  const pending = continuedQuestionsOf('s1', projection)
  assert.deepEqual(pending.map(item => item.key), ['continued:s1:c1'])
  assert.equal(pending[0]?.source, 'continued')
  assert.deepEqual(continuedQuestionsOf('s1', undefined), [])
})

test('a single-select pick replaces the previous pick and clears free text', () => {
  let draft = emptyDrafts([single])[0]!
  draft = setCustom(single, draft, 'otro')
  draft = pickRow(single, draft, 1)
  assert.deepEqual(draft.picks, [1])
  assert.equal(draft.custom, '')
  draft = pickRow(single, draft, 0)
  assert.deepEqual(draft.picks, [0])
})

test('a multi-select question toggles picks and keeps free text', () => {
  let draft = emptyDrafts([multi])[0]!
  draft = pickRow(multi, draft, 0)
  draft = pickRow(multi, draft, 2)
  assert.deepEqual(draft.picks, [0, 2])
  draft = pickRow(multi, draft, 0)
  assert.deepEqual(draft.picks, [2])
  draft = setCustom(multi, draft, ' mango ')
  assert.deepEqual(draft.picks, [2])
  assert.equal(draft.custom, ' mango ')
})

test('pickRow ignores the free-text row and out-of-range rows', () => {
  const draft = emptyDrafts([single])[0]!
  assert.equal(pickRow(single, draft, 2), draft)
  assert.equal(pickRow(single, draft, -1), draft)
})

test('isAnswered needs a pick or non-blank text', () => {
  assert.equal(isAnswered(single, { picks: [], custom: '  ', confirmed: false }), false)
  assert.equal(isAnswered(single, { picks: [0], custom: '', confirmed: false }), true)
  assert.equal(isAnswered(free, { picks: [], custom: 'Ana', confirmed: false }), true)
})

test('buildAnswers returns one item per question once every question is confirmed', () => {
  const drafts = [
    { picks: [1], custom: '', confirmed: true },
    { picks: [2, 0], custom: 'mango', confirmed: true },
    { picks: [], custom: 'Ana ', confirmed: true },
  ]
  assert.deepEqual(buildAnswers([single, multi, free], drafts), {
    answers: [
      { id: 'color', selected: ['Azul'] },
      { id: 'fruta', selected: ['Pera', 'Kiwi'], custom: 'mango' },
      { id: 'nombre', selected: [], custom: 'Ana' },
    ],
  })
})

test('buildAnswers names the questions still missing', () => {
  const drafts = [
    { picks: [0], custom: '', confirmed: true },
    { picks: [0], custom: '', confirmed: false },
  ]
  assert.deepEqual(buildAnswers([single, multi], drafts), { missing: ['fruta'] })
  assert.deepEqual(buildAnswers([single], [{ picks: [], custom: '', confirmed: true }]), { missing: ['color'] })
})

test('nextUnconfirmed wraps around and returns undefined when all are confirmed', () => {
  const drafts = [
    { picks: [0], custom: '', confirmed: true },
    { picks: [], custom: '', confirmed: false },
    { picks: [0], custom: '', confirmed: true },
  ]
  assert.equal(nextUnconfirmed(drafts, 0), 1)
  assert.equal(nextUnconfirmed(drafts, 1), 1)
  assert.equal(nextUnconfirmed(drafts.map(draft => ({ ...draft, confirmed: true })), 0), undefined)
})
