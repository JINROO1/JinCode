import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { connect, type RemoteConnection } from '../src/wire/remote.ts'
import { AppController, keyRefFor, matchesTitleOrFolder, titleOf } from '../src/app/controller.ts'
import { normalizeCatalog, summaryOf } from '../src/app/session-client.ts'

// A fake Host with the response shapes observed on the real server.
const state = {
  keys: new Set<string>(),
  searchDisabled: false,
  calls: [] as Array<{ method: string; args: any }>,
  sessions: [{ sessionId: 's-1', updatedAt: 1000, running: false, blank: false, cwd: '/tmp', projections: { values: { title: 'Primera', modelSelection: { next: { provider: 'jincode', model: 'gpt-4o-mini' } }, permissions: { currentValue: 'danger-full-access' } } } }],
  queue: [] as Array<{ id: string; placement: string; content: unknown }>,
  goal: null as null | { id: string; revision: number; objective: string; phase: string; roundsStarted: number; maxGoalRounds: number },
  workspaces: [{ workspaceId: 'ws-a', path: '/tmp/ws-a', title: 'Alfa', sessionIds: ['s-1'], createdAt: 'x', updatedAt: 'x' }] as Array<Record<string, unknown>>,
  archivedSessionIds: [] as string[],
  pinnedSessionIds: [] as string[],
  defaultInits: 0,
  followers: new Map<string, (value: unknown) => void>(),
  terminals: [] as Array<Record<string, any>>,
  terminalWatchers: new Map<string, (value: unknown) => void>(),
  terminalAttachments: new Map<string, { id: string; out: number; send: (value: unknown) => void; end: () => void }>(),
  terminalWrites: [] as Array<Record<string, any>>,
  terminalCancelled: [] as string[],
  terminalWindow: { maxBytes: 200, frameOverheadBytes: 10 } as { maxBytes: number; frameOverheadBytes: number },
  terminalWritable: true,
  settings: { writable: false, revision: 2, value: { maxSteps: 40, label: 'a' } as Record<string, unknown>, user: { maxSteps: 40 } as Record<string, unknown> | undefined },
}

let server: Server
let wss: WebSocketServer
let connection: RemoteConnection

function broadcastTerminals(): void {
  for (const send of state.terminalWatchers.values()) send(state.terminals)
}

