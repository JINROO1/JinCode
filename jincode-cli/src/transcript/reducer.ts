/**
 * Pure transcript reducer. It turns the Session event log (durable events and
 * live assistant-stream frames) into the rows the terminal draws. It has no I/O
 * and no UI dependency, so it is covered directly by unit tests.
 */

/** One visible row of the conversation. */
export type TranscriptItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | {
    readonly kind: 'assistant'
    readonly key: string
    readonly turn: number
    readonly step: number
    readonly text: string
    readonly reasoning: string
    readonly done: boolean
    readonly interrupted: boolean
  }
  | {
    readonly kind: 'tool'
    /** Turn that issued the call; call ids are only unique within a turn. */
    readonly turn: number
    readonly callId: string
    readonly name: string
    readonly args: string
    readonly output: string
    readonly status: 'running' | 'done' | 'error'
  }
  | { readonly kind: 'system'; readonly id: string; readonly text: string }
  | { readonly kind: 'turn'; readonly turn: number; readonly ended: boolean; readonly reason?: string }

/** The reduced state of one Session conversation. */
export interface Transcript {
  readonly items: readonly TranscriptItem[]
  /** Highest durable seq applied; older or equal events are ignored. */
  readonly lastSeq: number
  /** A turn has started and not yet ended. */
  readonly running: boolean
  readonly title?: string
  /** Live attempt id → assistant item key, so deltas find their row. */
  readonly attempts: Readonly<Record<string, string>>
}

/** A durable Session event as the Host serializes it. */
export interface WireEvent {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data: unknown
}

/** A live assistant-stream frame (`assistant-stream` on the follow stream). */
export type LiveFrame =
  | { readonly type: 'start'; readonly attemptId: string; readonly turn: number; readonly step: number }
  | { readonly type: 'chunk'; readonly attemptId: string; readonly chunk: unknown }
  | { readonly type: 'end'; readonly attemptId: string }

/** The starting state of an empty conversation. */
export function emptyTranscript(): Transcript {
  return { items: [], lastSeq: 0, running: false, attempts: {} }
}

/**
 * Apply one durable event. Events at or below `lastSeq` are replays and are ignored.
 * @param state - the current transcript.
 * @param event - a durable Session event.
 * @returns the next transcript.
 */
export function applyEvent(state: Transcript, event: WireEvent): Transcript {
  if (event.seq <= state.lastSeq) return state
  const next = reduceEvent(state, event)
  return { ...next, lastSeq: event.seq }
}

/**
 * Apply one live stream frame. Live frames carry no seq; they are provisional
 * until the durable `assistant/message` replaces them.
 * @param state - the current transcript.
 * @param frame - a live assistant-stream frame.
 * @returns the next transcript.
 */
export function applyLiveFrame(state: Transcript, frame: LiveFrame): Transcript {
  if (frame.type === 'start') {
    const key = assistantKey(frame.turn, frame.step)
    return {
      ...state,
      attempts: { ...state.attempts, [frame.attemptId]: key },
      items: upsertAssistant(state.items, key, frame.turn, frame.step, a => a),
    }
  }
  if (frame.type === 'end') return state
  const key = state.attempts[frame.attemptId]
  if (key === undefined) return state
  const chunk = asRecord(frame.chunk)
  if (chunk === undefined) return state
  return { ...state, items: applyChunk(state.items, key, chunk) }
}

/**
 * Plain text of a content block list (text blocks only), joined by newlines.
 * @param content - the wire content value.
 * @returns the concatenated text.
 */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    if ((record['type'] === 'text') && typeof record['text'] === 'string') parts.push(record['text'])
    else if (record['type'] === 'tool-result') parts.push(textOf(record['content']))
  }
  return parts.join('\n')
}

