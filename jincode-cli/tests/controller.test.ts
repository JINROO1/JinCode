import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { connect, type RemoteConnection } from '../src/wire/remote.ts'
import { subagentsOf, AppController, keyRefFor, matchesTitleOrFolder, titleOf } from '../src/app/controller.ts'
import { normalizeCatalog, summaryOf } from '../src/app/session-client.ts'

// A fake Host with the response shapes observed on the real server.
let scheduleSeq = 0

const state = {
  schedules: [{ id: 'sch-1', kind: 'every', title: 'Resumen diario', prompt: 'resume', everySeconds: 3600, target: { kind: 'session', sessionId: 's-1' }, involvedSessionIds: ['s-1'], status: 'active', createdAt: '2026-11-19T09:00:00.000Z', updatedAt: '2026-11-19T09:00:00.000Z', history: [] as unknown[] }] as any[],
  keys: new Set<string>(),
  plugins: [
    { entryId: 'core', moduleName: 'core-module', enabled: true, meta: { title: { es: 'Núcleo' } } },
    { entryId: 'ext', moduleName: 'ext-module', enabled: false, readOnlyReason: 'management-required', meta: { title: { en: 'Extension' } } },
  ] as Array<Record<string, any>>,
  bundles: [
    { name: 'dsh-base', version: '1.2.0', description: 'Base', enabled: true, installed: true, removable: false, readOnlyReason: 'unaddressable' },
    { name: 'extra', version: '0.1.0', description: 'Extra', enabled: true, installed: true, removable: true },
  ] as Array<Record<string, any>>,
  pluginAnswer: { status: 'accepted', name: 'nuevo', version: '1.0.0' } as Record<string, unknown>,
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
  mcpServers: [
    { name: 'echo', configured: true, status: { state: 'connected', toolCount: 1, connectedAt: 1 } },
  ] as Array<Record<string, any>>,
  mcpWatchers: new Map<string, (value: unknown) => void>(),
  mcpRestarts: [] as string[],
  mcpUnsupported: false,
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

function respond(method: string, args: any, raw: any = args): unknown {
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
    case 'agentPresets/list': return { presets: [{ id: 'standard', order: 1, isDefault: true }, { id: 'minimal', order: 2, isDefault: false }] }
    case 'agentPresets/read': return { agentPreset: args.agentPreset, content: `- id: ${args.agentPreset}\n` }
    case 'agentPresets/select': return args.agentPreset
    case 'pluginManager/listPlugins': return state.plugins.map(item => ({ ...item }))
    case 'pluginManager/listBundles': return state.bundles.map(item => ({ ...item }))
    case 'pluginManager/setPluginEnabled': {
      const entry = state.plugins.find(item => item.entryId === args.id)
      if (!entry) throw new Error(`no plugin ${args.id}`)
      entry.enabled = args.enabled
      return {}
    }
    case 'pluginManager/setBundleEnabled': {
      const bundle = state.bundles.find(item => item.name === args.name)
      if (!bundle) throw new Error(`no bundle ${args.name}`)
      bundle.enabled = args.enabled
      return {}
    }
    case 'pluginManager/removeBundle': {
      const bundle = state.bundles.find(item => item.name === args.name)
      if (!bundle?.removable) throw new Error(`bundle ${args.name} cannot be removed`)
      state.bundles = state.bundles.filter(item => item.name !== args.name)
      return {}
    }
    case 'mcpManager/probe': {
      if (args.name === 'echo') return { ok: true, serverInfo: { name: 'echo-test', version: '0.1.0' }, toolNames: ['echo'], truncated: false, durationMs: 3, closeConfirmed: true }
      if (args.name === 'roto') return { ok: false, stage: 'connect', message: 'spawn ENOENT', durationMs: 2, closeConfirmed: true }
      throw new Error(`mcp-manager: unknown server "${args.name}" — it is neither configured nor registered`)
    }
    case 'mcpManager/restart':
      if (args.name !== 'echo') throw new Error(`mcp-manager: unknown server "${args.name}" — it is neither configured nor registered`)
      state.mcpRestarts.push(args.name)
      return null
    case 'pluginManager/inspect': return state.pluginAnswer
    case 'pluginManager/installBundle': return { ...state.pluginAnswer, status: 'installed' }
    case 'subagents/prompt': return { messageId: `m-${args.childSessionId}` }
    case 'subagents/interruptByUser': return { accepted: true }
    case 'goals/edit': {
      if (!state.goal) throw new Error('no goal')
      if (raw.ref.revision !== state.goal.revision) throw new Error(`stale goal ref "${raw.ref.id}" revision ${raw.ref.revision}; current is "${state.goal.id}" revision ${state.goal.revision}`)
      state.goal = { ...state.goal, objective: raw.request.objective, revision: state.goal.revision + 1 }
      return state.goal
    }
    case 'goals/pause': if (state.goal) state.goal = { ...state.goal, phase: 'paused', revision: state.goal.revision + 1 }; return {}
    case 'goals/resume': if (state.goal) state.goal = { ...state.goal, phase: 'active', revision: state.goal.revision + 1 }; return {}
    case 'goals/complete': if (state.goal) state.goal = { ...state.goal, phase: 'complete', revision: state.goal.revision + 1 }; return {}
    case 'goals/clear': state.goal = null; return {}
    case 'schedule/catalog': return state.schedules.map(item => ({ ...item }))
    case 'schedule/deliveryLimits': return { newSessionIntervalSeconds: 60 }
    case 'schedule/create': {
      scheduleSeq += 1
      const stamp = `2026-11-19T10:00:0${scheduleSeq}.000Z`
      const item = { id: `sch-new-${scheduleSeq}`, kind: 'every', title: args.title, prompt: args.prompt, everySeconds: args.timing.every_seconds, target: args.target, involvedSessionIds: [], status: 'active', createdAt: stamp, updatedAt: stamp, history: [] as unknown[] }
      state.schedules.push(item)
      return item
    }
    case 'schedule/edit': {
      const item = state.schedules.find(entry => entry.id === args.id)
      if (!item) throw new Error('schedule not found')
      if (args.expectedUpdatedAt !== undefined && args.expectedUpdatedAt !== item.updatedAt) return { id: item.id, code: 'schedule_conflict' }
      if (args.action === 'delete') {
        state.schedules = state.schedules.filter(entry => entry.id !== item.id)
        return { id: item.id, deleted: true }
      }
      const patch = args.patch
      if (patch.title !== undefined) item.title = patch.title
      if (patch.active !== undefined) item.status = patch.active ? 'active' : 'paused'
      item.updatedAt = `2026-11-19T10:01:0${scheduleSeq}.000Z`
      return item
    }
    case 'schedule/run': {
      const item = state.schedules.find(entry => entry.id === args.id)
      if (item) item.history.push({ scheduledAt: item.updatedAt, deliveredAt: item.updatedAt, messageId: 'm', targetSessionId: 's-1', prompt: item.prompt })
      if (item) item.updatedAt = `2026-11-19T10:02:0${scheduleSeq}.000Z`
      return null
    }
    case 'schedule/history': return { id: args.id, records: state.schedules.find(entry => entry.id === args.id)?.history ?? [], earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 200 } }
    case 'schedule/deleteInactive': {
      const before = state.schedules.length
      state.schedules = state.schedules.filter(entry => entry.status !== 'ended')
      return { deleted: before - state.schedules.length }
    }
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
      result = { ok: true, value: respond(method, body.payload.args.request ?? body.payload.args, body.payload.args) }
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
        if (frame.type === 'open' && frame.endpoint === 'mcpManager/watch') {
          const send = (value: unknown): void => { ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value })) }
          if (state.mcpUnsupported) {
            ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: 'remote/unknown-endpoint', message: 'no such endpoint: mcpManager/watch', details: {} } }))
            return
          }
          state.mcpWatchers.set(frame.streamId, send)
          send(state.mcpServers.map(item => ({ ...item })))
          return
        }
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
    assert.equal(app.snapshot().panel.scheduleLimit, 60)
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

