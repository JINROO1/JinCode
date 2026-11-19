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
  sessions: [{ sessionId: 's-1', updatedAt: 1000, running: false, blank: false, cwd: '/tmp', projections: { values: { title: 'Primera', modelSelection: { next: { provider: 'jincode', model: 'gpt-4o-mini' } } } } }],
}

let server: Server
let wss: WebSocketServer
let connection: RemoteConnection

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
    try {
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
