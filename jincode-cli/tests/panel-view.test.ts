import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render } from 'ink-testing-library'
import { Panel, bodyWindow, panelRowCount, panelSelection } from '../src/ui/Panel.tsx'
import { handlePanelKey, type PanelKeys } from '../src/ui/panel-keys.ts'
import { cellWidth } from '../src/ui/layout.ts'
import { emptyBuffer, bufferOf, textOf } from '../src/ui/composer.ts'
import type { AppController, AppState, PanelState } from '../src/app/controller.ts'
import type { SettingsRow } from '../src/app/panel-client.ts'

// A snapshot with only the fields the panel reads; the rest is never touched.
function stateWith(panel: Partial<PanelState>, extra: Partial<AppState> = {}): AppState {
  const base: PanelState = {
    section: 'queue',
    queue: undefined,
    presets: undefined,
    settings: undefined,
    goal: undefined,
    schedules: undefined,
    skills: undefined,
    note: undefined,
  }
  return {
    sessions: [{ sessionId: 's-1', title: 'Principal', updatedAt: 0, running: false, blank: false, cwd: '/tmp' }],
    activeId: 's-1',
    panel: { ...base, ...panel },
    ...extra,
  } as unknown as AppState
}

// A controller that records what the panel asked for.
function fakeController(): { controller: AppController; calls: string[] } {
  const calls: string[] = []
  const handler = (name: string) => (...args: unknown[]): Promise<void> => {
    calls.push([name, ...args.map(value => JSON.stringify(value))].join(' '))
    return Promise.resolve()
  }
  const controller = new Proxy({}, { get: (_target, name: string) => handler(name) }) as unknown as AppController
  return { controller, calls }
}

function keysFor(state: AppState, controller: AppController, overrides: Partial<PanelKeys> = {}): PanelKeys {
  const store = { field: emptyBuffer(), pending: undefined as string | undefined, editing: undefined as string | undefined, cursor: 0 }
  return {
    input: '',
    key: {},
    state,
    controller,
    field: store.field,
    setField: value => { store.field = value },
    cursor: store.cursor,
    setCursor: value => { store.cursor = typeof value === 'function' ? value(store.cursor) : value },
    pendingPreset: store.pending,
    setPendingPreset: value => { store.pending = value },
    editingItem: store.editing,
    setEditingItem: value => { store.editing = value },
    ...overrides,
  }
}

test('every line of every section fits the width it was laid out for', () => {
  const long = 'palabra '.repeat(40) + 'supercalifragilisticoespialidosoxxxxxxxxxxxxxxxxxxxxxxxxxx'
  const sections: Array<Partial<PanelState>> = [
    { section: 'queue', queue: [{ id: 'q', placement: 'queued', text: long }] },
    { section: 'permissions', presets: { options: ['read-only', 'danger-full-access'], defaultPreset: 'danger-full-access' } },
    { section: 'settings', settings: [{ ns: 'agent', revision: 1, applies: 'next-turn', writable: false, value: { long }, user: undefined, secrets: [] }] },
    { section: 'goals', goal: { id: 'g', revision: 1, objective: long, phase: 'active', roundsStarted: 1, maxGoalRounds: 8 } },
    { section: 'schedule', schedules: [{ id: 's', title: long, status: 'active' }] },
    { section: 'skills', skills: [{ name: 'pdf', description: long }] },
  ]
  for (const width of [16, 30, 60]) {
    for (const panel of sections) {
      const { lastFrame, unmount } = render(React.createElement(Panel, {
        state: stateWith(panel, { activeId: 's-1' }),
        width,
        height: 40,
        cursor: 0,
        field: emptyBuffer(),
        editing: undefined,
        pendingPreset: undefined,
      }))
      const frame = lastFrame() ?? ''
      for (const line of frame.split('\n')) {
        assert.ok(cellWidth(line) <= width, `"${line}" wider than ${width} in ${panel.section}`)
      }
      unmount()
    }
  }
})

test('the tabs name all six sections and the active one is listed first', () => {
  const { lastFrame, unmount } = render(React.createElement(Panel, {
    state: stateWith({ section: 'queue', queue: [] }),
    width: 100,
    height: 12,
    cursor: 0,
    field: emptyBuffer(),
    editing: undefined,
    pendingPreset: undefined,
  }))
  const frame = lastFrame() ?? ''
  for (const label of ['Cola', 'Permisos', 'Ajustes', 'Metas', 'Programaciones', 'Habilidades']) {
    assert.ok(frame.includes(label), `missing tab ${label}`)
  }
  unmount()
})

