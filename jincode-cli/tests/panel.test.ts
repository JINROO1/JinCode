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
  assert.deepEqual(rows[0], { ns: 'agent', revision: 3, applies: 'next-turn', writable: true, value: { maxSteps: 40 }, user: undefined, secrets: [] })
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
  'agentPresets/list': { presets: [{ id: 'standard', order: 1, isDefault: true }, { id: 'minimal', order: 2, isDefault: false }] },
  'agentPresets/read': { agentPreset: 'minimal', content: '- id: persona\n' },
  'agentPresets/select': 'minimal',
  'subagents/prompt': { messageId: 'm-1' },
  'subagents/interruptByUser': { accepted: true },
  'goals/edit': { id: 'goal-1', revision: 5, objective: 'nuevo', phase: 'active', roundsStarted: 0, maxGoalRounds: 8 },
  'goals/pause': {},
  'goals/resume': {},
  'goals/complete': {},
  'goals/clear': {},
  'schedule/catalog': [{ id: 's1', kind: 'every', title: 'Diario', prompt: 'p', everySeconds: 3600, scheduledAt: '2026-11-20T10:00:00.000Z', target: { kind: 'session', sessionId: 's-1' }, involvedSessionIds: ['s-1'], status: 'active', createdAt: '2026-11-19T10:00:00.000Z', updatedAt: '2026-11-19T10:00:00.000Z' }],
  'schedule/deliveryLimits': { newSessionIntervalSeconds: 60 },
  'schedule/create': { id: 's2', kind: 'every', title: 'Nueva', prompt: 'p', everySeconds: 60, scheduledAt: '2026-11-20T10:00:00.000Z', target: { kind: 'session', sessionId: 's-1' }, involvedSessionIds: ['s-1'], status: 'active', createdAt: '2026-11-19T10:00:00.000Z', updatedAt: '2026-11-19T10:00:00.000Z' },
  'schedule/edit': { id: 's1', code: 'schedule_conflict' },
  'schedule/run': {},
  'schedule/history': { id: 's1', records: [{ scheduledAt: '2026-11-19T10:00:00.000Z', deliveredAt: '2026-11-19T10:00:01.000Z', messageId: 'm', targetSessionId: 's-1', prompt: 'p' }], earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 200 } },
  'schedule/deleteInactive': { deleted: 2 },
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
  await client.editGoal('s-1', goal, 'nuevo objetivo')
  assert.equal(last().method, 'goals/edit')
  assert.deepEqual(last().args, { agentId: 's-1', ref: { id: 'goal-1', revision: 4 }, request: { objective: 'nuevo objetivo' } }, 'the edit names the revision read')
  await client.clearGoal('s-1', goal)
  assert.equal(last().method, 'goals/clear')
  assert.deepEqual(last().args, { agentId: 's-1', ref: { id: 'goal-1', revision: 4 } }, 'clear needs the Session too')
})

test('schedules read every task from the catalog and the delivery limit from its own endpoint', async () => {
  const schedules = await client.schedules()
  assert.equal(last().method, 'schedule/catalog')
  assert.equal(schedules[0]?.title, 'Diario')
  assert.equal(schedules[0]?.timing, 'cada 3600 s')
  assert.equal(await client.scheduleLimit(), 60)
  assert.equal(last().method, 'schedule/deliveryLimits')
})

test('schedule writes send the request the form built, and history asks for a page of 20', async () => {
  await client.createSchedule({ title: 'Nueva', prompt: 'p' })
  assert.equal(last().method, 'schedule/create')
  assert.deepEqual(last().args, { request: { title: 'Nueva', prompt: 'p' } })
  assert.equal(await client.editSchedule({ id: 's1', action: 'delete' }).then(() => 'sent'), 'sent')
  assert.equal(last().method, 'schedule/edit')
  assert.deepEqual(last().args, { request: { id: 's1', action: 'delete' } })
  await client.runSchedule('s1')
  assert.deepEqual(last().args, { request: { id: 's1' } })
  const records = await client.scheduleHistory('s1')
  assert.deepEqual(last().args, { request: { id: 's1', limit: 20 } })
  assert.equal(records[0]?.prompt, 'p')
  assert.equal(await client.clearEndedSchedules(), 2)
  assert.equal(last().method, 'schedule/deleteInactive')
})

test('a subagent message carries a fresh request identity, the delivery and the browser zone; interrupts name the child', async () => {
  const messageId = await client.sendToChild('child-1', 'revisa esto', 'steer')
  assert.equal(messageId, 'm-1')
  assert.equal(last().method, 'subagents/prompt')
  const request = last().args.request as Record<string, unknown>
  assert.match(String(request['requestId']), /^[0-9a-f-]{36}$/, 'the identity is minted by the client')
  assert.deepEqual({ ...request, requestId: undefined }, {
    requestId: undefined,
    childSessionId: 'child-1',
    delivery: 'steer',
    content: [{ type: 'text', text: 'revisa esto' }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  await client.interruptChild('child-1')
  assert.equal(last().method, 'subagents/interruptByUser')
  assert.deepEqual(last().args, { childSessionId: 'child-1' })
})

test('agent presets are read from the roster; the declaration and the selection name the preset', async () => {
  assert.deepEqual(await client.agentPresets(), [{ id: 'standard', isDefault: true }, { id: 'minimal', isDefault: false }])
  assert.equal(last().method, 'agentPresets/list')
  assert.equal(await client.agentPresetYaml('minimal'), '- id: persona\n')
  assert.deepEqual(last().args, { agentPreset: 'minimal' })
  assert.equal(await client.selectAgentPreset('s-1', 'minimal'), 'minimal')
  assert.deepEqual(last().args, { agentId: 's-1', agentPreset: 'minimal' })
})

test('skills are read with their wrapper', async () => {
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