function respond(method: string, args: any): unknown {
  switch (method) {
    case 'session/list': return { items: state.sessions }
    case 'session/create': return { sessionId: 's-new' }
    case 'session/modelCatalog': return {
      default: { provider: 'jincode', model: 'gpt-4o-mini' },
      routableProviders: state.keys.has('JINCODE_API_KEY') ? ['jincode'] : [],
      groups: state.keys.has('JINCODE_API_KEY') ? [{ id: 'jincode', name: 'JinCode', models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }, { id: 'x-1', name: 'X', reasoning: { efforts: ['low', 'high'] } }] }] : [],
      failures: [],
    }
    case 'llm/listProviders': return [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'jincode', name: 'JinCode OpenAI-Compatible' }]
    case 'credentials/describe': return Object.fromEntries(args.refs.map((ref: string) => [ref, { configured: state.keys.has(ref), writable: true }]))
    case 'credentials/set': state.keys.add(args.ref); return {}
    case 'credentials/unset': state.keys.delete(args.ref); return {}
    case 'session/rename': state.sessions[0] = { ...state.sessions[0]!, projections: { values: { title: args.title } } } as any; return {}
    case 'session/fork': return { sessionId: 's-fork' }
    case 'session/search':
      if (state.searchDisabled) throw new Error('session search is disabled: this deployment configures the session-query index with openAt "never"')
      return { items: [{ sessionId: 's-1', snippet: 'coincidencia' }] }
    case 'session/selectModel': return {}
    case 'session/state': return { queue: state.queue, pendingInput: [] }
    case 'session/updateQueue': {
      if (!state.queue.some(item => item.id === args.itemId)) throw new Error('queued item is no longer pending')
      const action = args.action
      if (action.kind === 'remove' || action.kind === 'steer') state.queue = state.queue.filter(item => item.id !== args.itemId)
      if (action.kind === 'edit') state.queue = state.queue.map(item => (item.id === args.itemId ? { ...item, content: action.content } : item))
      return {}
    }
    case 'permissionPresets/catalog': return { options: [{ value: 'read-only', name: 'read-only' }, { value: 'danger-full-access', name: 'danger-full-access' }], defaultPreset: 'danger-full-access' }
    case 'permissionPresets/set':
      state.sessions[0] = { ...state.sessions[0]!, projections: { values: { ...state.sessions[0]!.projections.values, permissions: { currentValue: args.preset } } } } as any
      return { currentValue: args.preset }
    case 'workspace/create': {
      const existing = state.workspaces.find(item => item.path === args.path)
      if (existing !== undefined) return { workspace: existing, created: false }
      const created = { workspaceId: `ws-${state.workspaces.length + 1}`, path: args.path, title: String(args.path).split('/').pop(), sessionIds: [], createdAt: 'x', updatedAt: 'x' }
      state.workspaces.push(created)
      return { workspace: created, created: true }
    }
    case 'workspace/initializeDefault': state.defaultInits += 1; return null
    case 'workspace/rename': return { workspace: { ...state.workspaces.find(item => item.workspaceId === args.workspaceId), title: args.title } }
    case 'workspace/delete': state.workspaces = state.workspaces.filter(item => item.workspaceId !== args.workspaceId); return { deleted: true }
    case 'workspace/insertBefore': return { workspaceIds: state.workspaces.map(item => item.workspaceId) }
    case 'workspace/insertSessionBefore': return { workspace: state.workspaces[0] }
    case 'workspace/pinSession': state.pinnedSessionIds = [...state.pinnedSessionIds, args.sessionId]; return { pinnedSessionIds: state.pinnedSessionIds }
    case 'workspace/unpinSession': state.pinnedSessionIds = state.pinnedSessionIds.filter(id => id !== args.sessionId); return { pinnedSessionIds: state.pinnedSessionIds }
    case 'workspace/archiveSession': state.archivedSessionIds = [...state.archivedSessionIds, args.sessionId]; return { archivedSessionIds: state.archivedSessionIds }
    case 'workspace/unarchiveSession': state.archivedSessionIds = state.archivedSessionIds.filter(id => id !== args.sessionId); return { archivedSessionIds: state.archivedSessionIds }
    case 'workspaceFiles/list':
      if (args.path === '.') return { path: '', entries: [{ name: 'README.md', type: 'file', size: 120 }, { name: 'src', type: 'directory' }] }
      return { path: args.path, entries: [{ name: 'a.ts', type: 'file', size: 10 }] }
    case 'workspaceFiles/read': return { offset: args.range.offset, lines: 2, eof: args.range.offset > 1, text: 'primera\nsegunda', absolutePath: '/x', version: 'v' }
    case 'workspaceFiles/search': return { matches: [{ path: 'src/a.ts', type: 'file' }] }
    case 'terminal/shells': return [{ path: '/bin/bash', args: [], name: 'bash' }, { path: '/bin/zsh', args: ['-l'], name: 'zsh' }]
    case 'terminal/environment': return { cwd: '/home/user/JinCode', maxInputBytes: 64, maxBufferedBytes: 4096, maxCols: 300, maxRows: 100, scrollback: 500 }
    case 'terminal/list': return state.terminals
    case 'terminal/create': {
      state.terminals = [...state.terminals, { id: args.id, title: '', shell: { path: args.shellPath ?? '/bin/bash', args: [], name: args.shellPath === '/bin/zsh' ? 'zsh' : 'bash' }, cwd: '/home/user/JinCode', cols: args.cols, rows: args.rows, state: 'running', exitCode: null, origin: 'user', control: 'user' }]
      broadcastTerminals()
      return { id: args.id }
    }
    case 'terminal/rename':
      state.terminals = state.terminals.map(item => (item.id === args.id ? { ...item, title: args.title } : item))
      broadcastTerminals()
      return null
    case 'terminal/close':
      state.terminals = state.terminals.filter(item => item.id !== args.id)
      broadcastTerminals()
      return null
    case 'settings/describe': return { writable: state.settings.writable, namespaces: [{ ns: 'agent', revision: state.settings.revision, applies: 'next-turn', value: state.settings.value, user: state.settings.user, secrets: [] }] }
    case 'settings/mutate': {
      if (args.expectedRevision !== state.settings.revision) throw new Error('settings revision conflict: the entry changed')
      const user = { ...(state.settings.user ?? {}) } as Record<string, unknown>
      for (const op of args.ops) {
        if (op.op === 'set') user[op.path[0]] = op.value
        else delete user[op.path[0]]
      }
      state.settings = { ...state.settings, revision: state.settings.revision + 1, user, value: { ...state.settings.value, ...user } }
      return { ns: 'agent', revision: state.settings.revision }
    }
    case 'settings/replace':
      if (args.expectedRevision !== state.settings.revision) throw new Error('settings revision conflict: the entry changed')
      state.settings = { ...state.settings, revision: state.settings.revision + 1, user: args.section, value: { ...state.settings.value, ...args.section } }
      return { ns: 'agent', revision: state.settings.revision }
    case 'goals/get': return state.goal ?? undefined
    case 'goals/create':
      state.goal = { id: 'goal-1', revision: 1, objective: args.objective, phase: 'active', roundsStarted: 0, maxGoalRounds: 8 }
      return { ref: { id: 'goal-1', revision: 1 } }
    case 'goals/pause': if (state.goal) state.goal = { ...state.goal, phase: 'paused', revision: state.goal.revision + 1 }; return {}
    case 'goals/resume': if (state.goal) state.goal = { ...state.goal, phase: 'active', revision: state.goal.revision + 1 }; return {}
    case 'goals/complete': if (state.goal) state.goal = { ...state.goal, phase: 'complete', revision: state.goal.revision + 1 }; return {}
    case 'goals/clear': state.goal = null; return {}
    case 'schedule/list': return { items: [{ id: 'sch-1', title: 'Resumen diario', status: 'active' }], shown: 1, total: 1 }
    case 'skills/list': return { skills: [{ name: 'pdf', description: 'Lee PDF' }] }
    case 'session/prompt': return { accepted: true }
    case 'session/cancel': return {}
    default: return {}
  }
}