test('a section that needs a Session says so when none is open', () => {
  const { lastFrame, unmount } = render(React.createElement(Panel, {
    state: stateWith({ section: 'goals' }, { activeId: undefined }),
    width: 60,
    height: 10,
    cursor: 0,
    field: emptyBuffer(),
    editing: undefined,
    pendingPreset: undefined,
  }))
  assert.match(lastFrame() ?? '', /Abre una sesión para ver sus metas/)
  unmount()
})

test('danger-full-access asks for a second Enter with a warning that names the risk', () => {
  const { lastFrame, unmount } = render(React.createElement(Panel, {
    state: stateWith({ section: 'permissions', presets: { options: ['read-only', 'danger-full-access'], defaultPreset: 'danger-full-access' } }),
    width: 80,
    height: 20,
    cursor: 1,
    field: emptyBuffer(),
    editing: undefined,
    pendingPreset: 'danger-full-access',
  }))
  const frame = lastFrame() ?? ''
  assert.match(frame, /no tiene confinamiento/)
  assert.match(frame, /Enter otra vez confirma/)
  unmount()
})

test('settings list one row per field, cap long values and say when the profile is read-only', () => {
  const long = 'x'.repeat(400)
  const { lastFrame, unmount } = render(React.createElement(Panel, {
    state: stateWith({ section: 'settings', settings: [{ ns: 'agent', revision: 2, applies: 'live', writable: false, value: { long, flag: true }, user: undefined, secrets: [] }] }),
    width: 70,
    height: 60,
    cursor: 0,
    field: emptyBuffer(),
    editing: undefined,
    pendingPreset: undefined,
  }))
  const frame = lastFrame() ?? ''
  assert.match(frame, /agent · rev 2/)
  assert.match(frame, /flag: true/)
  assert.match(frame, /… \(\d+ caracteres\)/)
  assert.match(frame, /solo lectura/i)
  unmount()
})

test('row counts and the selected item follow the section', () => {
  const state = stateWith({ section: 'queue', queue: [{ id: 'a', placement: 'queued', text: 'uno' }, { id: 'b', placement: 'steering', text: 'dos' }] })
  assert.equal(panelRowCount(state), 2)
  assert.deepEqual(panelSelection(state, 1), { id: 'b', kind: 'queue' })
  assert.equal(panelSelection(state, 5), undefined)
  const presets = stateWith({ section: 'permissions', presets: { options: ['read-only', 'workspace-write'], defaultPreset: undefined } })
  assert.equal(panelRowCount(presets), 2)
  assert.deepEqual(panelSelection(presets, 0), { id: 'read-only', kind: 'preset' })
  assert.equal(panelRowCount(stateWith({ section: 'goals', goal: null })), 0)
})

test('s steers, x removes and e opens an edit of the queued message under the cursor', () => {
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'queue', queue: [{ id: 'a', placement: 'queued', text: 'uno' }, { id: 'b', placement: 'queued', text: 'dos' }] })
  handlePanelKey(keysFor(state, controller, { input: 's', cursor: 1 }))
  handlePanelKey(keysFor(state, controller, { input: 'x' }))
  assert.deepEqual(calls, ['queueAction "b" {"kind":"steer"}', 'queueAction "a" {"kind":"remove"}'])

  let edited: string | undefined
  let field = emptyBuffer()
  const keys = keysFor(state, controller, {
    input: 'e',
    cursor: 1,
    setEditingItem: value => { edited = value },
    setField: value => { field = value },
  })
  handlePanelKey(keys)
  assert.equal(edited, 'b')
  assert.equal(textOf(field), 'dos')
})

test('while editing, Enter saves the edit and Esc-style cancel is handled by the screen', () => {
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'queue', queue: [{ id: 'a', placement: 'queued', text: 'uno' }] })
  let editing: string | undefined = 'a'
  let field = bufferOf('uno editado')
  const keys = keysFor(state, controller, {
    key: { return: true },
    editingItem: editing,
    field,
    setEditingItem: value => { editing = value },
    setField: value => { field = value },
  })
  handlePanelKey(keys)
  assert.equal(editing, undefined)
  assert.deepEqual(calls, ['queueAction "a" {"kind":"edit","text":"uno editado"}'])
})

test('an empty edit is not sent to the Host', () => {
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'queue', queue: [{ id: 'a', placement: 'queued', text: 'uno' }] })
  handlePanelKey(keysFor(state, controller, { key: { return: true }, editingItem: 'a', field: bufferOf('   ') }))
  assert.deepEqual(calls, [])
})

test('the permission preset needs a second Enter when it is the broad one', () => {
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'permissions', presets: { options: ['read-only', 'danger-full-access'], defaultPreset: 'danger-full-access' } })
  let pending: string | undefined
  const keys = (cursor: number): PanelKeys => keysFor(state, controller, {
    key: { return: true },
    cursor,
    pendingPreset: pending,
    setPendingPreset: value => { pending = value },
  })
  handlePanelKey(keys(1))
  assert.deepEqual(calls, [], 'the first Enter only asks')
  assert.equal(pending, 'danger-full-access')
  handlePanelKey(keys(1))
  assert.deepEqual(calls, ['setPreset "danger-full-access"'])
  assert.equal(pending, undefined)
})

