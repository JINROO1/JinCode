import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render } from 'ink-testing-library'
import { Panel, bodyWindow, panelRowCount, panelSelection } from '../src/ui/Panel.tsx'
import { handlePanelKey, type PanelKeys } from '../src/ui/panel-keys.ts'
import { cellWidth } from '../src/ui/layout.ts'
import { emptyBuffer, bufferOf, textOf, type Buffer } from '../src/ui/composer.ts'
import type { AppController, AppState, PanelState } from '../src/app/controller.ts'
import type { SettingsRow } from '../src/app/panel-client.ts'
import type { ScheduleTask } from '../src/app/schedule-model.ts'
import { emptyScheduleForm } from '../src/app/schedule-model.ts'
import type { ScheduleEditor } from '../src/ui/panel-keys.ts'
import type { KeyLike } from '../src/ui/keys.ts'

// A snapshot with only the fields the panel reads; the rest is never touched.
function stateWith(panel: Partial<PanelState>, extra: Partial<AppState> = {}): AppState {
  const base: PanelState = {
    section: 'queue',
    queue: undefined,
    presets: undefined,
    settings: undefined,
    workspaces: undefined,
    files: undefined,
    terminals: undefined,
    goal: undefined,
    subagentDelivery: 'queue',
    agentPresets: undefined,
    agentYaml: undefined,
    plugins: undefined,
    pluginInspect: undefined,
    mcp: undefined,
    mcpError: undefined,
    mcpProbe: undefined,
    schedules: undefined,
    scheduleLimit: undefined,
    scheduleHistory: undefined,
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

// A scheduled task with every field the Host sends; the test overrides what it reads.
function scheduleTask(over: Partial<ScheduleTask> & { id: string; title: string; status: string }): ScheduleTask {
  return { prompt: 'p', kind: 'every', timing: 'cada 3600 s', timingText: 'every 3600', scheduledAt: undefined, target: { kind: 'session', sessionId: 's-1' }, involvedSessionIds: [], updatedAt: '2026-11-19T10:00:00.000Z', executing: false, ...over }
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
    scheduleEditor: undefined, setScheduleEditor: () => {}, armed: undefined, setArmed: () => {}, setEditingItem: value => { store.editing = value },
    ...overrides,
  }
}

test('every line of every section fits the width it was laid out for', () => {
  const long = 'palabra '.repeat(40) + 'supercalifragilisticoespialidosoxxxxxxxxxxxxxxxxxxxxxxxxxx'
  const sections: Array<Partial<PanelState>> = [
    { section: 'queue', queue: [{ id: 'q', placement: 'queued', text: long }] },
    { section: 'terminals', terminals: { sessionId: 's-1', items: [{ id: 't', title: long, shell: { path: '/bin/bash', args: [], name: 'bash' }, cwd: long, cols: 80, rows: 24, state: 'failed', exitCode: undefined, error: long, origin: 'agent', control: 'agent', sandboxMode: 'read-only' }], environment: undefined, shells: undefined, choosing: false } },
    { section: 'permissions', presets: { options: ['read-only', 'danger-full-access'], defaultPreset: 'danger-full-access' } },
    { section: 'settings', settings: [{ ns: 'agent', revision: 1, applies: 'next-turn', writable: false, value: { long }, user: undefined, secrets: [] }] },
    { section: 'goals', goal: { id: 'g', revision: 1, objective: long, phase: 'active', roundsStarted: 1, maxGoalRounds: 8 } },
    { section: 'schedule', schedules: [scheduleTask({ id: 's', title: long, status: 'active' })] },
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
    scheduleEditor: undefined, setScheduleEditor: () => {}, armed: undefined, setArmed: () => {}, setEditingItem: value => { edited = value },
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
    scheduleEditor: undefined, setScheduleEditor: () => {}, armed: undefined, setArmed: () => {}, setEditingItem: value => { editing = value },
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
  handlePanelKey(keysFor(stateWith({ section: 'subagents' }), controller, { key: { tab: true } }))
  handlePanelKey(keysFor(stateWith({ section: 'queue', queue: [] }), controller, { key: { tab: true, shift: true } }))
  assert.deepEqual(calls, ['setSection "agents"', 'setSection "queue"', 'setSection "subagents"'], 'the last section wraps to the first, and back')
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
      scheduleEditor: undefined, setScheduleEditor: () => {}, armed: undefined, setArmed: () => {}, setEditingItem: value => { store.editing = value },
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

test('workspaces: n creates (blank path = default); x needs a second press; p and a act on the Session row', () => {
  const view = { items: [{ workspaceId: 'ws-a', path: '/tmp/a', title: 'Alfa', sessionIds: ['s-1'] }], archivedSessionIds: [], pinnedSessionIds: [] }
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'workspaces', workspaces: view as never })
  const store = { field: emptyBuffer(), editing: undefined as string | undefined, cursor: 0, pending: undefined as string | undefined }
  const press = (input: string, key: PanelKeys['key'] = {}): void => {
    handlePanelKey({
      input, key, state, controller,
      field: store.field, setField: value => { store.field = value },
      cursor: store.cursor, setCursor: value => { store.cursor = typeof value === 'function' ? value(store.cursor) : value },
      pendingPreset: store.pending, setPendingPreset: value => { store.pending = value },
      editingItem: store.editing, scheduleEditor: undefined, setScheduleEditor: () => {}, armed: undefined, setArmed: () => {}, setEditingItem: value => { store.editing = value },
    })
  }
  press('n')
  assert.equal(store.editing, 'create')
  press('', { return: true })
  assert.ok(calls.some(call => call === 'workspaceAction {"kind":"create","path":""}'), 'a blank path asks for the default Workspace')

  store.cursor = 0
  press('x')
  assert.equal(store.pending, 'delete:ws-a', 'the first x only asks')
  assert.equal(calls.some(call => call.startsWith('workspaceAction {"kind":"delete"')), false)
  press('x')
  assert.ok(calls.some(call => call === 'workspaceAction {"kind":"delete","workspaceId":"ws-a"}'))

  store.cursor = 1
  press('p')
  assert.ok(calls.some(call => call === 'workspaceAction {"kind":"pin","sessionId":"s-1","pinned":true}'))
  press('a')
  assert.ok(calls.some(call => call === 'workspaceAction {"kind":"archive","sessionId":"s-1","archived":true}'))
})

test('files: Enter opens a folder, Backspace goes up, / searches; in a page, [ ] turn pages and Backspace closes it', () => {
  const entries = [{ name: 'src', type: 'directory' as const, size: undefined }, { name: 'a.md', type: 'file' as const, size: 10 }]
  const { controller, calls } = fakeController()
  const state = stateWith({ section: 'files', files: { sessionId: 's-1', path: '', entries, page: undefined, matches: undefined } as never })
  const store = { field: emptyBuffer(), editing: undefined as string | undefined, cursor: 0 }
  const press = (input: string, key: PanelKeys['key'] = {}): void => {
    handlePanelKey({
      input, key, state, controller,
      field: store.field, setField: value => { store.field = value },
      cursor: store.cursor, setCursor: value => { store.cursor = typeof value === 'function' ? value(store.cursor) : value },
      pendingPreset: undefined, setPendingPreset: () => {},
      editingItem: store.editing, scheduleEditor: undefined, setScheduleEditor: () => {}, armed: undefined, setArmed: () => {}, setEditingItem: value => { store.editing = value },
    })
  }
  press('', { return: true })
  assert.ok(calls.includes('browseFiles "src"'), 'Enter on a folder lists it')
  press('', { backspace: true })
  assert.ok(calls.includes('upFiles'), 'Backspace goes up')
  press('/')
  assert.equal(store.editing, 'search')
  press('a')
  press('', { return: true })
  assert.ok(calls.includes('searchFiles "a"'))
  assert.equal(store.editing, undefined)

  const paged = stateWith({ section: 'files', files: { sessionId: 's-1', path: '', entries, page: { path: 'a.md', offset: 1, lines: 1, eof: false, text: 'x' }, matches: undefined } as never })
  const pagedPress = (input: string, key: PanelKeys['key'] = {}): void => {
    handlePanelKey({
      input, key, state: paged, controller,
      field: store.field, setField: () => {}, cursor: 0, setCursor: () => {},
      pendingPreset: undefined, setPendingPreset: () => {},
      editingItem: undefined, scheduleEditor: undefined, setScheduleEditor: () => {}, armed: undefined, setArmed: () => {}, setEditingItem: () => {},
    })
  }
  pagedPress(']')
  assert.ok(calls.includes('pageFile 1'))
  pagedPress('', { backspace: true })
  assert.ok(calls.includes('closeFileView'))
})

test('terminals: Enter opens, n chooses a shell, r renames, x closes; the chooser starts with Enter and Esc cancels', () => {
  const info = { id: 't-1', title: 'Build', shell: { path: '/bin/bash', args: [], name: 'bash' }, cwd: '/w', cols: 80, rows: 24, state: 'running' as const, exitCode: undefined, error: undefined, origin: 'user' as const, control: 'user' as const, sandboxMode: undefined }
  const shells = [{ path: '/bin/bash', args: [], name: 'bash' }, { path: '/bin/zsh', args: [], name: 'zsh' }]
  const base = { section: 'terminals' as const, terminals: { sessionId: 's-1', items: [info], environment: undefined, shells: undefined, choosing: false } }
  const state = stateWith(base, { activeId: 's-1' })
  const { controller, calls } = fakeController()
  handlePanelKey(keysFor(state, controller, { key: { return: true } }))
  assert.ok(calls.includes('attachTerminal "t-1"'), 'Enter attaches the selected terminal')
  calls.length = 0
  handlePanelKey(keysFor(state, controller, { input: 'n' }))
  assert.ok(calls.includes('openTerminalChoice'))
  calls.length = 0
  handlePanelKey(keysFor(state, controller, { input: 'x' }))
  assert.ok(calls.includes('closeTerminal "t-1"'))

  const renaming = keysFor(state, controller, { input: 'r' })
  handlePanelKey(renaming)
  assert.equal(renaming.setEditingItem.length, 1)
  const store = { editing: 'rename' as string | undefined, field: bufferOf('Build') }
  const typed = (overrides: Partial<PanelKeys>) => keysFor(state, controller, { editingItem: store.editing, field: store.field, scheduleEditor: undefined, setScheduleEditor: () => {}, armed: undefined, setArmed: () => {}, setEditingItem: value => { store.editing = value }, setField: value => { store.field = value }, ...overrides })
  handlePanelKey(typed({ input: '!', key: {} }))
  assert.equal(textOf(store.field), 'Build!')
  calls.length = 0
  handlePanelKey(typed({ key: { return: true } }))
  assert.ok(calls.includes('renameTerminal "t-1" "Build!"'), 'Enter saves the new name')
  assert.equal(store.editing, undefined)

  const chooser = stateWith({ ...base, terminals: { ...base.terminals, shells, choosing: true } }, { activeId: 's-1' })
  calls.length = 0
  handlePanelKey(keysFor(chooser, controller, { input: 'n' }))
  assert.equal(calls.length, 0, 'the chooser ignores the keys of the list')
  const down = keysFor(chooser, controller, { key: { downArrow: true } })
  handlePanelKey(down)
  handlePanelKey(keysFor(chooser, controller, { key: { return: true }, cursor: 1 }))
  assert.ok(calls.includes('startTerminal "/bin/zsh"'), 'Enter starts the shell under the cursor')
})

// Keys with a small store behind the setters, so one test can press several keys in a row.
function scheduleHarness(state: AppState, controller: AppController) {
  const store: { field: Buffer; editor: ScheduleEditor | undefined; armed: string | undefined; editing: string | undefined } = { field: emptyBuffer(), editor: undefined, armed: undefined, editing: undefined }
  const press = (input: string, key: KeyLike = {}): void => {
    handlePanelKey(keysFor(state, controller, {
      input,
      key,
      field: store.field,
      setField: value => { store.field = value },
      editingItem: store.editing,
      setEditingItem: value => { store.editing = value },
      scheduleEditor: store.editor,
      setScheduleEditor: value => { store.editor = value },
      armed: store.armed,
      setArmed: value => { store.armed = value },
    }))
  }
  const type = (text: string): void => {
    for (const char of text) press(char)
  }
  return { store, press, type }
}

test('schedules: the list shows each task with its state and timing; the form names its fields', () => {
  const task = scheduleTask({ id: 's1', title: 'Diario', status: 'paused' })
  const list = render(React.createElement(Panel, {
    state: stateWith({ section: 'schedule', schedules: [task], scheduleLimit: 60, scheduleHistory: { id: 's1', records: [{ scheduledAt: '2026-11-19T10:00:00.000Z', deliveredAt: '2026-11-19T10:00:01.000Z', targetSessionId: 's-1', prompt: 'p' }] } }),
    width: 100, height: 24, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined,
  }))
  const frame = list.lastFrame() ?? ''
  assert.match(frame, /Diario · pausada/)
  assert.match(frame, /cada 3600 s/)
  assert.match(frame, /al menos cada 60 s/)
  assert.match(frame, /2026-11-19 10:00 · p/, 'the selected task shows its deliveries')
  list.unmount()

  const empty = render(React.createElement(Panel, {
    state: stateWith({ section: 'schedule', schedules: [] }), width: 100, height: 12, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined,
  }))
  assert.match(empty.lastFrame() ?? '', /No hay tareas programadas\. Pulsa n para crear una\./)
  empty.unmount()

  const form = render(React.createElement(Panel, {
    state: stateWith({ section: 'schedule', schedules: [task] }),
    width: 100, height: 24, cursor: 0, field: bufferOf('Resumen'),
    editing: undefined, pendingPreset: undefined,
    schedule: { form: { ...emptyScheduleForm(true), title: '' }, index: 0 },
  }))
  const shown = form.lastFrame() ?? ''
  assert.match(shown, /Nueva programación/)
  assert.match(shown, /› Título: Resumen▌/)
  assert.match(shown, /Cuándo: every 3600/)
  assert.match(shown, /Destino: sesión actual/)
  assert.match(shown, /after 600/, 'the timing forms are shown')
  form.unmount()
})

test('schedules: n opens an empty form; Enter reports a blank title and sends nothing', () => {
  const { controller, calls } = fakeController()
  const harness = scheduleHarness(stateWith({ section: 'schedule', schedules: [] }), controller)
  harness.press('n')
  assert.equal(harness.store.editor?.form.mode, 'create')
  assert.equal(harness.store.editor?.form.target, 'sesión actual')
  harness.press('', { return: true })
  assert.deepEqual(calls, ['notePanel "el título no puede estar vacío"'])
  assert.equal(harness.store.editor !== undefined, true, 'the form stays open with its text')
})

test('schedules: a typed form is saved with the request the form built, moving between fields with the arrows', () => {
  const { controller, calls } = fakeController()
  const harness = scheduleHarness(stateWith({ section: 'schedule', schedules: [] }), controller)
  harness.press('n')
  harness.type('Resumen')
  harness.press('', { downArrow: true })
  assert.equal(harness.store.editor?.index, 1)
  harness.type('hola')
  harness.press('', { return: true })
  assert.equal(calls.at(-1), 'saveSchedule {"title":"Resumen","prompt":"hola","timing":{"kind":"every","every_seconds":3600},"target":{"kind":"session","sessionId":"s-1"}} false')
})

test('schedules: x asks twice before deleting, and any other key drops the question', () => {
  const { controller, calls } = fakeController()
  const task = scheduleTask({ id: 's1', title: 'Diario', status: 'active' })
  const harness = scheduleHarness(stateWith({ section: 'schedule', schedules: [task] }), controller)
  harness.press('x')
  assert.equal(harness.store.armed, 'delete:s1')
  assert.deepEqual(calls, ['notePanel "pulsa x otra vez para eliminar «Diario»"'])
  harness.press('p')
  assert.equal(harness.store.armed, undefined, 'another key drops the question')
  assert.equal(calls.at(-1)?.startsWith('toggleSchedule'), true, 'p still acts on the task under the cursor')
  harness.press('x')
  harness.press('x')
  assert.equal(calls.at(-1)?.startsWith('deleteSchedule'), true)
})

test('schedules: c asks twice before removing the ended ones; p, r and h act on the task under the cursor', () => {
  const { controller, calls } = fakeController()
  const task = scheduleTask({ id: 's1', title: 'Diario', status: 'paused' })
  const harness = scheduleHarness(stateWith({ section: 'schedule', schedules: [task] }), controller)
  harness.press('c')
  assert.equal(calls.some(call => call.startsWith('clearEndedSchedules')), false, 'the first c only asks')
  harness.press('c')
  assert.equal(calls.some(call => call.startsWith('clearEndedSchedules')), true)
  harness.press('r')
  harness.press('h')
  assert.equal(calls.filter(call => call.startsWith('runSchedule')).length, 1)
  assert.equal(calls.filter(call => call.startsWith('loadScheduleHistory')).length, 1)
})

test('subagents: Enter opens the child or sends the typed message; Ctrl+X interrupts and Ctrl+D switches the delivery', () => {
  const { controller, calls } = fakeController()
  const child = { sessionId: 's-child', updatedAt: 1, running: true, blank: false, cwd: '/tmp', parentSessionId: 's-1', title: 'Revisor' }
  const state = stateWith({ section: 'subagents' }, { sessions: [{ ...child }] as any })
  const harness = scheduleHarness(state, controller)
  harness.press('', { return: true })
  assert.ok(calls.includes('openFromList "s-child"'), 'Enter on an empty message opens the child')
  harness.type('hola')
  harness.press('', { return: true })
  assert.equal(calls.at(-1), 'sendToChild "s-child" "hola"')
  harness.press('x', { ctrl: true })
  assert.equal(calls.at(-1), 'interruptChild "s-child"')
  harness.press('d', { ctrl: true })
  assert.equal(calls.at(-1), 'toggleSubagentDelivery')
  harness.type('i')
  assert.equal(calls.filter(call => call.startsWith('interruptChild')).length, 1, 'a typed letter never interrupts')
})

test('subagents: the list names each child with its state, and says when there are none', () => {
  const child = { sessionId: 's-child', updatedAt: 1, running: false, blank: false, cwd: '/tmp', parentSessionId: 's-1', title: 'Revisor' }
  const full = render(React.createElement(Panel, {
    state: stateWith({ section: 'subagents', subagentDelivery: 'steer' }, { sessions: [child as any] }),
    width: 100, height: 20, cursor: 0, field: bufferOf('uno'), editing: undefined, pendingPreset: undefined,
  }))
  const shown = full.lastFrame() ?? ''
  assert.match(shown, /› Revisor · inactivo/)
  assert.match(shown, /Entrega: dirigir al paso en curso/)
  assert.match(shown, /Mensaje: uno▌/)
  full.unmount()
  const none = render(React.createElement(Panel, {
    state: stateWith({ section: 'subagents' }), width: 100, height: 12, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined,
  }))
  assert.match(none.lastFrame() ?? '', /Esta sesión no tiene subagentes\./)
  none.unmount()
})

const pluginPanel = (extra: Partial<PanelState> = {}): Partial<PanelState> => ({
  section: 'plugins',
  plugins: {
    plugins: [{ id: 'core', title: 'Núcleo', enabled: true, readOnly: undefined }, { id: 'ext', title: 'Extension', enabled: false, readOnly: 'management-required' }],
    bundles: [{ name: 'dsh-base', version: '1.2.0', description: 'Base del perfil', enabled: true, installed: true, removable: false, readOnly: 'unaddressable' }, { name: 'extra', version: '0.1.0', description: '', enabled: true, installed: true, removable: true, readOnly: undefined }],
  },
  ...extra,
})

test('plugins: the rows show their state; a read-only one says why; a bundle shows its version and description', () => {
  const frame = render(React.createElement(Panel, {
    state: stateWith(pluginPanel()), width: 100, height: 40, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined,
  }))
  const shown = frame.lastFrame() ?? ''
  assert.match(shown, /› \[x\] dsh-base@1\.2\.0 · instalado · activo · solo lectura/)
  assert.match(shown, /Base del perfil/)
  assert.match(shown, /\[x\] Núcleo/)
  assert.match(shown, /\[ \] Extension · solo lectura/)
  assert.match(shown, /Paquete a inspeccionar o instalar:/)
  frame.unmount()
  const moved = render(React.createElement(Panel, {
    state: stateWith(pluginPanel()), width: 100, height: 40, cursor: 3, field: emptyBuffer(), editing: undefined, pendingPreset: undefined,
  }))
  assert.match(moved.lastFrame() ?? '', /Motivo: lo gestiona el propio gestor de plugins/)
  moved.unmount()
})

const mcpRows = [
  { name: 'echo', configured: true, state: 'connected', label: 'conectado · 1 herramienta', tone: 'success' as const, detail: undefined, authorization: undefined },
  { name: 'roto', configured: true, state: 'reconnecting', label: 'reconectando (intento 2 de 10)', tone: 'warning' as const, detail: 'spawn /no/such ENOENT', authorization: 'esperando el navegador del Host · abre https://auth.example/x' },
]

test('mcp: the rows show their status, the error and the authorization; the last probe is named', () => {
  const frame = render(React.createElement(Panel, {
    state: stateWith({ section: 'mcp', mcp: mcpRows, mcpProbe: { name: 'roto', ok: false, text: 'falló en la conexión: spawn ENOENT' } }),
    width: 100, height: 40, cursor: 1, field: emptyBuffer(), editing: undefined, pendingPreset: undefined,
  }))
  const shown = frame.lastFrame() ?? ''
  assert.match(shown, /echo · conectado · 1 herramienta/)
  assert.match(shown, /› roto · reconectando \(intento 2 de 10\)/)
  assert.match(shown, /spawn \/no\/such ENOENT/)
  assert.match(shown, /autorización: esperando el navegador del Host/)
  assert.match(shown, /Último sondeo de roto: falló en la conexión: spawn ENOENT/)
  assert.match(shown, /p sondea el servidor/)
  frame.unmount()
})

test('mcp: before the first list the section says it is connecting, and an unsupported Host says why', () => {
  const waiting = render(React.createElement(Panel, { state: stateWith({ section: 'mcp' }), width: 100, height: 40, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined }))
  assert.match(waiting.lastFrame() ?? '', /Conectando con los servidores MCP/)
  waiting.unmount()
  const missing = render(React.createElement(Panel, { state: stateWith({ section: 'mcp', mcpError: 'no such endpoint: mcpManager/watch' }), width: 100, height: 40, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined }))
  assert.match(missing.lastFrame() ?? '', /Los servidores MCP no están disponibles: no such endpoint/)
  missing.unmount()
  const empty = render(React.createElement(Panel, { state: stateWith({ section: 'mcp', mcp: [] }), width: 100, height: 40, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined }))
  assert.match(empty.lastFrame() ?? '', /No hay servidores MCP configurados/)
  empty.unmount()
})

test('mcp: p probes the server under the cursor and r restarts it; neither needs a second press', () => {
  const { controller, calls } = fakeController()
  const at = (input: string, cursor: number, key: KeyLike = {}) => handlePanelKey(keysFor(stateWith({ section: 'mcp', mcp: mcpRows }), controller, { input, key, cursor }))
  at('p', 1)
  assert.equal(calls.at(-1), 'probeServer "roto"')
  at('r', 0)
  assert.equal(calls.at(-1), 'restartServer "echo"')
  at('x', 0)
  assert.equal(calls.at(-1), 'restartServer "echo"', 'other keys do nothing')
  at('p', 0, { ctrl: true })
  assert.equal(calls.at(-1), 'restartServer "echo"', 'control keys do nothing')
})

test('mcp: the section is reached with Tab and counts its rows for the cursor', () => {
  assert.equal(panelRowCount(stateWith({ section: 'mcp', mcp: mcpRows })), 2)
  assert.equal(panelRowCount(stateWith({ section: 'mcp' })), 0)
})

test('plugins: a long bundle description takes one line and ends with an ellipsis', () => {
  const long = 'Descripción muy larga '.repeat(20)
  const panel = pluginPanel({ plugins: { plugins: [], bundles: [{ name: 'largo', version: '1.0.0', description: long, enabled: true, installed: true, removable: true, readOnly: undefined }] } })
  const frame = render(React.createElement(Panel, { state: stateWith(panel), width: 80, height: 40, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined }))
  const shown = (frame.lastFrame() ?? '').split('\n')
  const line = shown.find(text => text.includes('Descripción muy'))
  assert.ok(line !== undefined && line.includes('…'), 'the description is cut')
  assert.equal(shown.filter(text => text.includes('Descripción')).length, 1, 'it stays on one line')
  frame.unmount()
})

test('plugins: Enter toggles the row under the cursor; with text it inspects, and a second Enter installs an accepted spec', () => {
  const { controller, calls } = fakeController()
  const at = (cursor: number, field = emptyBuffer(), extra: Partial<PanelState> = {}) => keysFor(stateWith(pluginPanel(extra)), controller, { input: '', key: { return: true }, cursor, field })
  handlePanelKey(at(2))
  assert.match(calls.at(-1) ?? '', /^togglePlugin .*"id":"core"/)
  handlePanelKey(at(1))
  assert.match(calls.at(-1) ?? '', /^toggleBundle .*"name":"extra"/)
  handlePanelKey(at(0, bufferOf('nuevo-paquete')))
  assert.equal(calls.at(-1), 'inspectSpec "nuevo-paquete"')
  const accepted = { spec: 'nuevo-paquete', status: 'accepted', name: undefined, version: undefined, reason: undefined }
  handlePanelKey(at(0, bufferOf('nuevo-paquete'), { pluginInspect: accepted }))
  assert.equal(calls.at(-1), 'installSpec "nuevo-paquete"')
  handlePanelKey(at(0, bufferOf('otro'), { pluginInspect: accepted }))
  assert.equal(calls.at(-1), 'inspectSpec "otro"', 'an inspection for another spec does not install')
})

test('plugins: a pending install script is approved by one Enter with the same text; a changed text inspects again', () => {
  const { controller, calls } = fakeController()
  const pending = { spec: 'pkg', phase: 'install' as const, status: 'pendiente de permiso', name: undefined, version: undefined, reason: 'pnpm no ejecutó', pendingBuilds: ['esbuild'] }
  const at = (field = bufferOf('pkg')) => keysFor(stateWith(pluginPanel({ pluginInspect: pending })), controller, { input: '', key: { return: true }, cursor: 0, field })
  handlePanelKey(at())
  assert.equal(calls.at(-1), 'installSpec "pkg" ["esbuild"]')
  handlePanelKey(at(bufferOf('otro')))
  assert.equal(calls.at(-1), 'inspectSpec "otro"', 'a different text is inspected, not approved')
})

test('plugins: an installed result says so and its line names the scripts that wait for approval', () => {
  const frame = render(React.createElement(Panel, {
    state: stateWith(pluginPanel({ pluginInspect: { spec: 'pkg', phase: 'install', status: 'pendiente de permiso', name: undefined, version: undefined, reason: 'pnpm no ejecutó los scripts de instalación de esbuild; Enter, con el mismo texto, los permite para este perfil y vuelve a instalar.', pendingBuilds: ['esbuild'] } })),
    width: 100, height: 40, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined,
  }))
  const shown = frame.lastFrame() ?? ''
  assert.match(shown, /Instalación de pkg: pendiente de permiso/)
  assert.match(shown, /Enter otra vez, con el mismo texto, permite esos scripts y reinstala\./)
  frame.unmount()
})

test('plugins: Ctrl+X asks twice before removing a bundle; a plugin row is never removed', () => {
  const { controller, calls } = fakeController()
  let armed: string | undefined
  const press = (cursor: number): void => {
    handlePanelKey(keysFor(stateWith(pluginPanel()), controller, { input: 'x', key: { ctrl: true }, cursor, armed, setArmed: value => { armed = value } }))
  }
  press(1)
  assert.equal(calls.some(call => call.startsWith('removeBundle')), false, 'the first press only asks')
  assert.equal(armed, 'remove:extra')
  press(1)
  assert.match(calls.at(-1) ?? '', /^removeBundle .*"name":"extra"/)
  press(2)
  press(2)
  assert.equal(calls.some(call => call.startsWith('removeBundle') && call.includes('core')), false, 'a plugin row is not a bundle')
})

test('agents: Enter selects, n opens a new Session with the preset, v shows the declaration', () => {
  const { controller, calls } = fakeController()
  const presets = [{ id: 'standard', isDefault: true }, { id: 'minimal', isDefault: false }]
  const harness = scheduleHarness(stateWith({ section: 'agents', agentPresets: presets }), controller)
  handlePanelKey(keysFor(stateWith({ section: 'agents', agentPresets: presets }), controller, { input: '', key: { return: true }, cursor: 1 }))
  assert.equal(calls.at(-1), 'selectAgentPreset "minimal"')
  const on = (input: string) => handlePanelKey(keysFor(stateWith({ section: 'agents', agentPresets: presets }), controller, { input, key: {}, cursor: 1 }))
  on('n')
  assert.equal(calls.at(-1), 'newSessionWithPreset "minimal"')
  on('v')
  assert.equal(calls.at(-1), 'toggleAgentYaml "minimal"')
})

test('agents: the list marks the default preset, and a long declaration is cut with a count', () => {
  const content = Array.from({ length: 20 }, (_, index) => `- id: line-${index}`).join('\n')
  const frame = render(React.createElement(Panel, {
    state: stateWith({ section: 'agents', agentPresets: [{ id: 'standard', isDefault: true }], agentYaml: { preset: 'standard', content } }),
    width: 100, height: 40, cursor: 0, field: emptyBuffer(), editing: undefined, pendingPreset: undefined,
  }))
  const shown = frame.lastFrame() ?? ''
  assert.match(shown, /› standard · por defecto/)
  assert.match(shown, /Declaración de standard \(20 líneas\):/)
  assert.match(shown, /… 6 líneas más/)
  frame.unmount()
})

test('goals: e edits the objective in place; Enter sends the text, and the goal is not touched until then', () => {
  const { controller, calls } = fakeController()
  const goal = { id: 'g', revision: 2, objective: 'objetivo', phase: 'active', roundsStarted: 0, maxGoalRounds: 8 }
  const harness = scheduleHarness(stateWith({ section: 'goals', goal }), controller)
  harness.press('e')
  assert.equal(harness.store.editing, 'goal')
  assert.equal(textOf(harness.store.field), 'objetivo', 'the field starts with the current objective')
  harness.type('!')
  assert.deepEqual(calls, [], 'typing sends nothing')
  harness.press('', { return: true })
  assert.equal(calls.at(-1), 'editGoal "objetivo!"')
  assert.equal(harness.store.editing, undefined)
})

test('schedules: e opens the form with the task as the Host has it, typed so it parses again', () => {
  const { controller, calls } = fakeController()
  const task = scheduleTask({ id: 's1', title: 'Diario', status: 'paused', timingText: 'daily 09:00:00 UTC', updatedAt: '2026-11-19T10:00:00.000Z' })
  const harness = scheduleHarness(stateWith({ section: 'schedule', schedules: [task] }), controller)
  harness.press('e')
  assert.equal(harness.store.editor?.form.mode, 'edit')
  assert.equal(harness.store.editor?.form.timing, 'daily 09:00:00 UTC')
  assert.equal(harness.store.editor?.form.expectedUpdatedAt, '2026-11-19T10:00:00.000Z')
  assert.equal(textOf(harness.store.field), 'Diario')
  harness.press('', { return: true })
  assert.equal(calls.at(-1)?.startsWith('saveSchedule'), true, 'an unchanged edit is a valid request')
})