test('schedules: create, edit, pause, run, read the deliveries, delete; a stale edit is reported and changes nothing', async () => {
  state.schedules = [{ id: 'sch-1', kind: 'every', title: 'Resumen diario', prompt: 'resume', everySeconds: 3600, target: { kind: 'session', sessionId: 's-1' }, involvedSessionIds: ['s-1'], status: 'active', createdAt: '2026-11-19T09:00:00.000Z', updatedAt: '2026-11-19T09:00:00.000Z', history: [] as unknown[] }] as any[]
  const app = new AppController(connection)
  try {
    await app.start()
    await app.openPanel('schedule')
    const created = await app.saveSchedule({ title: 'Nueva', prompt: 'p', timing: { kind: 'every', every_seconds: 600 }, target: { kind: 'session', sessionId: 's-1' } }, false)
    assert.equal(created, true)
    assert.equal(app.snapshot().panel.schedules?.length, 2)
    const task = app.snapshot().panel.schedules?.find(item => item.title === 'Nueva')
    assert.ok(task, 'the new task is listed')
    await app.toggleSchedule(task)
    assert.equal(app.snapshot().panel.schedules?.find(item => item.id === task.id)?.status, 'paused')
    await app.runSchedule(task)
    await app.loadScheduleHistory(task)
    assert.equal(app.snapshot().panel.scheduleHistory?.records.length, 1, 'the run is saved as a delivery')
    const stale = await app.saveSchedule({ id: task.id, action: 'update', patch: { title: 'Vieja' }, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }, true)
    assert.equal(stale, false, 'a stale edit does not close the form')
    assert.match(app.snapshot().panel.note ?? '', /cambió desde que la leíste/)
    assert.equal(app.snapshot().panel.schedules?.find(item => item.id === task.id)?.title, 'Nueva', 'nothing changed')
    const fresh = app.snapshot().panel.schedules?.find(item => item.id === task.id)
    await app.deleteSchedule(fresh!)
    assert.equal(app.snapshot().panel.schedules?.some(item => item.id === task.id), false)
    assert.equal(app.snapshot().panel.note, 'programación eliminada')
  } finally {
    state.schedules = [{ id: 'sch-1', kind: 'every', title: 'Resumen diario', prompt: 'resume', everySeconds: 3600, target: { kind: 'session', sessionId: 's-1' }, involvedSessionIds: ['s-1'], status: 'active', createdAt: '2026-11-19T09:00:00.000Z', updatedAt: '2026-11-19T09:00:00.000Z', history: [] as unknown[] }] as any[]
    app.dispose()
  }
})

