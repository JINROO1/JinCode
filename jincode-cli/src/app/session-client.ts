/**
 * Session operations over the Remote API, combined with the transcript reducer.
 * The terminal UI talks only to this module; it never builds wire envelopes.
 */
import { randomUUID } from 'node:crypto'
import { call, RemoteMux, type RemoteConnection, type RemoteStream } from '../wire/remote.ts'
import {
  applyEvent,
  applyLiveFrame,
  emptyTranscript,
  type LiveFrame,
  type Transcript,
  type WireEvent,
} from '../transcript/reducer.ts'

/** One Session row from `session/list`. */
export interface SessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  /** Title the Host derived for the Session, when it has one. */
  readonly title?: string
  /** Model the next turn will use, as `provider/model`. */
  readonly model?: string
  /** Permission preset the Session currently runs with. */
  readonly permission?: string
  readonly cwd?: string
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
}

/** One model choice from the Host catalog. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
  /** Display name of the provider group; falls back to its id. */
  readonly providerName?: string
  /** Display name of the model; falls back to its id. */
  readonly name?: string
  readonly reasoningEfforts?: readonly string[]
}

/** The Host's model catalog: the choices plus the default for unconfigured Sessions. */
export interface ModelCatalogView {
  readonly choices: ModelChoice[]
  readonly defaultChoice: ModelChoice | undefined
}

/** A follow subscription: stop delivering and close the stream. */
export interface Follow {
  stop(): void
}

/** Session operations bound to one authenticated connection. */
export class SessionClient {
  private readonly mux: RemoteMux

  constructor(private readonly connection: RemoteConnection) {
    this.mux = new RemoteMux(connection)
  }

  /** @returns Session rows visible to this client, ordered by the Host. */
  async listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
    const value = await call<{ items: unknown[] }>(this.connection, 'session/list', { _request: {} }, signal)
    return value.items.flatMap(item => {
      const row = summaryOf(item)
      return row === undefined ? [] : [row]
    })
  }

  /**
   * Create a Session, or reuse a blank one the Host allows to be reused.
   * @param options - optional working directory and Agent preset.
   * @returns the identity of the Session the Host used.
   */
  async createSession(options: { cwd?: string; agentPreset?: string } = {}): Promise<string> {
    const value = await call<{ sessionId: string }>(this.connection, 'session/create', { request: options })
    return value.sessionId
  }

  /**
   * Admit one prompt. Acceptance means the input was queued, not completed.
   * @param sessionId - target Session.
   * @param text - the user's text.
   * @param mode - `queue` for the next turn, `steer` for the running one.
   * @returns the client-minted request id.
   */
  async sendPrompt(sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<string> {
    const requestId = randomUUID()
    await call(this.connection, 'session/prompt', {
      request: { requestId, sessionId, mode, content: [{ type: 'text', text }] },
    })
    return requestId
  }

  /**
   * Rename a Session.
   * @param sessionId - target Session.
   * @param title - the new title.
   */
  async rename(sessionId: string, title: string): Promise<void> {
    await call(this.connection, 'session/rename', { request: { sessionId, title } })
  }

  /**
   * Fork a Session at its latest completed turn.
   * @param sessionId - the Session to copy.
   * @returns the new Session id.
   */
  async fork(sessionId: string): Promise<string> {
    const value = await call<{ sessionId: string }>(this.connection, 'session/fork', { request: { sessionId } })
    return value.sessionId
  }

  /**
   * Search Session content.
   * @param query - the text to find.
   * @returns matching Session ids with a snippet each.
   */
  async search(query: string): Promise<Array<{ sessionId: string; snippet: string }>> {
    const value = await call<{ items: unknown[] }>(this.connection, 'session/search', { request: { query } })
    return value.items.flatMap(item => {
      if (!isRecord(item) || typeof item['sessionId'] !== 'string' || typeof item['snippet'] !== 'string') return []
      return [{ sessionId: item['sessionId'], snippet: item['snippet'] }]
    })
  }

  /** @param sessionId - the Session whose running turn should stop. */
  async cancel(sessionId: string): Promise<void> {
    await call(this.connection, 'session/cancel', { request: { sessionId } })
  }

  /**
   * Model choices the Host offers. The catalog is Host-wide and takes no arguments.
   * @returns the catalog entries.
   */
  async modelCatalog(): Promise<ModelChoice[]> {
    return (await this.catalog()).choices
  }

  /**
   * Model choices together with the Host's default selection.
   * @returns the flat choices and the default, when the Host reports one.
   */
  async catalog(): Promise<ModelCatalogView> {
    const value = await call<unknown>(this.connection, 'session/modelCatalog', {})
    const choices = normalizeCatalog(value)
    const defaultChoice = isRecord(value) && isRecord(value['default'])
      ? normalizeCatalog([value['default']])[0]
      : undefined
    return { choices, defaultChoice }
  }

  /**
   * Select the model for this Session.
   * @param sessionId - target Session.
   * @param provider - provider id from the catalog.
   * @param model - model id from the catalog.
   * @param reasoningEffort - optional effort supported by the model.
   */
  async selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<void> {
    await call(this.connection, 'session/selectModel', {
      request: reasoningEffort === undefined ? { sessionId, provider, model } : { sessionId, provider, model, reasoningEffort },
    })
  }

  /**
   * Follow a Session: the historical transcript first, then live events and
   * assistant deltas. Each change is reported with the full transcript state.
   * @param sessionId - the Session to follow.
   * @param onChange - receives the transcript after every applied frame.
   * @param onError - receives a terminal stream failure.
   * @returns a handle that stops delivery and cancels the stream.
   */
  follow(sessionId: string, onChange: (transcript: Transcript) => void, onError: (error: unknown) => void): Follow {
    let state = emptyTranscript()
    const stream: RemoteStream<unknown> = this.mux.open('session/follow', {
      request: { address: { kind: 'session', sessionId }, activate: true, assistantStream: true },
    })
    let stopped = false
    void (async () => {
      try {
        for await (const frame of stream) {
          if (stopped) break
          state = applyFollowFrame(state, frame)
          onChange(state)
        }
      } catch (error) {
        if (!stopped) onError(error)
      }
    })()
    return {
      stop: () => {
        stopped = true
        stream.cancel()
      },
    }
  }

  /** Close the multiplexed socket and end every stream. */
  close(): void {
    this.mux.close()
  }
}