test('a restricted preset applies with one Enter', () => {
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'permissions', presets: { options: ['read-only', 'danger-full-access'], defaultPreset: 'danger-full-access' } })
  handlePanelKey(keysFor(state, controller, { key: { return: true }, cursor: 0 }))
  assert.deepEqual(calls, ['setPreset "read-only"'])
})

test('Tab moves to the next section and Shift+Tab to the previous one, wrapping around', () => {
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'skills', skills: [] })
  handlePanelKey(keysFor(state, controller, { key: { tab: true } }))
  handlePanelKey(keysFor(stateWith({ section: 'queue', queue: [] }), controller, { key: { tab: true, shift: true } }))
  assert.deepEqual(calls, ['setSection "queue"', 'setSection "skills"'])
})

test('goals: typing creates a goal when none exists; p, r, c and x act only on an existing one', () => {
  const { controller, calls } = fakeController()
  const none = stateWith({ section: 'goals', goal: null })
  let field = emptyBuffer()
  handlePanelKey(keysFor(none, controller, { input: 'p', setField: value => { field = value } }))
  assert.deepEqual(calls, [], 'the letter p types into the objective; it does not pause')
  assert.equal(textOf(field), 'p')
  handlePanelKey(keysFor(none, controller, { key: { return: true }, field: bufferOf('terminar el informe') }))
  assert.deepEqual(calls, ['createGoal "terminar el informe"'])

  const goal = { id: 'g', revision: 2, objective: 'x', phase: 'active', roundsStarted: 0, maxGoalRounds: 8 }
  const active = stateWith({ section: 'goals', goal })
  handlePanelKey(keysFor(active, controller, { input: 'p' }))
  handlePanelKey(keysFor(active, controller, { input: 'r' }))
  handlePanelKey(keysFor(active, controller, { input: 'c' }))
  handlePanelKey(keysFor(active, controller, { input: 'x' }))
  assert.deepEqual(calls.slice(1), ['goalAction "pause"', 'goalAction "resume"', 'goalAction "complete"', 'clearGoal'])
})

test('goals: while the field has text, the goal shortcuts stay quiet', () => {
  const { controller, calls } = fakeController()
  const goal = { id: 'g', revision: 2, objective: 'x', phase: 'active', roundsStarted: 0, maxGoalRounds: 8 }
  handlePanelKey(keysFor(stateWith({ section: 'goals', goal }), controller, { input: 'x', field: bufferOf('abc') }))
  assert.deepEqual(calls, [])
})

test('settings, schedules and skills only move the cursor; they never send a change', () => {
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'settings', settings: [{ ns: 'a', revision: 1, applies: 'x', writable: false, value: { on: true }, user: undefined, secrets: [] }, { ns: 'b', revision: 1, applies: 'x', writable: false, value: { on: false }, user: undefined, secrets: [] }] })
  let cursor = 0
  handlePanelKey(keysFor(state, controller, { key: { downArrow: true }, setCursor: value => { cursor = typeof value === 'function' ? value(cursor) : value } }))
  handlePanelKey(keysFor(state, controller, { key: { return: true, downArrow: false }, input: 'x' }))
  assert.equal(cursor, 1)
  assert.deepEqual(calls.filter(call => call.startsWith('settingAction') || call.startsWith('writeSetting')), [], 'a read-only profile never sends a change')
})

test('Ctrl-free typing in the queue section never reaches the composer by accident', () => {
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'queue', queue: [{ id: 'a', placement: 'queued', text: 'uno' }] })
  handlePanelKey(keysFor(state, controller, { input: 'hola' }))
  assert.deepEqual(calls, [])
})

test('the body window keeps the cursor row in view and counts what is hidden', () => {
  assert.deepEqual(bodyWindow(5, 10, 2), { start: 0, above: 0, below: 0 }, 'everything fits: nothing scrolls')
  assert.deepEqual(bodyWindow(40, 10, 0), { start: 0, above: 0, below: 30 })
  const middle = bodyWindow(40, 10, 20)
  assert.ok(middle.start <= 20 && 20 < middle.start + 10, 'the focus row is visible')
  assert.equal(middle.above + middle.below, 30)
  assert.deepEqual(bodyWindow(40, 10, 39), { start: 30, above: 30, below: 0 }, 'the end of the list pins to the bottom')
  assert.deepEqual(bodyWindow(40, 10, undefined), { start: 0, above: 0, below: 30 })
})