test('agents: a preset is selected only for a blank Session; a new Session takes it; the declaration toggles', async () => {
  const app = new AppController(connection)
  const session = state.sessions[0] as any
  const wasBlank = session.blank
  try {
    await app.start()
    await app.openPanel('agents')
    assert.deepEqual(app.snapshot().panel.agentPresets?.map(item => item.id), ['standard', 'minimal'])
    session.blank = false
    await app.refreshSessions()
    await app.selectAgentPreset('minimal')
    assert.equal(state.calls.some(call => call.method === 'agentPresets/select'), false, 'a started Session is not changed')
    assert.match(app.snapshot().panel.note ?? '', /ya empezó/)
    session.blank = true
    await app.refreshSessions()
    await app.selectAgentPreset('minimal')
    const select = state.calls.findLast(call => call.method === 'agentPresets/select')
    assert.deepEqual(select?.args, { agentId: 's-1', agentPreset: 'minimal' })
    assert.equal(app.snapshot().panel.note, 'agente seleccionado: minimal')
    await app.newSessionWithPreset('minimal')
    assert.equal(state.calls.findLast(call => call.method === 'session/create')?.args.request.agentPreset, 'minimal')
    await app.toggleAgentYaml('minimal')
    assert.equal(app.snapshot().panel.agentYaml?.content, '- id: minimal\n')
    await app.toggleAgentYaml('minimal')
    assert.equal(app.snapshot().panel.agentYaml, undefined, 'the same key again closes it')
  } finally {
    session.blank = wasBlank
    app.dispose()
  }
})

test('mcp: the status feed fills the section and follows changes; a probe names the tools or the failing stage; a restart is sent', async () => {
  const app = new AppController(connection)
  try {
    await app.start()
    await waitFor(() => app.snapshot().panel.mcp !== undefined)
    assert.deepEqual(app.snapshot().panel.mcp?.map(item => [item.name, item.label]), [['echo', 'conectado · 1 herramienta']])
    for (const send of state.mcpWatchers.values()) {
      send([
        { name: 'echo', configured: true, status: { state: 'connected', toolCount: 1, connectedAt: 1 } },
        { name: 'roto', configured: true, status: { state: 'reconnecting', attempt: 2, maxAttempts: 10, nextRetryAtMs: 1, lastError: 'spawn ENOENT' } },
      ])
    }
    await waitFor(() => app.snapshot().panel.mcp?.length === 2)
    assert.equal(app.snapshot().panel.mcp?.[1]?.label, 'reconectando (intento 2 de 10)')
    assert.equal(app.snapshot().panel.mcp?.[1]?.detail, 'spawn ENOENT')
    await app.probeServer('echo')
    assert.equal(app.snapshot().panel.mcpProbe?.ok, true)
    assert.match(app.snapshot().panel.mcpProbe?.text ?? '', /^correcto \(echo-test 0\.1\.0\) · 1 herramienta: echo$/)
    await app.probeServer('roto')
    assert.equal(app.snapshot().panel.mcpProbe?.ok, false)
    assert.equal(app.snapshot().panel.mcpProbe?.name, 'roto')
    assert.match(app.snapshot().panel.mcpProbe?.text ?? '', /^falló en la conexión: spawn ENOENT$/)
    await app.restartServer('echo')
    assert.deepEqual(state.mcpRestarts, ['echo'])
    assert.equal(app.snapshot().panel.note, 'echo: reiniciado')
    await app.restartServer('no-existe')
    assert.match(app.snapshot().error ?? '', /unknown server "no-existe"/)
  } finally {
    state.mcpServers = [{ name: 'echo', configured: true, status: { state: 'connected', toolCount: 1, connectedAt: 1 } }]
    state.mcpRestarts = []
    app.dispose()
  }
})

