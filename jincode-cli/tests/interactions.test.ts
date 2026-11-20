import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { InteractionClient, type StreamCarrier } from '../src/app/interactions.ts'
import type { RemoteConnection, RemoteStream } from '../src/wire/remote.ts'
import type { PendingInteraction } from '../src/app/interaction-rules.ts'

/** A stream the test feeds by hand. */
class FakeStream<T> implements RemoteStream<T> {
  cancelled = false
  private readonly items: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false
  constructor(readonly endpoint: string, readonly args: Record<string, unknown>) {}
  readonly sent: unknown[] = []
  send(value: unknown): void {
    this.sent.push(value)
  }
  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ value, done: false })
    else this.items.push(value)
  }
  end(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }
  cancel(): void {
    this.cancelled = true
    this.end()
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => this.waiters.push(resolve))
      },
    }
  }
}

interface Fixture {
  readonly streams: FakeStream<unknown>[]
  readonly calls: Array<{ endpoint: string; args: Record<string, unknown> }>
  readonly client: InteractionClient
  readonly changes: PendingInteraction[][]
  readonly errors: unknown[]
  latest(endpoint?: string): FakeStream<unknown>
}

const connection: RemoteConnection = { origin: 'http://host.test', cookie: 'session=1' }
const realFetch = globalThis.fetch
let fixture: Fixture | undefined

/** Answer each RPC with an empty success, and record the calls. */
function stubRpc(fail: string[] = []): Array<{ endpoint: string; args: Record<string, unknown> }> {
  const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: { args: Record<string, unknown> } }
    calls.push({ endpoint: body.method, args: body.payload.args })
    if (fail.includes(body.method)) {
      return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'x', message: 'rechazado' } } }), { headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: null } }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}

function build(options: { retryMs?: number; fail?: string[] } = {}): Fixture {
  const streams: FakeStream<unknown>[] = []
  const changes: PendingInteraction[][] = []
  const errors: unknown[] = []
  const calls = stubRpc(options.fail ?? [])
  const mux: StreamCarrier = {
    open: (endpoint: string, args: Record<string, unknown>) => {
      const stream = new FakeStream<unknown>(endpoint, args)
      streams.push(stream)
      return stream as unknown as RemoteStream<never>
    },
  }
  const client = new InteractionClient(connection, {
    onChange: pending => changes.push([...pending]),
    onError: error => errors.push(error),
  }, mux, { retryMs: options.retryMs ?? 10 })
  fixture = {
    streams,
    calls,
    client,
    changes,
    errors,
    latest: (endpoint = '$events') => {
      const found = streams.filter(stream => stream.endpoint === endpoint).at(-1)
      if (found === undefined) throw new Error(`no stream ${endpoint}`)
      return found
    },
  }
  return fixture
}

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

afterEach(() => {
  fixture?.client.stop()
  fixture = undefined
  globalThis.fetch = realFetch
})

function question(eventId: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'waterfall', event: 'user-questions/request', eventId, agentId: 'session-1',
    request: { questions: [{ id: 'color', question: 'Que color?', options: [{ label: 'Rojo' }, { label: 'Azul' }] }], ...extra },
  }
}

test('a question waterfall becomes pending and its answer goes back on $events/result', async () => {
  const f = build()
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.latest().push(question('ev-1'))
  await tick()
  const [pending] = f.client.pending()
  assert.equal(pending?.kind, 'question')
  assert.equal(pending?.key, 'waterfall:ev-1')
  await f.client.answerQuestion(pending as never, [{ id: 'color', selected: ['Azul'] }])
  assert.deepEqual(f.calls.at(-1), {
    endpoint: '$events/result',
    args: { clientId: 'client-A', eventId: 'ev-1', outcome: { kind: 'result', value: { answers: [{ id: 'color', selected: ['Azul'] }] } } },
  })
  assert.equal(f.client.pending().length, 0)
})

test('a cancel frame drops the open request', async () => {
  const f = build()
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.latest().push(question('ev-2'))
  await tick()
  assert.equal(f.client.pending().length, 1)
  f.latest().push({ type: 'cancel', eventId: 'ev-2' })
  await tick()
  assert.equal(f.client.pending().length, 0)
})

test('a waterfall this client does not handle is passed on with next', async () => {
  const f = build()
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.latest().push({ type: 'waterfall', event: 'something/else', eventId: 'ev-3', agentId: 's', request: {} })
  await tick()
  assert.deepEqual(f.calls.at(-1)?.args, { clientId: 'client-A', eventId: 'ev-3', outcome: { kind: 'next' } })
  assert.equal(f.client.pending().length, 0)
})

test('an approval is decided with allowed-once or rejected', async () => {
  const f = build()
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.latest().push({ type: 'waterfall', event: 'approval/request', eventId: 'ev-4', agentId: 'session-1', request: { toolName: 'bash', reason: 'borrar' } })
  await tick()
  const [approval] = f.client.pending()
  assert.equal(approval?.kind, 'approval')
  await f.client.decideApproval(approval as never, 'allowed-once')
  assert.deepEqual(f.calls.at(-1)?.args, { clientId: 'client-A', eventId: 'ev-4', outcome: { kind: 'result', value: 'allowed-once' } })
})