/**
 * Apply one `session/follow` frame: the opening snapshot, a durable event, or a
 * live assistant-stream frame.
 * @param state - the transcript so far.
 * @param frame - one stream item as the Host sent it.
 * @returns the next transcript.
 */
export function applyFollowFrame(state: Transcript, frame: unknown): Transcript {
  if (!isRecord(frame)) return state
  if (frame['type'] === 'snapshot') {
    const records = Array.isArray(frame['records']) ? frame['records'] : []
    let next = state
    for (const record of records) {
      const event = eventOf(record)
      if (event !== undefined) next = applyEvent(next, event)
    }
    return next
  }
  if (frame['type'] === 'event') {
    const event = eventOf(frame)
    return event === undefined ? state : applyEvent(state, event)
  }
  if (frame['type'] === 'assistant-stream' && isRecord(frame['frame'])) {
    const live = toLiveFrame(frame['frame'])
    return live === undefined ? state : applyLiveFrame(state, live)
  }
  return state
}

function eventOf(value: unknown): WireEvent | undefined {
  if (!isRecord(value) || value['type'] !== 'event' || !isRecord(value['event'])) return undefined
  const event = value['event']
  if (typeof event['type'] !== 'string' || typeof event['seq'] !== 'number') return undefined
  return { type: event['type'], seq: event['seq'], data: event['data'] }
}