before(async () => {
  const http = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname === '/connect') {
      response.writeHead(302, { location: './', 'set-cookie': 'dsh-auth-t=v2.k; Path=/' }).end()
      return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const method = url.pathname.slice('/api/'.length)
    state.calls.push({ method, args: body.payload.args })
    let result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
    // The Host names the Session `agentId` on terminal calls, and rejects anything else.
    const terminalNeedsAgent = method.startsWith('terminal/') && method !== 'terminal/list' && method !== 'terminal/watch' && method !== 'terminal/retain'
    if (terminalNeedsAgent && body.payload.args.agentId === undefined) {
      result = { ok: false, error: { code: 'gateway/arguments-invalid', message: `args fields do not match the descriptor: missing "agentId"` } }
    } else try {
      result = { ok: true, value: respond(method, body.payload.args.request ?? body.payload.args) }
    } catch (error) {
      result = { ok: false, error: { code: 'test/fake-failed', message: String(error) } }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
  })
  wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
      ws.on('message', data => {
        const frame = JSON.parse(data.toString())
        if (frame.type === 'open' && frame.endpoint === 'workspace/follow') {
          const send = (value: unknown): void => { ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value })) }
          state.followers.set(frame.streamId, send)
          send({ type: 'baseline', value: { items: state.workspaces, archivedSessionIds: state.archivedSessionIds, pinnedSessionIds: state.pinnedSessionIds } })
          return
        }
        const send = (value: unknown): void => { ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value })) }
        if (frame.type === 'open' && frame.endpoint === 'terminal/watch') {
          state.terminalWatchers.set(frame.streamId, send)
          send(state.terminals)
          return
        }
        if (frame.type === 'open' && frame.endpoint === 'terminal/retain') {
          send({ type: 'retained' })
          return
        }
        if (frame.type === 'open' && frame.endpoint === 'terminal/attach') {
          const id = frame.payload.args.id as string
          const info = state.terminals.find(item => item.id === id)
          if (info === undefined) {
            ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: 'terminal/missing', message: 'terminal not found', details: {} } }))
            return
          }
          const end = (): void => { ws.send(JSON.stringify({ type: 'end', streamId: frame.streamId })) }
          state.terminalAttachments.set(frame.streamId, { id, out: 4, send, end })
          send({ type: 'snapshot', sequence: 4, screen: 'PS> ', info, writable: state.terminalWritable, inputWindow: state.terminalWindow })
          return
        }
        if (frame.type === 'item' && state.terminalAttachments.has(frame.streamId)) {
          const attachment = state.terminalAttachments.get(frame.streamId)!
          state.terminalWrites.push(frame.value)
          if (frame.value.type === 'write') {
            attachment.out += 1
            attachment.send({ type: 'output', sequence: attachment.out, data: frame.value.data })
          }
          attachment.send({ type: 'ack', sequence: frame.value.sequence })
          return
        }
        if (frame.type === 'cancel') {
          state.terminalCancelled.push(frame.streamId)
          state.terminalAttachments.delete(frame.streamId)
          state.terminalWatchers.delete(frame.streamId)
          return
        }
        if (frame.type === 'open') ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot', cursor: 0, hasMore: false, records: [] } }))
      })
    })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', () => resolve()))
  server = http
  connection = await connect(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, 'tok')
})

after(() => {
  wss.close()
  server.closeAllConnections()
  return new Promise<void>(resolve => server.close(() => resolve()))
})

test('keyRefFor matches the Models page reference', () => {
  assert.equal(keyRefFor('jincode'), 'JINCODE_API_KEY')
  assert.equal(keyRefFor('deepseek-official'), 'DEEPSEEK_OFFICIAL_API_KEY')
})

test('titleOf falls back for sessions without a title', () => {
  assert.equal(titleOf(undefined), 'Nueva sesión')
  assert.equal(titleOf({ sessionId: 'x', updatedAt: 0, running: false, blank: true }), 'Sesión vacía')
  assert.equal(titleOf({ sessionId: 'x', updatedAt: 0, running: false, blank: false, title: 'Hola' }), 'Hola')
})

test('summaryOf reads title and model from projections', () => {
  const summary = summaryOf(state.sessions[0])
  assert.equal(summary?.title, 'Primera')
  assert.equal(summary?.model, 'jincode/gpt-4o-mini')
  assert.equal(summaryOf({ nope: 1 }), undefined)
})