test('a long settings list scrolls to the cursor and says how many lines are above and below', () => {
  const settings = Array.from({ length: 30 }, (_, i) => ({ ns: `ns-${i}`, revision: 1, applies: 'live', writable: false, value: { x: null }, user: undefined, secrets: [] }))
  const { lastFrame, unmount } = render(React.createElement(Panel, {
    state: stateWith({ section: 'settings', settings }),
    width: 60,
    height: 12,
    cursor: 25,
    field: emptyBuffer(),
    editing: undefined,
    pendingPreset: undefined,
  }))
  const frame = lastFrame() ?? ''
  assert.match(frame, /ns-25/, 'the cursor row is on screen')
  assert.match(frame, /arriba/)
  assert.match(frame, /abajo/)
  unmount()
})

/** A keyboard session over the settings section: each press applies to the state the last press left. */
function settingsSession(settings: SettingsRow[], controller: AppController) {
  const state = stateWith({ section: 'settings', settings })
  const store = { field: emptyBuffer(), editing: undefined as string | undefined, cursor: 0, notes: [] as string[] }
  const press = (input: string, key: PanelKeys['key'] = {}): void => {
    handlePanelKey({
      input,
      key,
      state,
      controller,
      field: store.field,
      setField: value => { store.field = value },
      cursor: store.cursor,
      setCursor: value => { store.cursor = typeof value === 'function' ? value(store.cursor) : value },
      pendingPreset: undefined,
      setPendingPreset: () => {},
      editingItem: store.editing,
      setEditingItem: value => { store.editing = value },
    })
  }
  return { press, store }
}

const SETTINGS_ROW: SettingsRow = { ns: 'agent', revision: 4, applies: 'live', writable: true, value: { maxSteps: 40, label: 'a' }, user: { maxSteps: 40 }, secrets: [] }

test('settings: Enter edits a field; a typed number is saved with the revision read', () => {
  const { controller, calls } = fakeController()
  const session = settingsSession([SETTINGS_ROW], controller)
  session.press('', { return: true })
  assert.equal(session.store.editing, 'agent\u0000maxSteps')
  assert.equal(textOf(session.store.field), '40')
  session.press('', { backspace: true })
  session.press('', { backspace: true })
  session.press('5')
  session.press('0')
  session.press('', { return: true })
  assert.equal(session.store.editing, undefined)
  assert.deepEqual(calls.filter(call => call.startsWith('settingAction')), ['settingAction "agent" {"kind":"set","key":"maxSteps","value":50}'])
})

test('settings: a value the type does not allow stays in edit with a note, and sends nothing', () => {
  const { controller, calls } = fakeController()
  const session = settingsSession([SETTINGS_ROW], controller)
  session.press('', { return: true })
  session.press('', { backspace: true })
  session.press('', { backspace: true })
  session.press('x')
  session.press('', { return: true })
  assert.equal(session.store.editing, 'agent\u0000maxSteps', 'the edit stays open')
  assert.ok(calls.some(call => call.startsWith('notePanel') && call.includes('número')))
  assert.equal(calls.some(call => call.startsWith('settingAction')), false)
})

test('settings: u removes only an override the user set; the key is ignored elsewhere', () => {
  const { controller, calls } = fakeController()
  const session = settingsSession([SETTINGS_ROW], controller)
  session.press('u')
  assert.deepEqual(calls.filter(call => call.startsWith('settingAction')), ['settingAction "agent" {"kind":"unset","key":"maxSteps"}'])
  session.press('', { downArrow: true })
  session.press('u')
  assert.equal(calls.filter(call => call.startsWith('settingAction')).length, 1, 'label has no override to remove')
})

test('settings: a read-only namespace refuses edits and whole-section replace', () => {
  const { controller, calls } = fakeController()
  const session = settingsSession([{ ...SETTINGS_ROW, writable: false }], controller)
  session.press('', { return: true })
  session.press('j')
  assert.equal(session.store.editing, undefined)
  assert.ok(calls.some(call => call.startsWith('notePanel') && call.includes('solo lectura')))
})

test('settings: j edits the whole section as JSON, and a section with secrets is refused', () => {
  const { controller, calls } = fakeController()
  const session = settingsSession([SETTINGS_ROW], controller)
  session.press('j')
  assert.equal(session.store.editing, 'agent\u0000*')
  assert.equal(textOf(session.store.field), '{"maxSteps":40}')
  session.press('', { return: true })
  assert.deepEqual(calls.filter(call => call.startsWith('settingAction')), ['settingAction "agent" {"kind":"replace","section":{"maxSteps":40}}'])

  const secretive = settingsSession([{ ...SETTINGS_ROW, secrets: [{ path: ['providers', 'x', 'apiKey'], set: true }] }], controller)
  secretive.press('j')
  assert.equal(secretive.store.editing, undefined)
  assert.ok(calls.some(call => call.startsWith('notePanel') && call.includes('secretos')))
})