function reduceEvent(state: Transcript, event: WireEvent): Transcript {
  const data = asRecord(event.data) ?? {}
  switch (event.type) {
    case 'user/message': {
      // Only the user's own input is conversation. Runtime context (working
      // directory, skill catalog, time) is model-facing and stays out of view.
      const source = asRecord(data['source'])
      if (source !== undefined && source['kind'] !== 'user') return state
      const id = stringOr(data['id'], `user-${event.seq}`)
      return { ...state, items: [...state.items, { kind: 'user', id, text: textOf(data['content']) }] }
    }
    case 'turn/start': {
      const turn = numberOr(data['turn'], 0)
      return { ...state, running: true, items: [...state.items, { kind: 'turn', turn, ended: false }] }
    }
    case 'turn/end': {
      const turn = numberOr(data['turn'], 0)
      const reasonRecord = asRecord(data['reason'])
      const reason = typeof data['reason'] === 'string' ? data['reason'] : reasonRecord?.['kind'] as string | undefined
      const failure = reasonRecord?.['kind'] === 'error' ? errorMessageOf(reasonRecord['error']) : undefined
      // A turn that failed before any text leaves an empty assistant row behind; drop it.
      const items = state.items
        .filter(item => !(item.kind === 'assistant' && item.turn === turn && !item.done && item.text === '' && item.reasoning === ''))
        .map(item => (item.kind === 'turn' && item.turn === turn && !item.ended)
          ? { kind: 'turn' as const, turn, ended: true, ...reason === undefined ? {} : { reason } }
          : item)
      const withFailure: TranscriptItem[] = failure === undefined
        ? items
        : [...items, { kind: 'system', id: `error-${event.seq}`, text: failure }]
      return { ...state, running: false, items: withFailure }
    }
    case 'assistant/chunk': {
      const turn = numberOr(data['turn'], 0)
      const step = numberOr(data['step'], 0)
      const chunk = asRecord(data['chunk'])
      if (chunk === undefined) return state
      const key = assistantKey(turn, step)
      return { ...state, items: applyChunk(upsertAssistant(state.items, key, turn, step, a => a), key, chunk) }
    }
    case 'assistant/message': {
      const turn = numberOr(data['turn'], 0)
      const step = numberOr(data['step'], 0)
      const message = asRecord(data['message']) ?? {}
      const key = assistantKey(turn, step)
      const interrupted = data['interrupted'] === true
      return {
        ...state,
        items: upsertAssistant(state.items, key, turn, step, a => ({
          ...a,
          text: textOf(message['content']) || a.text,
          reasoning: reasoningOf(message['content']) || a.reasoning,
          done: true,
          interrupted,
        })),
      }
    }
    case 'tool/call': {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : 0
      const callId = stringOr(data['callId'], `call-${event.seq}`)
      const name = stringOr(data['name'], 'tool')
      const args = stringOr(data['arguments'], '')
      const exists = state.items.some(item => item.kind === 'tool' && item.turn === turn && item.callId === callId)
      if (exists) return state
      return { ...state, items: [...state.items, { kind: 'tool', turn, callId, name, args, output: '', status: 'running' }] }
    }
    case 'tool/result': {
      const message = asRecord(data['message']) ?? {}
      const output = textOf(message['content'])
      const failed = data['error'] !== undefined || message['isError'] === true
      const callId = toolCallIdOf(message)
      const turn = typeof data['turn'] === 'number' ? data['turn'] : undefined
      return {
        ...state,
        items: state.items.map(item => (item.kind === 'tool'
          && item.status === 'running'
          && (callId === undefined || item.callId === callId)
          && (turn === undefined || item.turn === turn))
          ? { ...item, output, status: failed ? 'error' : 'done' }
          : item),
      }
    }
    case 'session/title': {
      const title = typeof data['title'] === 'string' ? data['title'] : undefined
      return title === undefined ? state : { ...state, title }
    }
    default:
      return state
  }
}

function applyChunk(items: readonly TranscriptItem[], key: string, chunk: Record<string, unknown>): readonly TranscriptItem[] {
  const type = chunk['type']
  if (type === 'text-delta' && typeof chunk['text'] === 'string') {
    const delta = chunk['text']
    return items.map(item => (item.kind === 'assistant' && item.key === key) ? { ...item, text: item.text + delta } : item)
  }
  if (type === 'reasoning-delta' && typeof chunk['text'] === 'string') {
    const delta = chunk['text']
    return items.map(item => (item.kind === 'assistant' && item.key === key) ? { ...item, reasoning: item.reasoning + delta } : item)
  }
  return items
}

function upsertAssistant(
  items: readonly TranscriptItem[],
  key: string,
  turn: number,
  step: number,
  update: (item: Extract<TranscriptItem, { kind: 'assistant' }>) => Extract<TranscriptItem, { kind: 'assistant' }>,
): TranscriptItem[] {
  if (items.some(item => item.kind === 'assistant' && item.key === key)) {
    return items.map(item => (item.kind === 'assistant' && item.key === key) ? update(item) : item)
  }
  const created = update({ kind: 'assistant', key, turn, step, text: '', reasoning: '', done: false, interrupted: false })
  return [...items, created]
}

function assistantKey(turn: number, step: number): string {
  return `a:${turn}:${step}`
}

function reasoningOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => asRecord(block))
    .filter((block): block is Record<string, unknown> => block !== undefined && block['type'] === 'reasoning' && typeof block['text'] === 'string')
    .map(block => block['text'] as string)
    .join('\n')
}

/**
 * The call a tool result answers. The Host carries it on the message itself;
 * older records carried it on a tool-result block inside the content.
 * @param message - the tool-result message record.
 * @returns the call id, when the record names one.
 */
function toolCallIdOf(message: Record<string, unknown>): string | undefined {
  if (typeof message['toolCallId'] === 'string') return message['toolCallId']
  const source = asRecord(message['source'])
  if (source !== undefined && typeof source['callId'] === 'string') return source['callId']
  if (!Array.isArray(message['content'])) return undefined
  for (const block of message['content']) {
    const record = asRecord(block)
    if (record !== undefined && record['type'] === 'tool-result' && typeof record['toolCallId'] === 'string') return record['toolCallId']
  }
  return undefined
}

function errorMessageOf(error: unknown): string | undefined {
  const record = asRecord(error)
  if (record !== undefined && typeof record['message'] === 'string' && record['message'].length > 0) return record['message']
  return typeof error === 'string' && error.length > 0 ? error : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