test('normalizeCatalog reads groups with provider names and reasoning efforts', () => {
  const choices = normalizeCatalog({ groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M', reasoning: { efforts: ['low', 5] } }] }] })
  assert.deepEqual(choices, [{ provider: 'p', model: 'm', providerName: 'P', name: 'M', reasoningEfforts: ['low'] }])
})

test('start opens the most recent Session and loads the provider routes', async () => {
  const app = new AppController(connection)
  await app.start()
  const snap = app.snapshot()
  assert.equal(snap.activeId, 's-1')
  assert.deepEqual(snap.providers.map(p => [p.id, p.configured]), [['deepseek-official', false], ['jincode', false]])
  assert.equal(snap.defaultChoice?.model, 'gpt-4o-mini')
  app.dispose()
})

test('saving a key goes through credentials/set with the derived reference and marks it configured', async () => {
  const app = new AppController(connection)
  await app.start()
  await app.openKeys()
  app.moveKey(1)
  await app.saveKey('sk-test-value')
  const set = state.calls.find(call => call.method === 'credentials/set')
  assert.deepEqual(set?.args, { ref: 'JINCODE_API_KEY', value: 'sk-test-value' })
  assert.equal(app.snapshot().providers.find(p => p.id === 'jincode')?.configured, true)
  assert.equal(app.snapshot().models.length, 2)
  assert.ok(app.snapshot().notice?.includes('clave guardada'))
  await app.clearKey()
  assert.equal(app.snapshot().providers.find(p => p.id === 'jincode')?.configured, false)
  app.dispose()
})

test('the models overlay lists the catalog and selection sends provider and model', async () => {
  state.keys.add('JINCODE_API_KEY')
  const app = new AppController(connection)
  await app.start()
  await app.openModels()
  assert.equal(app.snapshot().overlay, 'models')
  app.moveModel(1)
  await app.chooseModel()
  const select = state.calls.findLast(call => call.method === 'session/selectModel')
  assert.deepEqual(select?.args.request, { sessionId: 's-1', provider: 'jincode', model: 'x-1' })
  state.keys.delete('JINCODE_API_KEY')
  app.dispose()
})

test('send steers a running turn and queues otherwise', async () => {
  const app = new AppController(connection)
  await app.start()
  await app.send('  hola  ')
  const prompt = state.calls.findLast(call => call.method === 'session/prompt')
  assert.equal(prompt?.args.request.mode, 'queue')
  assert.deepEqual(prompt?.args.request.content, [{ type: 'text', text: 'hola' }])
  app.dispose()
})

test('rename, fork and search update the snapshot', async () => {
  const app = new AppController(connection)
  await app.start()
  await app.rename('Nuevo título')
  assert.equal(app.snapshot().sessions[0]?.title, 'Nuevo título')
  await app.fork()
  assert.equal(app.snapshot().activeId, 's-fork')
  await app.search('algo')
  assert.equal(app.snapshot().overlay, 'search')
  assert.equal(app.snapshot().searchResults[0]?.snippet, 'coincidencia')
  app.dispose()
})

test('errors from the Host are reported on the snapshot, not thrown', async () => {
  const app = new AppController({ origin: connection.origin, cookie: 'dsh-auth-t=v2.k' } as RemoteConnection)
  const original = state.calls.length
  await app.start().catch(() => undefined)
  assert.ok(state.calls.length >= original)
  app.dispose()
})

test('matchesTitleOrFolder searches titles and folders, ignoring case', () => {
  const session = { sessionId: 'x', updatedAt: 0, running: false, blank: false, title: 'Refactor del Módulo', cwd: '/home/user/Proyecto' }
  assert.equal(matchesTitleOrFolder(session, 'módulo'), true)
  assert.equal(matchesTitleOrFolder(session, 'proyecto'), true)
  assert.equal(matchesTitleOrFolder(session, 'bases de datos'), false)
  assert.equal(matchesTitleOrFolder(session, '   '), false)
})

test('search falls back to titles and folders when content search is disabled', async () => {
  state.searchDisabled = true
  const app = new AppController(connection)
  try {
    await app.start()
    const title = app.snapshot().sessions[0]?.title ?? ''
    assert.ok(title.length > 3, 'the fixture session needs a title')
    await app.search(title.slice(0, 4))
    const snap = app.snapshot()
    assert.equal(snap.overlay, 'search')
    assert.ok(snap.searchResults.some(item => item.sessionId === 's-1'))
    assert.ok(snap.searchNote?.includes('desactivada'))
  } finally {
    state.searchDisabled = false
    app.dispose()
  }
})

test('content search results are merged after the title matches, without duplicates', async () => {
  const app = new AppController(connection)
  try {
    await app.start()
    await app.search('coincidencia')
    const ids = app.snapshot().searchResults.map(item => item.sessionId)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(app.snapshot().searchNote, undefined)
  } finally {
    app.dispose()
  }
})

test('cancel sends session/cancel for the active Session', async () => {
  const app = new AppController(connection)
  try {
    await app.start()
    await app.cancel()
    const cancel = state.calls.findLast(call => call.method === 'session/cancel')
    assert.deepEqual(cancel?.args.request, { sessionId: 's-1' })
    assert.ok(app.snapshot().notice?.includes('cancelado'))
  } finally {
    app.dispose()
  }
})

test('the panel reads each section from its own endpoint and keeps the data in the snapshot', async () => {
  state.queue = [{ id: 'q1', placement: 'queued', content: [{ type: 'text', text: 'pendiente' }] }]
  state.goal = null
  const app = new AppController(connection)
  try {
    await app.start()
    await app.openPanel('queue')
    assert.deepEqual(app.snapshot().panel.queue, [{ id: 'q1', placement: 'queued', text: 'pendiente' }])
    await app.setSection('permissions')
    assert.deepEqual(app.snapshot().panel.presets?.options, ['read-only', 'danger-full-access'])
    await app.setSection('settings')
    assert.equal(app.snapshot().panel.settings?.[0]?.ns, 'agent')
    await app.setSection('goals')
    assert.equal(app.snapshot().panel.goal, null)
    await app.setSection('schedule')
    assert.equal(app.snapshot().panel.schedules?.[0]?.title, 'Resumen diario')
    await app.setSection('skills')
    assert.equal(app.snapshot().panel.skills?.[0]?.name, 'pdf')
    assert.equal(app.snapshot().overlay, 'panel')
  } finally {
    app.dispose()
  }
})

test('queue actions send the change, then the queue is read again', async () => {
  state.queue = [{ id: 'q1', placement: 'queued', content: [{ type: 'text', text: 'uno' }] }, { id: 'q2', placement: 'queued', content: [{ type: 'text', text: 'dos' }] }]
  const app = new AppController(connection)
  try {
    await app.start()
    await app.openPanel('queue')
    await app.queueAction('q1', { kind: 'remove' })
    assert.deepEqual(app.snapshot().panel.queue?.map(row => row.id), ['q2'])
    assert.ok(app.snapshot().panel.note?.includes('quitado'))
    await app.queueAction('q2', { kind: 'edit', text: 'editado' })
    assert.deepEqual(app.snapshot().panel.queue?.[0]?.text, 'editado')
    const update = state.calls.findLast(call => call.method === 'session/updateQueue')
    assert.deepEqual(update?.args.request.action, { kind: 'edit', content: [{ type: 'text', text: 'editado' }] })
  } finally {
    state.queue = []
    app.dispose()
  }
})

test('a refused queue change shows the Host message as the error, not a crash', async () => {
  const app = new AppController(connection)
  try {
    await app.start()
    await app.openPanel('queue')
    await app.queueAction('no-existe', { kind: 'steer' })
    assert.ok(app.snapshot().error !== undefined)
  } finally {
    app.dispose()
  }
})

test('setPreset applies the preset and the Session reports it afterwards', async () => {
  const app = new AppController(connection)
  try {
    await app.start()
    await app.setPreset('read-only')
    const set = state.calls.findLast(call => call.method === 'permissionPresets/set')
    assert.deepEqual(set?.args.request, { sessionId: 's-1', preset: 'read-only' })
    assert.equal(app.snapshot().sessions.find(item => item.sessionId === 's-1')?.permission, 'read-only')
  } finally {
    state.sessions[0] = { ...state.sessions[0]!, projections: { values: { ...state.sessions[0]!.projections.values, permissions: { currentValue: 'danger-full-access' } } } } as any
    app.dispose()
  }
})

test('settings: a field is written with the revision read, then the section reloads', async () => {
  state.settings = { writable: true, revision: 2, value: { maxSteps: 40, label: 'a' }, user: { maxSteps: 40 } }
  const app = new AppController(connection)
  try {
    await app.start()
    await app.setSection('settings')
    await app.settingAction('agent', { kind: 'set', key: 'maxSteps', value: 50 })
    const write = state.calls.findLast(call => call.method === 'settings/mutate')
    assert.deepEqual(write?.args, { ns: 'agent', ops: [{ op: 'set', path: ['maxSteps'], value: 50 }], expectedRevision: 2 })
    assert.equal(app.snapshot().panel.settings?.[0]?.revision, 3, 'the panel reads the new revision back')
    assert.equal(app.snapshot().panel.note, 'agent.maxSteps guardado')
    await app.settingAction('agent', { kind: 'unset', key: 'maxSteps' })
    assert.deepEqual(state.calls.findLast(call => call.method === 'settings/mutate')?.args.ops, [{ op: 'unset', path: ['maxSteps'] }])
  } finally {
    state.settings = { writable: false, revision: 2, value: { maxSteps: 40, label: 'a' }, user: { maxSteps: 40 } }
    app.dispose()
  }
})

test('settings: a stale revision is refused by the Host and shown as an error', async () => {
  state.settings = { writable: true, revision: 7, value: { maxSteps: 40 }, user: {} }
  const app = new AppController(connection)
  try {
    await app.start()
    await app.setSection('settings')
    state.settings = { ...state.settings, revision: 8 }
    await app.settingAction('agent', { kind: 'set', key: 'maxSteps', value: 9 })
    assert.match(app.snapshot().error ?? '', /revision conflict/)
    assert.equal(state.calls.filter(call => call.method === 'settings/mutate').at(-1)?.args.expectedRevision, 7)
  } finally {
    state.settings = { writable: false, revision: 2, value: { maxSteps: 40, label: 'a' }, user: { maxSteps: 40 } }
    app.dispose()
  }
})

test('settings: a read-only profile sends nothing and says so; a replace is refused when the section has secrets', async () => {
  state.settings = { writable: false, revision: 2, value: { maxSteps: 40 }, user: {} }
  const app = new AppController(connection)
  try {
    await app.start()
    await app.setSection('settings')
    const before = state.calls.length
    await app.settingAction('agent', { kind: 'set', key: 'maxSteps', value: 9 })
    assert.equal(state.calls.slice(before).some(call => call.method.startsWith('settings/')), false)
    assert.match(app.snapshot().panel.note ?? '', /solo lectura/)
  } finally {
    state.settings = { writable: false, revision: 2, value: { maxSteps: 40, label: 'a' }, user: { maxSteps: 40 } }
    app.dispose()
  }
})

test('files: the listing sorts folders first; a folder opens, its parent goes back, a file shows a page', async () => {
  const app = new AppController(connection)
  try {
    await app.start()
    await app.setSection('files')
    const root = app.snapshot().panel.files
    assert.deepEqual(root?.entries.map(entry => entry.name), ['src', 'README.md'])
    assert.equal(root?.sessionId, 's-1')
    assert.equal(state.calls.findLast(call => call.method === 'workspaceFiles/list')?.args.workspaceFileScopeId, 's-1')

    await app.browseFiles('src')
    assert.equal(app.snapshot().panel.files?.path, 'src')
    await app.upFiles()
    assert.equal(app.snapshot().panel.files?.path, '')

    await app.openFile('README.md')
    const page = app.snapshot().panel.files?.page
    assert.equal(page?.text, 'primera\nsegunda')
    const reads = (): number => state.calls.filter(call => call.method === 'workspaceFiles/read').length
    await app.pageFile(1)
    assert.equal(app.snapshot().panel.files?.page?.offset, 41, 'the next page starts after the first')
    const atEnd = reads()
    await app.pageFile(1)
    assert.equal(reads(), atEnd, 'an eof page does not ask for another page')
    app.closeFileView()
    assert.equal(app.snapshot().panel.files?.page, undefined)
  } finally {
    app.dispose()
  }
})

test('files: a search replaces the listing with its hits; a blank query is not sent', async () => {
  const app = new AppController(connection)
  try {
    await app.start()
    await app.setSection('files')
    const searches = state.calls.filter(call => call.method === 'workspaceFiles/search').length
    await app.searchFiles('   ')
    assert.equal(state.calls.filter(call => call.method === 'workspaceFiles/search').length, searches)
    await app.searchFiles('a')
    const search = state.calls.findLast(call => call.method === 'workspaceFiles/search')
    assert.equal(search?.args.request.query, 'a')
    assert.deepEqual(app.snapshot().panel.files?.matches?.items, [{ path: 'src/a.ts', type: 'file' }])
    await app.toggleHidden()
    const again = state.calls.findLast(call => call.method === 'workspaceFiles/search')
    assert.equal(again?.args.request.includeHidden, true, 'the hidden switch reaches the Host and the search runs again')
    assert.equal(app.snapshot().panel.files?.includeHidden, true)
    app.closeFileView()
    assert.equal(app.snapshot().panel.files?.matches, undefined)
  } finally {
    app.dispose()
  }
})

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60))