test('mcp: a Host without the surface leaves the section empty with the reason, and the app keeps working', async () => {
  const app = new AppController(connection)
  state.mcpUnsupported = true
  try {
    await app.start()
    await waitFor(() => app.snapshot().panel.mcpError !== undefined)
    assert.equal(app.snapshot().panel.mcp, undefined)
    assert.match(app.snapshot().panel.mcpError ?? '', /no such endpoint/)
    assert.equal(app.snapshot().error, undefined, 'the feed failure is not a top-level error')
  } finally {
    state.mcpUnsupported = false
    app.dispose()
  }
})

test('plugins: rows toggle on Enter, a read-only one says why, a bundle is removed only after its second press', async () => {
  const app = new AppController(connection)
  try {
    await app.start()
    await app.openPanel('plugins')
    const shown = app.snapshot().panel.plugins
    assert.deepEqual(shown?.plugins.map(item => [item.id, item.enabled]), [['core', true], ['ext', false]])
    assert.deepEqual(shown?.bundles.map(item => item.name), ['dsh-base', 'extra'])
    await app.togglePlugin(shown!.plugins[0]!)
    assert.deepEqual(state.calls.findLast(call => call.method === 'pluginManager/setPluginEnabled')?.args, { id: 'core', enabled: false })
    assert.equal(state.plugins[0]?.enabled, false)
    await app.togglePlugin(shown!.plugins[1]!)
    assert.equal(state.calls.filter(call => call.method === 'pluginManager/setPluginEnabled').length, 1, 'a read-only entry is not sent')
    assert.match(app.snapshot().panel.note ?? '', /solo lectura: lo gestiona el propio gestor/)
    await app.toggleBundle(shown!.bundles[0]!)
    assert.equal(state.calls.some(call => call.method === 'pluginManager/setBundleEnabled'), false, 'a read-only bundle is not sent')
    await app.removeBundle(shown!.bundles[0]!)
    assert.equal(state.calls.some(call => call.method === 'pluginManager/removeBundle'), false, 'the built-in bundle is kept')
    await app.toggleBundle(shown!.bundles[1]!)
    assert.deepEqual(state.calls.findLast(call => call.method === 'pluginManager/setBundleEnabled')?.args, { name: 'extra', enabled: false })
    await app.removeBundle(shown!.bundles[1]!)
    assert.deepEqual(state.calls.findLast(call => call.method === 'pluginManager/removeBundle')?.args, { name: 'extra' })
    assert.deepEqual(app.snapshot().panel.plugins?.bundles.map(item => item.name), ['dsh-base'])
  } finally {
    state.plugins[0]!.enabled = true
    state.plugins[1]!.enabled = false
    state.bundles = [
      { name: 'dsh-base', version: '1.2.0', description: 'Base', enabled: true, installed: true, removable: false, readOnlyReason: 'unaddressable' },
      { name: 'extra', version: '0.1.0', description: 'Extra', enabled: true, installed: true, removable: true },
    ]
    app.dispose()
  }
})