test('delegating an approval sends next', async () => {
  const f = build()
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.latest().push({ type: 'waterfall', event: 'approval/request', eventId: 'ev-5', agentId: 's', request: { toolName: 'bash' } })
  await tick()
  await f.client.delegate(f.client.pending()[0] as never)
  assert.deepEqual(f.calls.at(-1)?.args.outcome, { kind: 'next' })
})

test('a failed answer puts the request back and reports the error to the caller', async () => {
  const f = build({ fail: ['$events/result'] })
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.latest().push(question('ev-6'))
  await tick()
  const [pending] = f.client.pending()
  await assert.rejects(() => f.client.answerQuestion(pending as never, [{ id: 'color', selected: ['Rojo'] }]), /rechazado/)
  assert.equal(f.client.pending().length, 1)
})

test('a continued question is answered through userQuestions/answer and leaves the list', async () => {
  const f = build()
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.client.setContinued('session-9', {
    active: [{ callId: 'call-7', state: 'continued', questions: [{ id: 'color', question: 'Que color?', options: [{ label: 'Rojo' }] }] }],
    settled: [],
  })
  const [pending] = f.client.pending()
  assert.equal(pending?.key, 'continued:session-9:call-7')
  await f.client.answerQuestion(pending as never, [{ id: 'color', selected: ['Rojo'] }])
  assert.deepEqual(f.calls.at(-1), {
    endpoint: 'userQuestions/answer',
    args: { agent: 'session-9', callId: 'call-7', answer: { answers: [{ id: 'color', selected: ['Rojo'] }] } },
  })
  assert.equal(f.client.pending().length, 0)
})

test('a continued question that fails to send comes back', async () => {
  const f = build({ fail: ['userQuestions/answer'] })
  f.client.start()
  f.client.setContinued('session-9', {
    active: [{ callId: 'call-8', state: 'continued', questions: [{ id: 'q', question: 'Q?', options: [] }] }],
    settled: [],
  })
  const [pending] = f.client.pending()
  await assert.rejects(() => f.client.answerQuestion(pending as never, [{ id: 'q', selected: [], custom: 'x' }]))
  assert.equal(f.client.pending().length, 1)
})

test('delegating a continued question only hides it, and the projection can bring it back', async () => {
  const f = build()
  f.client.start()
  const projection = { active: [{ callId: 'call-3', state: 'continued', questions: [{ id: 'q', question: 'Q?', options: [] }] }], settled: [] }
  f.client.setContinued('session-2', projection)
  await f.client.delegate(f.client.pending()[0] as never)
  assert.equal(f.client.pending().length, 0)
  assert.equal(f.calls.length, 0)
  f.client.setContinued('session-2', { active: [], settled: [] })
  f.client.setContinued('session-2', projection)
  assert.equal(f.client.pending().length, 1)
})

test('a timed question claims its wait first and records the remaining time', async () => {
  const f = build()
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.latest().push(question('ev-7', { wait: { callId: 'call-5', timed: true } }))
  await tick()
  const claim = f.latest('userQuestions/attachWait')
  assert.deepEqual(claim.args, { agent: 'session-1', callId: 'call-5' })
  claim.push({ remainingMs: 42000 })
  await tick()
  const [pending] = f.client.pending()
  assert.equal(pending?.kind, 'question')
  assert.equal((pending as { remainingMs?: number }).remainingMs, 42000)
  await f.client.answerQuestion(pending as never, [{ id: 'color', selected: ['Rojo'] }])
  assert.equal(claim.cancelled, true)
})

test('a timed question whose wait already ended is passed on', async () => {
  const f = build()
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.latest().push(question('ev-8', { wait: { callId: 'call-6', timed: true } }))
  await tick()
  f.latest('userQuestions/attachWait').end()
  await tick()
  assert.equal(f.client.pending().length, 0)
  assert.deepEqual(f.calls.at(-1)?.args.outcome, { kind: 'next' })
})

test('when the stream ends, the client reopens it and drops the requests it had', async () => {
  const f = build({ retryMs: 10 })
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  f.latest().push(question('ev-9'))
  await tick()
  assert.equal(f.client.pending().length, 1)
  f.latest().end()
  await tick(40)
  assert.equal(f.streams.filter(stream => stream.endpoint === '$events').length, 2)
  assert.equal(f.client.pending().length, 0)
  f.latest().push({ type: 'ready', clientId: 'client-B', host: { home: '/h' } })
  f.latest().push(question('ev-10'))
  await tick()
  assert.equal(f.client.pending().length, 1)
  await f.client.answerQuestion(f.client.pending()[0] as never, [{ id: 'color', selected: ['Rojo'] }])
  assert.equal(f.calls.at(-1)?.args.clientId, 'client-B')
})

test('stop cancels the stream and reports nothing afterwards', async () => {
  const f = build()
  f.client.start()
  f.latest().push({ type: 'ready', clientId: 'client-A', host: { home: '/h' } })
  const before = f.changes.length
  f.client.stop()
  f.latest().push(question('ev-11'))
  await tick()
  assert.equal(f.changes.length, before)
  assert.equal(f.latest().cancelled, true)
})