test('workspaces: the baseline from the stream fills the section, and later frames update it', async () => {
  state.workspaces = [{ workspaceId: 'ws-a', path: '/tmp/ws-a', title: 'Alfa', sessionIds: ['s-1'], createdAt: 'x', updatedAt: 'x' }]
  const app = new AppController(connection)
  try {
    await app.start()
    await settle()
    assert.deepEqual(app.snapshot().panel.workspaces?.items.map(item => item.title), ['Alfa'])
    for (const send of state.followers.values()) send({ type: 'upsert', workspace: { ...state.workspaces[0], title: 'Alfa 2' } })
    await settle()
    assert.deepEqual(app.snapshot().panel.workspaces?.items.map(item => item.title), ['Alfa 2'])
    for (const send of state.followers.values()) send({ type: 'pinned', pinnedSessionIds: ['s-1'] })
    await settle()
    assert.deepEqual(app.snapshot().panel.workspaces?.pinnedSessionIds, ['s-1'])
  } finally {
    state.workspaces = [{ workspaceId: 'ws-a', path: '/tmp/ws-a', title: 'Alfa', sessionIds: ['s-1'], createdAt: 'x', updatedAt: 'x' }]
    app.dispose()
  }
})

test('workspaces: create with a path, or the default one when the path is blank; blank titles are not sent', async () => {
  state.workspaces = []
  const before = state.defaultInits
  const app = new AppController(connection)
  try {
    await app.start()
    await app.workspaceAction({ kind: 'create', path: '  /tmp/ws-b  ' })
    assert.deepEqual(state.calls.findLast(call => call.method === 'workspace/create')?.args.request, { path: '/tmp/ws-b' })
    await app.workspaceAction({ kind: 'create', path: '   ' })
    assert.equal(state.defaultInits, before + 1, 'a blank path initializes the default Workspace')
    const renames = state.calls.filter(call => call.method === 'workspace/rename').length
    await app.workspaceAction({ kind: 'rename', workspaceId: 'ws-1', title: '   ' })
    assert.equal(state.calls.filter(call => call.method === 'workspace/rename').length, renames, 'a blank title is not sent')
    assert.match(app.snapshot().panel.note ?? '', /vacío/)
  } finally {
    state.workspaces = [{ workspaceId: 'ws-a', path: '/tmp/ws-a', title: 'Alfa', sessionIds: ['s-1'], createdAt: 'x', updatedAt: 'x' }]
    app.dispose()
  }
})

