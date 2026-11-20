import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { call, connect, parseAccessUrl, parseMuxFrame, RemoteError, RemoteMux } from '../src/wire/remote.ts'

// A fake Host: /connect issues a cookie, /api/* answers the envelope, and
// /api/remote.mux serves one stream that yields two items and ends.
let server: Server
let origin: string
let lastCall: { endpoint: string; body: any; cookie: string | undefined } | undefined

before(async () => {
  const http = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname === '/connect') {
      if (url.searchParams.get('token') !== 'good') {
        response.writeHead(401).end()
        return
      }
      response.writeHead(302, { location: './api/remote.mux', 'set-cookie': 'dsh-auth-test=v2.abc; Path=/; HttpOnly' }).end()
      return
    }
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/remote.mux') {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      lastCall = { endpoint: url.pathname.slice('/api/'.length), body, cookie: request.headers.cookie }
      if (!request.headers.cookie?.startsWith('dsh-auth-test=')) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'auth/required', message: 'no cookie', details: {} } } }))
        return
      }
      if (lastCall.endpoint === 'session/cancel') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'session/not-running', message: 'nothing to cancel', details: {} } } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { echo: body.payload.args } } }))
      return
    }
    response.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/remote.mux' || request.headers.cookie !== 'dsh-auth-test=v2.abc') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString())
        if (frame.type !== 'open') return
        if (frame.endpoint === 'session/follow') {
          ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot' } }))
          ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'event' } }))
          ws.send(JSON.stringify({ type: 'end', streamId: frame.streamId }))
        }
        if (frame.endpoint === 'session/broken') {
          ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: 'session/missing', message: 'no such session', details: {} } }))
        }
      })
    })
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', () => resolve()))
  server = http
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
})

after(() => new Promise<void>(resolve => server.close(() => resolve())))

test('parseAccessUrl reads the origin and token from the printed URL', () => {
  assert.deepEqual(parseAccessUrl('http://127.0.0.1:3080/?token=abc_-1'), { origin: 'http://127.0.0.1:3080', token: 'abc_-1' })
  assert.equal(parseAccessUrl('http://127.0.0.1:3080/'), undefined)
})

test('connect exchanges a valid token for the session cookie', async () => {
  const connection = await connect(origin, 'good')
  assert.equal(connection.cookie, 'dsh-auth-test=v2.abc')
})

test('connect rejects a bad token with a typed error', async () => {
  await assert.rejects(connect(origin, 'bad'), (error: unknown) => error instanceof RemoteError && error.code === 'auth/rejected')
})

test('call sends the client-request envelope with args and returns the value', async () => {
  const connection = await connect(origin, 'good')
  const value = await call<{ echo: unknown }>(connection, 'session/list', { _request: {} })
  assert.deepEqual(value, { echo: { _request: {} } })
  assert.equal(lastCall?.body.type, 'client-request')
  assert.equal(lastCall?.body.method, 'session/list')
  assert.deepEqual(lastCall?.body.payload, { args: { _request: {} } })
  assert.match(lastCall?.body.rpcId, /^[0-9a-f-]{36}$/)
})

test('call maps a Host error envelope to a RemoteError with its code', async () => {
  const connection = await connect(origin, 'good')
  await assert.rejects(call(connection, 'session/cancel', { request: { sessionId: 'x' } }), (error: unknown) =>
    error instanceof RemoteError && error.code === 'session/not-running' && error.message === 'nothing to cancel')
})

test('a call without the session cookie is refused', async () => {
  await assert.rejects(call({ origin, cookie: 'other=1' }, 'session/list', { _request: {} }), (error: unknown) =>
    error instanceof RemoteError && error.code === 'auth/required')
})

test('the mux streams items, then ends', async () => {
  const connection = await connect(origin, 'good')
  const mux = new RemoteMux(connection)
  const seen: unknown[] = []
  for await (const item of mux.open('session/follow', { request: {} })) seen.push(item)
  assert.deepEqual(seen, [{ type: 'snapshot' }, { type: 'event' }])
  mux.close()
})

test('a stream error frame rejects the iterator with its code', async () => {
  const connection = await connect(origin, 'good')
  const mux = new RemoteMux(connection)
  await assert.rejects(async () => {
    for await (const _item of mux.open('session/broken', {})) void _item
  }, (error: unknown) => error instanceof RemoteError && error.code === 'session/missing')
  mux.close()
})

test('parseMuxFrame accepts only well-formed stream frames', () => {
  assert.deepEqual(parseMuxFrame('{"type":"item","streamId":"s","value":1}'), { type: 'item', streamId: 's', value: 1 })
  assert.equal(parseMuxFrame('{"type":"item"}'), undefined)
  assert.equal(parseMuxFrame('not json'), undefined)
  assert.equal(parseMuxFrame('{"type":"unknown","streamId":"s"}'), undefined)
})
