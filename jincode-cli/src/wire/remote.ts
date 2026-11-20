/**
 * Wire client for the DeepSeek Harness Remote API, as the Host serves it.
 *
 * - `GET /connect?token=…` exchanges the launch token for a signed cookie.
 * - Unary calls: `POST /api/<namespace>/<method>` with the JSON envelope
 *   `{ type: 'client-request', rpcId, method, payload: { args } }`; the response
 *   envelope is `{ type: 'server-response', rpcId, result: { ok, value } | { ok: false, error } }`.
 * - Streams: one WebSocket at `/api/remote.mux` carries logical streams opened
 *   with `{ type: 'open', streamId, endpoint, payload }` and answered by
 *   `item`, `error`, and `end` frames.
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

/** A Host error delivered inside a response envelope or a stream error frame. */
export class RemoteError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details: unknown = {}) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.details = details
  }
}

/** Arguments of a Remote method, always sent under the `args` key. */
export type RemoteArgs = Record<string, unknown>

/** The authenticated endpoint of one running JinCode server. */
export interface RemoteConnection {
  /** Origin of the server, for example `http://127.0.0.1:3080`. */
  readonly origin: string
  /** `name=value` cookie minted by `/connect`. */
  readonly cookie: string
}

/**
 * Exchange a launch token for the browser-session cookie.
 * @param origin - server origin, without a path.
 * @param token - the access token printed at startup.
 * @param fetchImpl - fetch implementation (injectable for tests).
 * @param interactions - `answer` lets this client answer the Agent's questions and approvals (the default, since the terminal is interactive); `none` is passive.
 * @returns a connection whose cookie authenticates every later call.
 */
export async function connect(
  origin: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  interactions: 'answer' | 'none' = 'answer',
): Promise<RemoteConnection> {
  const url = new URL('/connect', origin)
  url.searchParams.set('token', token)
  url.searchParams.set('interactions', interactions)
  const response = await fetchImpl(url, { redirect: 'manual' })
  if (response.status !== 302) {
    throw new RemoteError('auth/rejected', `the server did not accept the access token (HTTP ${response.status})`)
  }
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null) {
    throw new RemoteError('auth/no-cookie', 'the server accepted the token but returned no session cookie')
  }
  return { origin: new URL(origin).origin, cookie: setCookie.split(';', 1)[0] ?? '' }
}

/**
 * Parse an access URL printed by the server (`…/?token=…`) into its origin and token.
 * @param value - the printed URL.
 * @returns the origin and token, or undefined when the URL carries no token.
 */
export function parseAccessUrl(value: string): { origin: string; token: string } | undefined {
  const url = new URL(value)
  const token = url.searchParams.get('token')
  if (token === null || token.length === 0) return undefined
  return { origin: url.origin, token }
}

/**
 * Call one unary Remote method.
 * @param connection - authenticated connection.
 * @param endpoint - `<namespace>/<method>`.
 * @param args - the method arguments; every descriptor field must be present.
 * @param signal - optional cancellation.
 * @param fetchImpl - fetch implementation (injectable for tests).
 * @returns the method result value.
 */
export async function call<T = unknown>(
  connection: RemoteConnection,
  endpoint: string,
  args: RemoteArgs,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const rpcId = randomUUID()
  const response = await fetchImpl(new URL(`/api/${endpoint}`, connection.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: connection.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    ...signal === undefined ? {} : { signal },
  })
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType === 'multipart/form-data') {
    throw new RemoteError('client/binary-unsupported', `${endpoint} returned binary attachments, which this client does not render yet`)
  }
  const envelope: unknown = await response.json()
  if (!isRecord(envelope) || envelope['type'] !== 'server-response' || envelope['rpcId'] !== rpcId || !isRecord(envelope['result'])) {
    throw new RemoteError('client/bad-envelope', `${endpoint}: the response envelope is malformed (HTTP ${response.status})`)
  }
  const result = envelope['result']
  if (result['ok'] === true) return result['value'] as T
  const error = isRecord(result['error']) ? result['error'] : {}
  throw new RemoteError(
    typeof error['code'] === 'string' ? error['code'] : 'remote/failed',
    typeof error['message'] === 'string' ? error['message'] : `${endpoint} failed`,
    error['details'] ?? {},
  )
}

/** One open logical stream on the multiplexed socket. */
export interface RemoteStream<T = unknown> extends AsyncIterable<T> {
  /** Cancel the stream on the Host and stop delivery. */
  cancel(): void
}