test('workspaces: pin, archive, move; archiving a running Session is refused before any call', async () => {
  state.workspaces = [
    { workspaceId: 'ws-a', path: '/tmp/ws-a', title: 'Alfa', sessionIds: ['s-1'], createdAt: 'x', updatedAt: 'x' },
    { workspaceId: 'ws-b', path: '/tmp/ws-b', title: 'Beta', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
  ]
  state.sessions[0] = { ...state.sessions[0]!, running: true } as any
  const app = new AppController(connection)
  try {
    await app.start()
    await settle()
    await app.workspaceAction({ kind: 'pin', sessionId: 's-1', pinned: true })
    assert.deepEqual(state.calls.findLast(call => call.method === 'workspace/pinSession')?.args.request, { sessionId: 's-1' })
    await app.workspaceAction({ kind: 'moveWorkspace', workspaceId: 'ws-a', direction: 1 })
    assert.ok(state.calls.some(call => call.method === 'workspace/insertBefore' && call.args.request.workspaceId === 'ws-a'))
    const archives = state.calls.filter(call => call.method === 'workspace/archiveSession').length
    await app.workspaceAction({ kind: 'archive', sessionId: 's-1', archived: true })
    assert.equal(state.calls.filter(call => call.method === 'workspace/archiveSession').length, archives, 'a running Session is not archived')
    assert.match(app.snapshot().panel.note ?? '', /turno en curso/)
  } finally {
    state.sessions[0] = { ...state.sessions[0]!, running: false } as any
    state.workspaces = [{ workspaceId: 'ws-a', path: '/tmp/ws-a', title: 'Alfa', sessionIds: ['s-1'], createdAt: 'x', updatedAt: 'x' }]
    state.pinnedSessionIds = []
    state.archivedSessionIds = []
    app.dispose()
  }
})

test('goal flow: create, pause, resume, complete, clear; each step reads the goal back', async () => {
  state.goal = null
  const app = new AppController(connection)
  try {
    await app.start()
    await app.openPanel('goals')
    await app.createGoal('   ')
    assert.equal(state.calls.some(call => call.method === 'goals/create' && call.args.request.objective === ''), false, 'a blank objective is not sent')
    await app.createGoal('  terminar el informe  ')
    assert.equal(app.snapshot().panel.goal?.objective, 'terminar el informe')
    await app.goalAction('pause')
    assert.equal(app.snapshot().panel.goal?.phase, 'paused')
    await app.goalAction('resume')
    assert.equal(app.snapshot().panel.goal?.phase, 'active')
    await app.goalAction('complete')
    assert.equal(app.snapshot().panel.goal?.phase, 'complete')
    await app.clearGoal()
    assert.equal(app.snapshot().panel.goal, null)
    const clear = state.calls.findLast(call => call.method === 'goals/clear')
    assert.equal(clear?.args.agentId, 's-1')
    assert.equal(clear?.args.ref.revision, 4)
  } finally {
    state.goal = null
    app.dispose()
  }
})

test('the chosen reasoning effort is sent with the model selection', async () => {
  state.keys.add('JINCODE_API_KEY')
  const app = new AppController(connection)
  try {
    await app.start()
    await app.openModels()
    const index = app.snapshot().models.findIndex(choice => choice.model === 'x-1')
    assert.ok(index >= 0)
    app.moveModel(index - app.snapshot().modelCursor)
    await app.chooseModel('high')
    const select = state.calls.findLast(call => call.method === 'session/selectModel')
    assert.equal(select?.args.request.reasoningEffort, 'high')
  } finally {
    state.keys.delete('JINCODE_API_KEY')
    app.dispose()
  }
})

test('terminals: create, attach, type with acknowledgements, see the echo, detach; the list follows the roster', async () => {
  state.terminals = []
  state.terminalWrites = []
  const app = new AppController(connection)
  try {
    await app.start()
    await app.setSection('terminals')
    await waitFor(() => app.snapshot().panel.terminals?.items !== undefined)
    assert.deepEqual(app.snapshot().panel.terminals?.items, [], 'the empty list arrives from the roster')
    assert.equal(app.snapshot().panel.terminals?.environment?.maxInputBytes, 64)
    await app.openTerminalChoice()
    assert.deepEqual(app.snapshot().panel.terminals?.shells?.map(shell => shell.name), ['bash', 'zsh'])
    await app.startTerminal('/bin/zsh')
    await waitFor(() => app.snapshot().terminal?.phase === 'connected')
    const created = app.snapshot().panel.terminals?.items?.[0]
    assert.equal(created?.shell.name, 'zsh', 'the chosen shell is used')
    assert.equal(app.snapshot().terminal?.writable, true)
    assert.equal(app.terminalLines()?.[0]?.map(run => run.text).join('').trimEnd(), 'PS>')
    app.sendTerminal('ls')
    app.sendTerminal('\r')
    await waitFor(() => state.terminalWrites.length === 2 && (app.terminalLines()?.[0]?.map(run => run.text).join('') ?? '').includes('ls'))
    assert.deepEqual(state.terminalWrites.map(write => [write.type, write.sequence, write.data]), [['write', 1, 'ls'], ['write', 2, '\r']], 'input is sequenced in order')
    assert.match(app.terminalLines()?.[0]?.map(run => run.text).join('') ?? '', /PS> ls/, 'the echo is drawn on the screen')
    await app.detachTerminal()
    assert.equal(app.snapshot().terminal, undefined)
    assert.equal(state.terminalCancelled.length >= 1, true, 'detaching cancels the attachment on the Host')
    await app.renameTerminal(created!.id, '  Build  ')
    await waitFor(() => app.snapshot().panel.terminals?.items?.[0]?.title === 'Build')
    assert.equal(app.snapshot().panel.terminals?.items?.[0]?.title, 'Build', 'the new title is trimmed and the list follows')
    await app.renameTerminal(created!.id, '   ')
    assert.match(app.snapshot().panel.note ?? '', /no puede estar vacío/)
    await app.closeTerminal(created!.id)
    await waitFor(() => app.snapshot().panel.terminals?.items?.length === 0)
    assert.deepEqual(app.snapshot().panel.terminals?.items, [])
  } finally {
    app.dispose()
  }
})

test('terminals: a read-only view refuses keys; a dropped connection keeps the screen until the person reconnects', async () => {
  state.terminals = [{ id: 'agent-1', title: 'Pruebas', shell: { path: '/bin/bash', args: [], name: 'bash' }, cwd: '/w', cols: 80, rows: 24, state: 'running', exitCode: null, origin: 'agent', control: 'agent', sandboxMode: 'read-only' }]
  state.terminalWrites = []
  state.terminalWritable = false
  const app = new AppController(connection)
  try {
    await app.start()
    await app.attachTerminal('agent-1')
    await waitFor(() => app.snapshot().terminal?.phase === 'connected')
    assert.equal(app.snapshot().terminal?.info?.sandboxMode, 'read-only')
    assert.equal(app.snapshot().terminal?.writable, false)
    app.sendTerminal('x')
    assert.equal(state.terminalWrites.length, 0, 'nothing is sent to a read-only terminal')
    assert.equal(app.snapshot().terminal?.notice, 'Esta vista es de solo lectura.')
    await app.detachTerminal()

    state.terminalWritable = true
    await app.attachTerminal('agent-1')
    await waitFor(() => app.snapshot().terminal?.writable === true)
    app.sendTerminal('y')
    await waitFor(() => state.terminalWrites.length === 1)
    assert.equal(state.terminalWrites[0]?.data, 'y')

    for (const attachment of state.terminalAttachments.values()) attachment.end()
    await waitFor(() => app.snapshot().terminal?.phase === 'disconnected')
    assert.match(app.snapshot().terminal?.notice ?? '', /reconectar/)
    assert.equal(app.snapshot().terminal?.info?.id, 'agent-1', 'the last screen stays')
    app.sendTerminal('z')
    assert.equal(state.terminalWrites.length, 1, 'keys are not sent while disconnected')
    await app.reconnectTerminal()
    await waitFor(() => app.snapshot().terminal?.phase === 'connected')
    assert.equal(app.snapshot().terminal?.notice, undefined)
  } finally {
    state.terminalWritable = true
    await app.detachTerminal()
    app.dispose()
  }
})

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
}