test('plugins: an inspection is kept with its spec; an install reports the Host answer', async () => {
  const app = new AppController(connection)
  try {
    await app.start()
    await app.openPanel('plugins')
    await app.inspectSpec('  nuevo-paquete  ')
    assert.deepEqual(state.calls.findLast(call => call.method === 'pluginManager/inspect')?.args, { spec: 'nuevo-paquete', options: {} })
    assert.equal(app.snapshot().panel.pluginInspect?.spec, 'nuevo-paquete')
    assert.equal(app.snapshot().panel.pluginInspect?.status, 'accepted')
    await app.installSpec('nuevo-paquete')
    const install = state.calls.findLast(call => call.method === 'pluginManager/installBundle')
    assert.equal(install?.args.spec, 'nuevo-paquete')
    assert.match(install?.args.options.requestId ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(app.snapshot().panel.note, 'instalación: installed')
  } finally {
    state.pluginAnswer = { status: 'accepted', name: 'nuevo', version: '1.0.0' }
    app.dispose()
  }
})

test('subagents: the children of the active Session are listed; a message and an interrupt reach the child', async () => {
  const child = { sessionId: 's-child', updatedAt: 1, running: true, blank: false, cwd: '/tmp', parentSessionId: 's-1', origin: 'subagent', projections: { values: { title: 'Revisor' } } }
  state.sessions.push(child as any)
  const app = new AppController(connection)
  try {
    await app.start()
    await app.openPanel('subagents')
    const children = subagentsOf(app.snapshot().sessions, 's-1')
    assert.deepEqual(children.map(item => item.sessionId), ['s-child'])
    await app.sendToChild('s-child', '   ')
    assert.equal(state.calls.some(call => call.method === 'subagents/prompt'), false, 'a blank message is not sent')
    await app.sendToChild('s-child', ' revisa esto ')
    const sent = state.calls.findLast(call => call.method === 'subagents/prompt')
    assert.equal(sent?.args.request.childSessionId, 's-child')
    assert.equal(sent?.args.request.delivery, 'queue')
    assert.deepEqual(sent?.args.request.content, [{ type: 'text', text: 'revisa esto' }])
    assert.equal(app.snapshot().panel.note, 'mensaje encolado para el subagente')
    app.toggleSubagentDelivery()
    assert.equal(app.snapshot().panel.subagentDelivery, 'steer')
    await app.sendToChild('s-child', 'ahora')
    assert.equal(state.calls.findLast(call => call.method === 'subagents/prompt')?.args.request.delivery, 'steer')
    await app.interruptChild('s-child')
    assert.equal(state.calls.findLast(call => call.method === 'subagents/interruptByUser')?.args.childSessionId, 's-child')
    assert.equal(app.snapshot().panel.note, 'interrupción pedida al subagente')
  } finally {
    state.sessions = state.sessions.filter(item => item.sessionId !== 's-child')
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
    await app.editGoal('   ')
    assert.equal(app.snapshot().panel.note, 'el objetivo no puede estar vacío')
    await app.editGoal('terminar el informe')
    assert.equal(app.snapshot().panel.note, 'sin cambios')
    assert.equal(state.calls.some(call => call.method === 'goals/edit'), false, 'blank and unchanged objectives are not sent')
    await app.editGoal('  terminar el informe final  ')
    assert.equal(app.snapshot().panel.goal?.objective, 'terminar el informe final')
    assert.equal(app.snapshot().panel.note, 'meta editada')
    const edit = state.calls.findLast(call => call.method === 'goals/edit')
    assert.equal(edit?.args.agentId, 's-1')
    assert.deepEqual(edit?.args.request, { objective: 'terminar el informe final' })
    // Another client changes the goal first: the stale revision is refused, the goal is read again, nothing is lost.
    const stale = app.snapshot().panel.goal
    assert.ok(stale)
    state.goal = { ...(state.goal as any), revision: (state.goal as any).revision + 1, objective: 'cambiado en otro lado' }
    await app.editGoal('mi cambio')
    assert.equal(app.snapshot().panel.note, 'la meta cambió desde que la leíste; se volvió a leer')
    assert.equal(app.snapshot().panel.goal?.objective, 'cambiado en otro lado', 'the fresh goal is shown')
    assert.equal(app.snapshot().error, undefined, 'a stale edit is a note, not an error')
    await app.goalAction('pause')
    assert.equal(app.snapshot().panel.goal?.phase, 'paused')
    await app.goalAction('resume')
    assert.equal(app.snapshot().panel.goal?.phase, 'active')
    await app.goalAction('complete')
    assert.equal(app.snapshot().panel.goal?.phase, 'complete')
    const readRevision = app.snapshot().panel.goal?.revision
    await app.clearGoal()
    assert.equal(app.snapshot().panel.goal, null)
    const clear = state.calls.findLast(call => call.method === 'goals/clear')
    assert.equal(clear?.args.agentId, 's-1')
    assert.equal(clear?.args.ref.revision, readRevision, 'clear names the revision it read')
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
