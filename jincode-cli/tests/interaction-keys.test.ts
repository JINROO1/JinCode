import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalKey, dropLast, reduceQuestion, startCard, type CardState } from '../src/ui/interaction-keys.ts'
import type { PendingQuestion } from '../src/app/interaction-rules.ts'
import type { KeyLike } from '../src/ui/keys.ts'

const item: PendingQuestion = {
  kind: 'question', key: 'waterfall:e', source: 'waterfall', sessionId: 's', eventId: 'e',
  questions: [
    { id: 'color', question: 'Que color?', options: [{ label: 'Rojo' }, { label: 'Azul' }], multiSelect: false },
    { id: 'fruta', question: 'Frutas?', options: [{ label: 'Pera' }, { label: 'Uva' }], multiSelect: true },
    { id: 'nombre', question: 'Nombre?', options: [], multiSelect: false },
  ],
}

/** Feed a sequence of inputs; each entry is [input, key]. Returns the last action and state. */
function run(steps: Array<[string, KeyLike]>, start: CardState = startCard(item)) {
  let state = start
  let action: ReturnType<typeof reduceQuestion>['action'] = { kind: 'none' }
  for (const [input, key] of steps) {
    const next = reduceQuestion(item, state, input, key)
    state = next.state
    if (next.action.kind !== 'none') action = next.action
  }
  return { state, action }
}

const enter: KeyLike = { return: true }
const down: KeyLike = { downArrow: true }
const up: KeyLike = { upArrow: true }
const space: [string, KeyLike] = [' ', {}]
const tab: KeyLike = { tab: true }
const back: KeyLike = { backspace: true }

test('Enter on an option answers a single-select question and moves on', () => {
  const { state, action } = run([['', down], ['', enter]])
  assert.equal(state.index, 1)
  assert.equal(action.kind, 'none')
  assert.deepEqual(state.drafts[0], { picks: [1], custom: '', confirmed: true })
})

test('confirming every question sends one answer per question and locks the card', () => {
  const { state, action } = run([
    ['', enter],                // color: first option Rojo
    [' ', {}],                  // fruta: Space picks Pera
    ['', down], [' ', {}],      // Uva also picked
    ['', enter],                // confirm fruta
    ...'Ana'.split('').map(char => [char, {}] as [string, KeyLike]),
    ['', enter],                // confirm nombre
  ])
  assert.equal(action.kind, 'submit')
  if (action.kind !== 'submit') return
  assert.deepEqual(action.answers, [
    { id: 'color', selected: ['Rojo'] },
    { id: 'fruta', selected: ['Pera', 'Uva'] },
    { id: 'nombre', selected: [], custom: 'Ana' },
  ])
  assert.equal(state.sending, true)
})

test('keys do nothing while the answer is being sent', () => {
  const { state } = run([['', enter], [' ', {}]], { ...startCard(item), sending: true })
  assert.equal(state.sending, true)
  assert.deepEqual(state.drafts[0]?.picks, [])
})

test('Enter with nothing chosen does not confirm the question', () => {
  const plain = startCard(item)
  const moved = run([['', down], ['', down]], plain).state
  const withoutAnswer = { ...moved, cursor: 2 }
  const result = reduceQuestion(item, withoutAnswer, '', enter)
  assert.equal(result.state.drafts[0]?.confirmed, false)
  assert.equal(result.action.kind, 'none')
})

test('Space toggles a multi-select row and does not confirm it', () => {
  const { state } = run([['', tab], [' ', {}], ['', down], [' ', {}], ['', up], [' ', {}]])
  assert.equal(state.index, 1)
  assert.deepEqual(state.drafts[1]?.picks, [1])
  assert.equal(state.drafts[1]?.confirmed, false)
})

test('the free-text row takes typed characters, Backspace erases them, and Enter confirms', () => {
  const toFree = [['', down], ['', down]] as Array<[string, KeyLike]>
  const { state, action } = run([
    ...toFree,
    ['h', {}], ['o', {}], ['l', {}], ['x', {}], ['', back], ['a', {}],
  ].map(([input, key]) => [input, key] as [string, KeyLike]), { ...startCard(item), index: 0 })
  assert.equal(state.drafts[0]?.custom, 'hola')
  assert.deepEqual(state.drafts[0]?.picks, [])
  assert.equal(action.kind, 'none')
  assert.equal(state.drafts[0]?.custom, 'hola')
  const confirmed = run([...toFree, ['h', {}], ['i', {}], ['', enter]])
  assert.deepEqual(confirmed.state.drafts[0], { picks: [], custom: 'hi', confirmed: true })
})

test('typing on a free-text row clears a single-select pick', () => {
  const { state } = run([['', down], ['', down], ['z', {}]], { ...startCard(item), index: 0 })
  assert.deepEqual(state.drafts[0]?.picks, [])
  assert.equal(state.drafts[0]?.custom, 'z')
})

test('Tab and arrows move between questions, Shift+Tab goes back', () => {
  assert.equal(run([['', tab]]).state.index, 1)
  assert.equal(run([['', { rightArrow: true }]]).state.index, 1)
  assert.equal(run([['', { tab: true, shift: true }]]).state.index, 2)
  assert.equal(run([['', { leftArrow: true }]]).state.index, 2)
})

test('the cursor stays inside the rows of the question', () => {
  assert.equal(run([['', up]]).state.cursor, 0)
  assert.equal(run([['', down], ['', down], ['', down], ['', down]]).state.cursor, 2)
})

test('Esc asks the owner to delegate, whatever the card holds', () => {
  assert.equal(run([['', { escape: true }]]).action.kind, 'delegate')
})

test('approval keys map to allow, reject and delegate', () => {
  assert.equal(approvalKey('y', {}), 'allow')
  assert.equal(approvalKey('Y', {}), 'allow')
  assert.equal(approvalKey('n', {}), 'reject')
  assert.equal(approvalKey('', { escape: true }), 'delegate')
  assert.equal(approvalKey('x', {}), undefined)
  assert.equal(approvalKey('y', { ctrl: true }), undefined)
})

test('dropLast removes one whole character, including astral ones', () => {
  assert.equal(dropLast('ab'), 'a')
  assert.equal(dropLast('a😀'), 'a')
  assert.equal(dropLast(''), '')
})