/** Multiplexed stream carrier over `/api/remote.mux`. */
export class RemoteMux {
  private socket: WebSocket | undefined
  private opening: Promise<WebSocket> | undefined
  /** The socket still connecting, so close() can stop it too. */
  private pending: WebSocket | undefined
  private closed = false
  private readonly streams = new Map<string, (frame: MuxFrame) => void>()

  constructor(private readonly connection: RemoteConnection) {}

  /**
   * Open one stream.
   * @param endpoint - `<namespace>/<method>` of a stream method.
   * @param args - the method arguments.
   * @returns an async iterable of the yielded items; cancel() ends it early.
   */
  open<T = unknown>(endpoint: string, args: RemoteArgs): RemoteStream<T> {
    const streamId = randomUUID()
    const queue = new AsyncQueue<T>()
    this.streams.set(streamId, (frame) => {
      if (frame.type === 'item') queue.push(frame.value as T)
      else if (frame.type === 'error') queue.fail(new RemoteError(frame.error.code, frame.error.message, frame.error.details))
      else {
        queue.close()
        this.streams.delete(streamId)
      }
    })
    void this.ensureSocket().then((socket) => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    }).catch((error: unknown) => {
      queue.fail(error instanceof Error ? error : new Error(String(error)))
      this.streams.delete(streamId)
    })
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      cancel: () => {
        this.streams.delete(streamId)
        queue.close()
        this.socket?.send(JSON.stringify({ type: 'cancel', streamId }))
      },
    }
  }

  /** Close the socket, whether connected or still connecting, and end every open stream. */
  close(): void {
    this.closed = true
    for (const dispatch of this.streams.values()) dispatch({ type: 'end', streamId: '' })
    this.streams.clear()
    this.pending?.close()
    this.pending = undefined
    this.socket?.close()
    this.socket = undefined
    this.opening = undefined
  }

  private ensureSocket(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new RemoteError('client/closed', 'the stream carrier is closed', {}))
    if (this.socket !== undefined && this.socket.readyState === WebSocket.OPEN) return Promise.resolve(this.socket)
    if (this.opening !== undefined) return this.opening
    const url = new URL('/api/remote.mux', this.connection.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { cookie: this.connection.cookie } })
      this.pending = socket
      socket.on('message', (data) => this.dispatch(data.toString()))
      socket.once('open', () => {
        this.pending = undefined
        if (this.closed) {
          socket.close()
          reject(new RemoteError('client/closed', 'the stream carrier is closed', {}))
          return
        }
        this.socket = socket
        resolve(socket)
      })
      socket.once('error', (error) => {
        this.pending = undefined
        this.opening = undefined
        reject(error)
      })
      socket.once('close', () => {
        this.socket = undefined
        this.opening = undefined
        for (const [id, dispatch] of this.streams) {
          dispatch({ type: 'error', streamId: id, error: { code: 'client/socket-closed', message: 'the connection closed', details: {} } })
        }
        this.streams.clear()
      })
    })
    return this.opening
  }

  private dispatch(text: string): void {
    const frame = parseMuxFrame(text)
    if (frame === undefined) return
    this.streams.get(frame.streamId)?.(frame)
  }
}

/** A server frame on the multiplexed socket. */
export type MuxFrame =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: { code: string; message: string; details: unknown } }
  | { readonly type: 'end'; readonly streamId: string }

/**
 * Parse one server text frame; unknown shapes are ignored, never trusted.
 * @param text - the raw WebSocket message.
 * @returns the frame, or undefined when it is not a stream frame.
 */
export function parseMuxFrame(text: string): MuxFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || typeof value['streamId'] !== 'string') return undefined
  const streamId = value['streamId']
  if (value['type'] === 'item') return { type: 'item', streamId, value: value['value'] }
  if (value['type'] === 'end') return { type: 'end', streamId }
  if (value['type'] === 'error' && isRecord(value['error'])) {
    const error = value['error']
    return {
      type: 'error',
      streamId,
      error: {
        code: typeof error['code'] === 'string' ? error['code'] : 'remote/failed',
        message: typeof error['message'] === 'string' ? error['message'] : 'stream failed',
        details: error['details'] ?? {},
      },
    }
  }
  return undefined
}

/** Unbounded async queue bridging push-style frames to `for await`. */
class AsyncQueue<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = []
  private closed = false
  private failure: unknown

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve({ value, done: false })
    else this.items.push(value)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as T, done: true })
  }

  fail(error: unknown): void {
    this.failure = error
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false })
        if (this.failure !== undefined) return Promise.reject(this.failure)
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true })
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
      },
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
