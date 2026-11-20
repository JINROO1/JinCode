import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { RemoteError } from '../src/wire/remote.ts'
import {
  PanelClient,
  normalizeGoal,
  normalizePresets,
  normalizeQueue,
  normalizeSchedule,
  normalizeSettings,
  normalizeSkills,
} from '../src/app/panel-client.ts'

// ---- Pure normalizers, fed with the shapes the Host returns ----

test('queue rows keep id, placement and the text of the blocks', () => {
  const rows = normalizeQueue({
    queue: [
      { id: 'q1', placement: 'queued', content: [{ type: 'text', text: 'primero' }] },
      { id: 'q2', placement: 'steering', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { id: 'q3', placement: 'weird', content: 'texto plano' },
      { placement: 'queued', content: [] },
      'no es un registro',
    ],
  })
  assert.deepEqual(rows, [
    { id: 'q1', placement: 'queued', text: 'primero' },
    { id: 'q2', placement: 'steering', text: 'a\nb' },
    { id: 'q3', placement: 'queued', text: 'texto plano' },
  ])
})

test('a missing queue reads as empty, never as an error', () => {
  assert.deepEqual(normalizeQueue({ queue: null, pendingInput: [] }), [])
  assert.deepEqual(normalizeQueue(undefined), [])
})

test('presets keep the values in order and the Host default', () => {
  const view = normalizePresets({
    options: [{ value: 'read-only', name: 'read-only' }, { value: 'danger-full-access', name: 'danger-full-access' }, { name: 'sin valor' }],
    defaultPreset: 'danger-full-access',
  })
  assert.deepEqual(view, { options: ['read-only', 'danger-full-access'], defaultPreset: 'danger-full-access' })
  assert.deepEqual(normalizePresets(null), { options: [], defaultPreset: undefined })
})

test('settings take writable from the document and skip unnamed namespaces', () => {
  const rows = normalizeSettings({
    writable: true,
    namespaces: [
      { ns: 'agent', revision: 3, applies: 'next-turn', value: { maxSteps: 40 } },
      { revision: 1 },
      { ns: 'web', applies: 'restart', value: null },
    ],
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { ns: 'agent', revision: 3, applies: 'next-turn', writable: true, value: { maxSteps: 40 } })
  assert.equal(rows[1]?.revision, 0, 'a missing revision reads as 0')
  assert.equal(rows[1]?.applies, 'restart')
})

test('a goal needs an id and a revision; a null answer means no goal', () => {
  assert.equal(normalizeGoal(null), undefined)
  assert.equal(normalizeGoal({ objective: 'sin id' }), undefined)
  assert.deepEqual(normalizeGoal({
    id: 'goal-1', revision: 2, objective: 'probar', phase: 'paused', roundsStarted: 3, maxGoalRounds: 256, activation: 'armed',
  }), { id: 'goal-1', revision: 2, objective: 'probar', phase: 'paused', roundsStarted: 3, maxGoalRounds: 256 })
})

test('schedule titles fall back to the id and missing statuses to unknown', () => {
  const rows = normalizeSchedule({ items: [{ id: 's1', title: '', status: 'active' }, { id: 's2' }], shown: 2, total: 2 })
  assert.deepEqual(rows, [{ id: 's1', title: 's1', status: 'active' }, { id: 's2', title: 's2', status: 'unknown' }])
  assert.deepEqual(normalizeSchedule({ items: [] }), [])
})

test('skills keep their descriptions, which may be empty', () => {
  assert.deepEqual(normalizeSkills({ skills: [{ name: 'pdf', path: '/x', description: 'Lee PDF' }, { name: 'raw' }] }), [
    { name: 'pdf', description: 'Lee PDF' },
    { name: 'raw', description: '' },
  ])
  assert.deepEqual(normalizeSkills({}), [])
})

// ---- PanelClient against a fake Host that records each request ----

interface Recorded { method: string; args: Record<string, unknown> }
const recorded: Recorded[] = []
let failNext: string | undefined
let server: Server
let client: PanelClient

const replies: Record<string, unknown> = {
  'session/state': { queue: [{ id: 'q1', placement: 'queued', content: [{ type: 'text', text: 'hola' }] }], pendingInput: [] },
  'permissionPresets/catalog': { options: [{ value: 'read-only' }, { value: 'danger-full-access' }], defaultPreset: 'danger-full-access' },
  'permissionPresets/set': { currentValue: 'read-only' },
  'settings/describe': { writable: false, namespaces: [{ ns: 'agent', revision: 1, applies: 'next-turn', value: {} }] },
  'goals/get': { id: 'goal-1', revision: 4, objective: 'x', phase: 'active', roundsStarted: 0, maxGoalRounds: 8 },
  'goals/create': { ref: { id: 'goal-2', revision: 1 } },
  'goals/pause': {},
  'goals/resume': {},
  'goals/complete': {},
  'goals/clear': {},
  'schedule/list': { items: [{ id: 's1', title: 'Diario', status: 'active' }], shown: 1, total: 1 },
  'skills/list': { skills: [{ name: 'pdf', description: 'Lee PDF' }] },
  'session/updateQueue': {},
}

before(async () => {
  server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as { rpcId: string; method: string; payload: { args: Record<string, unknown> } }
    const method = body.method
    const args = body.payload.args
    recorded.push({ method, args })
    let result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
    if (failNext === method) {
      failNext = undefined
      result = { ok: false, error: { code: 'gateway/input-invalid', message: `fallo simulado en ${method}` } }
    } else {
      result = { ok: true, value: replies[method] ?? {} }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  client = new PanelClient({ origin: `http://127.0.0.1:${port}`, cookie: 'dsh-auth-t=v2.k' })
})

after(() => {
  server.close()
})

function last(): Recorded {
  const item = recorded[recorded.length - 1]
  assert.ok(item, 'no request was recorded')
  return item
}

test('the queue is read from session/state with the request wrapper', async () => {
  const rows = await client.queue('s-1')
  assert.equal(last().method, 'session/state')
  assert.deepEqual(last().args, { request: { sessionId: 's-1' } })
  assert.deepEqual(rows, [{ id: 'q1', placement: 'queued', text: 'hola' }])
})

test('steer and remove send their kind; edit sends the text as a content block', async () => {
  await client.updateQueue('s-1', 'q1', { kind: 'steer' })
  assert.deepEqual(last().args, { request: { sessionId: 's-1', itemId: 'q1', action: { kind: 'steer' } } })
  await client.updateQueue('s-1', 'q1', { kind: 'remove' })
  assert.deepEqual(last().args, { request: { sessionId: 's-1', itemId: 'q1', action: { kind: 'remove' } } })
  await client.updateQueue('s-1', 'q1', { kind: 'edit', text: 'nuevo' })
  assert.deepEqual(last().args, {
    request: { sessionId: 's-1', itemId: 'q1', action: { kind: 'edit', content: [{ type: 'text', text: 'nuevo' }] } },
  })
})

test('presets are read from the catalog and set per Session', async () => {
  const view = await client.presets()
  assert.equal(last().method, 'permissionPresets/catalog')
  assert.deepEqual(view.options, ['read-only', 'danger-full-access'])
  await client.setPreset('s-1', 'read-only')
  assert.equal(last().method, 'permissionPresets/set')
  assert.deepEqual(last().args, { request: { sessionId: 's-1', preset: 'read-only' } })
})

test('settings are read-only in this client: only describe is called', async () => {
  const rows = await client.settings()
  assert.equal(last().method, 'settings/describe')
  assert.equal(rows[0]?.writable, false)
  assert.ok(!recorded.some(item => item.method === 'settings/update'))
})

test('goal reads, creation and transitions pass the Session and the revision', async () => {
  const goal = await client.goal('s-1')
  assert.equal(last().method, 'goals/get')
  assert.deepEqual(last().args, { agentId: 's-1' })
  assert.equal(goal?.revision, 4)
  await client.createGoal('s-1', 'terminar')
  assert.deepEqual(last().args, { agentId: 's-1', request: { objective: 'terminar' } })
  assert.ok(goal !== undefined)
  await client.goalAction('s-1', goal, 'pause')
  assert.equal(last().method, 'goals/pause')
  assert.deepEqual(last().args, { agentId: 's-1', ref: { id: 'goal-1', revision: 4 } })
  await client.goalAction('s-1', goal, 'resume')
  assert.equal(last().method, 'goals/resume')
  await client.goalAction('s-1', goal, 'complete')
  assert.equal(last().method, 'goals/complete')
  await client.clearGoal('s-1', goal)
  assert.equal(last().method, 'goals/clear')
  assert.deepEqual(last().args, { agentId: 's-1', ref: { id: 'goal-1', revision: 4 } }, 'clear needs the Session too')
})

test('schedules and skills are read with their wrappers', async () => {
  const schedules = await client.schedules()
  assert.equal(last().method, 'schedule/list')
  assert.deepEqual(schedules, [{ id: 's1', title: 'Diario', status: 'active' }])
  const skills = await client.skills('s-1')
  assert.equal(last().method, 'skills/list')
  assert.deepEqual(last().args, { request: { sessionId: 's-1' } })
  assert.deepEqual(skills, [{ name: 'pdf', description: 'Lee PDF' }])
})

test('a refused call surfaces as a RemoteError with the Host message', async () => {
  failNext = 'permissionPresets/set'
  await assert.rejects(client.setPreset('s-1', 'read-only'), (error: unknown) => {
    assert.ok(error instanceof RemoteError)
    assert.match(String(error.message), /fallo simulado/)
    return true
  })
})