function toLiveFrame(frame: Record<string, unknown>): LiveFrame | undefined {
  if (frame['type'] === 'start' && typeof frame['attemptId'] === 'string') {
    return {
      type: 'start',
      attemptId: frame['attemptId'],
      turn: typeof frame['turn'] === 'number' ? frame['turn'] : 0,
      step: typeof frame['step'] === 'number' ? frame['step'] : 0,
    }
  }
  if (frame['type'] === 'chunk' && typeof frame['attemptId'] === 'string') {
    return { type: 'chunk', attemptId: frame['attemptId'], chunk: frame['chunk'] }
  }
  if (frame['type'] === 'end' && typeof frame['attemptId'] === 'string') {
    return { type: 'end', attemptId: frame['attemptId'] }
  }
  return undefined
}

/**
 * Normalize the model catalog to a flat list, tolerating the Host's grouping.
 * @param value - the `session/modelCatalog` result.
 * @returns provider/model choices; unknown shapes yield an empty list.
 */
export function normalizeCatalog(value: unknown): ModelChoice[] {
  const choices: ModelChoice[] = []
  if (isRecord(value) && Array.isArray(value['groups'])) {
    for (const group of value['groups']) {
      if (!isRecord(group) || typeof group['id'] !== 'string' || !Array.isArray(group['models'])) continue
      const providerName = typeof group['name'] === 'string' ? group['name'] : undefined
      for (const model of group['models']) {
        if (!isRecord(model) || typeof model['id'] !== 'string') continue
        const reasoning = isRecord(model['reasoning']) ? model['reasoning'] : undefined
        const efforts = reasoning !== undefined && Array.isArray(reasoning['efforts'])
          ? reasoning['efforts'].filter((effort): effort is string => typeof effort === 'string')
          : undefined
        choices.push({
          provider: group['id'],
          model: model['id'],
          ...providerName === undefined ? {} : { providerName },
          ...typeof model['name'] === 'string' ? { name: model['name'] } : {},
          ...efforts === undefined ? {} : { reasoningEfforts: efforts },
        })
      }
    }
    return choices
  }
  const rows: unknown[] = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value['items']) ? value['items'] : []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const provider = typeof row['provider'] === 'string' ? row['provider'] : undefined
    const model = typeof row['model'] === 'string' ? row['model'] : typeof row['id'] === 'string' ? row['id'] : undefined
    if (provider === undefined || model === undefined) continue
    const efforts = Array.isArray(row['reasoningEfforts'])
      ? row['reasoningEfforts'].filter((effort): effort is string => typeof effort === 'string')
      : undefined
    choices.push({ provider, model, ...efforts === undefined ? {} : { reasoningEfforts: efforts } })
  }
  return choices
}

/**
 * Read one `session/list` row. The title lives in the Session's projections.
 * @param value - one raw row.
 * @returns the summary, or undefined when the row lacks an id.
 */
export function summaryOf(value: unknown): SessionSummary | undefined {
  if (!isRecord(value) || typeof value['sessionId'] !== 'string') return undefined
  const projections = isRecord(value['projections']) ? value['projections'] : undefined
  const values = projections !== undefined && isRecord(projections['values']) ? projections['values'] : undefined
  const title = values !== undefined && typeof values['title'] === 'string' && values['title'].length > 0 ? values['title'] : undefined
  const selection = values !== undefined && isRecord(values['modelSelection']) ? values['modelSelection'] : undefined
  const next = selection !== undefined && isRecord(selection['next']) ? selection['next'] : undefined
  const model = next !== undefined && typeof next['provider'] === 'string' && typeof next['model'] === 'string'
    ? `${next['provider']}/${next['model']}`
    : undefined
  const permissions = values !== undefined && isRecord(values['permissions']) ? values['permissions'] : undefined
  const permission = permissions !== undefined && typeof permissions['currentValue'] === 'string' ? permissions['currentValue'] : undefined
  return {
    ...permission === undefined ? {} : { permission },
    ...model === undefined ? {} : { model },
    sessionId: value['sessionId'],
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : 0,
    running: value['running'] === true,
    blank: value['blank'] === true,
    ...title === undefined ? {} : { title },
    ...typeof value['cwd'] === 'string' ? { cwd: value['cwd'] } : {},
    ...typeof value['parentSessionId'] === 'string' ? { parentSessionId: value['parentSessionId'] } : {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
