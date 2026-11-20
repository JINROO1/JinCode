/**
 * The answer side of the Remote API. The Host forwards each question and tool
 * approval the Agent asks as a waterfall on the `$events` stream; this client
 * keeps the open ones, answers them with `$events/result`, and drops those the
 * Host cancels. A new stream generation redelivers the open ones after a
 * reconnect. Timed questions the Host marks `continued` are answered through
 * `userQuestions/answer` instead, and they come from the Session projection.
 */
import { call, RemoteMux, type RemoteConnection, type RemoteStream } from '../wire/remote.ts'
import {
  approvalFromWaterfall,
  continuedQuestionsOf,
  parseEventsFrame,
  questionFromWaterfall,
  type AnswerItem,
  type ApprovalDecision,
  type EventsFrame,
  type PendingApproval,
  type PendingInteraction,
  type PendingQuestion,
} from './interaction-rules.ts'

/** What the client reports to its owner. */
export interface InteractionHandlers {
  /** Called with the full pending list after every change. */
  readonly onChange: (pending: readonly PendingInteraction[]) => void
  /** Called once per failure, until the stream delivers again. */
  readonly onError: (error: unknown) => void
}

/** Options for tests; production uses the defaults. */
export interface InteractionOptions {
  /** Delay before reopening the stream after it ends. */
  readonly retryMs?: number
}

/** The part of the multiplexed carrier this client uses; tests supply a fake. */
export type StreamCarrier = Pick<RemoteMux, 'open'>

type Outcome = { readonly kind: 'result'; readonly value: unknown } | { readonly kind: 'next' }

interface OpenWaterfall {
  readonly item: PendingInteraction
  readonly eventId: string
  readonly claim: RemoteStream<unknown> | undefined
}

/** Client for the forwarded-event stream and the answer RPCs. */
export class InteractionClient {
  private readonly retryMs: number
  private stream: RemoteStream<unknown> | undefined
  private clientId: string | undefined
  private generation = 0
  private closed = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly open = new Map<string, OpenWaterfall>()
  private readonly continued = new Map<string, PendingQuestion[]>()
  private readonly hidden = new Set<string>()
  private reportedError = false

  /**
   * @param connection - the authenticated connection the answers are sent on.
   * @param handlers - change and error callbacks.
   * @param mux - the shared multiplexed carrier; this client opens streams on it and never closes it.
   * @param options - retry delay.
   */
  constructor(
    private readonly connection: RemoteConnection,
    private readonly handlers: InteractionHandlers,
    private readonly mux: StreamCarrier,
    options: InteractionOptions = {},
  ) {
    this.retryMs = options.retryMs ?? 1500
  }

  /** Open the `$events` stream and keep it open until stop(). */
  start(): void {
    if (this.closed) return
    this.openStream()
  }

  /** Stop the stream and release every claim. The shared carrier stays open for its other users. */
  stop(): void {
    this.closed = true
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    for (const entry of this.open.values()) entry.claim?.cancel()
    this.stream?.cancel()
    this.stream = undefined
  }

  /** @returns the open waterfalls first, then the continued questions not hidden. */
  pending(): PendingInteraction[] {
    const waiting = [...this.open.values()].map(entry => entry.item)
    const later = [...this.continued.values()].flat().filter(item => !this.hidden.has(item.key))
    return [...waiting, ...later]
  }

  /**
   * Replace the continued questions of one Session from its projection. A call
   * the projection no longer lists as continued is dropped.
   * @param sessionId - the Session whose projection this is.
   * @param projection - its `userQuestions` projection value.
   */
  setContinued(sessionId: string, projection: unknown): void {
    const next = continuedQuestionsOf(sessionId, projection)
    if (next.length === 0) this.continued.delete(sessionId)
    else this.continued.set(sessionId, next)
    const listed = new Set([...this.continued.values()].flat().map(item => item.key))
    for (const key of this.hidden) if (!listed.has(key)) this.hidden.delete(key)
    this.notify()
  }

  /**
   * Answer a question. A waterfall question answers its open tool call; a
   * continued one is steered into the Session as a new turn.
   * @param question - the pending question.
   * @param answers - one answer per question of the card.
   */
  async answerQuestion(question: PendingQuestion, answers: readonly AnswerItem[]): Promise<void> {
    if (question.source === 'continued') {
      if (question.callId === undefined) throw new Error('the question has no call to answer')
      this.removeContinued(question)
      try {
        await call(this.connection, 'userQuestions/answer', {
          agent: question.sessionId,
          callId: question.callId,
          answer: { answers },
        })
      } catch (error: unknown) {
        this.restoreContinued(question)
        throw error
      }
      return
    }
    await this.settle(question, { kind: 'result', value: { answers } })
  }

  /**
   * Record the person's decision on a tool approval.
   * @param approval - the pending approval.
   * @param decision - allow once, or reject.
   */
  async decideApproval(approval: PendingApproval, decision: ApprovalDecision): Promise<void> {
    await this.settle(approval, { kind: 'result', value: decision })
  }

  /**
   * Pass a pending interaction on to the next answerer. A continued question
   * only leaves this view; it stays answerable from the Session. With no other
   * answerer, a refused approval fails closed on the Host.
   * @param item - the pending interaction.
   */
  async delegate(item: PendingInteraction): Promise<void> {
    if (item.kind === 'question' && item.source === 'continued') {
      this.hidden.add(item.key)
      this.notify()
      return
    }
    await this.settle(item, { kind: 'next' })
  }

  private openStream(): void {
    const generation = ++this.generation
    const stream = this.mux.open<unknown>('$events', {})
    this.stream = stream
    void (async () => {
      try {
        for await (const value of stream) {
          if (generation !== this.generation) return
          this.handleFrame(value, generation)
        }
      } catch (error: unknown) {
        if (generation === this.generation && !this.closed) this.report(error)
      }
      this.scheduleReopen(generation)
    })()
  }

  private scheduleReopen(generation: number): void {
    if (generation !== this.generation || this.closed) return
    this.clientId = undefined
    this.dropAll()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (!this.closed) this.openStream()
    }, this.retryMs)
  }

  private handleFrame(value: unknown, generation: number): void {
    const frame: EventsFrame | undefined = parseEventsFrame(value)
    if (frame === undefined) return
    if (frame.type === 'ready') {
      this.clientId = frame.clientId
      this.reportedError = false
      return
    }
    if (frame.type === 'cancel') {
      this.drop(frame.eventId)
      return
    }
    if (frame.type === 'waterfall') {
      this.receive(frame, generation).catch((error: unknown) => this.report(error))
    }
  }

  private async receive(frame: Extract<EventsFrame, { type: 'waterfall' }>, generation: number): Promise<void> {
    if (frame.event === 'user-questions/request') {
      const item = questionFromWaterfall(frame)
      if (item === undefined) return this.refuse(frame.eventId)
      const timed = await this.claim(frame, item)
      if (timed === undefined) return this.refuse(frame.eventId)
      if (generation !== this.generation) {
        timed.claim?.cancel()
        return
      }
      this.add({ item: timed.item, eventId: frame.eventId, claim: timed.claim })
      return
    }
    if (frame.event === 'approval/request') {
      const item = approvalFromWaterfall(frame)
      if (item === undefined) return this.refuse(frame.eventId)
      this.add({ item, eventId: frame.eventId, claim: undefined })
      return
    }
    return this.refuse(frame.eventId)
  }

  /**
   * Attach to a timed wait before the question is shown, so the Host knows an
   * answer UI holds it. Returns undefined when the wait has already ended.
   */
  private async claim(
    frame: Extract<EventsFrame, { type: 'waterfall' }>,
    item: PendingQuestion,
  ): Promise<{ item: PendingQuestion; claim: RemoteStream<unknown> | undefined } | undefined> {
    const wait = frame.request['wait']
    const timed = typeof wait === 'object' && wait !== null && (wait as Record<string, unknown>)['timed'] === true
    if (!timed || item.callId === undefined) return { item, claim: undefined }
    const stream = this.mux.open<unknown>('userQuestions/attachWait', { agent: item.sessionId, callId: item.callId })
    try {
      const first = await stream[Symbol.asyncIterator]().next()
      if (first.done === true) {
        stream.cancel()
        return undefined
      }
      const value = first.value
      const remaining = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)['remainingMs'] : undefined
      return {
        item: typeof remaining === 'number' ? { ...item, remainingMs: remaining } : item,
        claim: stream,
      }
    } catch {
      stream.cancel()
      return undefined
    }
  }

  private add(entry: OpenWaterfall): void {
    this.open.set(entry.eventId, entry)
    this.notify()
  }

  private drop(eventId: string): void {
    const entry = this.open.get(eventId)
    if (entry === undefined) return
    entry.claim?.cancel()
    this.open.delete(eventId)
    this.notify()
  }

  private dropAll(): void {
    for (const entry of this.open.values()) entry.claim?.cancel()
    this.open.clear()
    this.notify()
  }

  private removeContinued(question: PendingQuestion): void {
    const rest = (this.continued.get(question.sessionId) ?? []).filter(item => item.key !== question.key)
    if (rest.length === 0) this.continued.delete(question.sessionId)
    else this.continued.set(question.sessionId, rest)
    this.notify()
  }

  private restoreContinued(question: PendingQuestion): void {
    const items = this.continued.get(question.sessionId) ?? []
    this.continued.set(question.sessionId, [...items, question])
    this.notify()
  }

  /** Remove a waterfall from the open set, send the outcome, and put it back if the send fails. */
  private async settle(item: PendingInteraction, outcome: Outcome): Promise<void> {
    if (item.kind === 'question' && item.source === 'continued') throw new Error('that question is answered as a new turn')
    const eventId = item.eventId
    if (eventId === undefined) throw new Error('that request is no longer pending')
    const entry = this.open.get(eventId)
    if (entry === undefined) throw new Error('that request is no longer pending')
    this.open.delete(eventId)
    entry.claim?.cancel()
    this.notify()
    try {
      if (this.clientId === undefined) throw new Error('the event stream is not connected')
      await call(this.connection, '$events/result', { clientId: this.clientId, eventId, outcome })
    } catch (error: unknown) {
      this.open.set(eventId, { item, eventId, claim: undefined })
      this.notify()
      throw error
    }
  }

  /** Answer a waterfall the client does not handle, so the Host moves on to the next answerer. */
  private async refuse(eventId: string): Promise<void> {
    if (this.clientId === undefined) return
    await call(this.connection, '$events/result', { clientId: this.clientId, eventId, outcome: { kind: 'next' } })
  }

  private notify(): void {
    if (this.closed) return
    this.handlers.onChange(this.pending())
  }

  private report(error: unknown): void {
    if (this.reportedError) return
    this.reportedError = true
    this.handlers.onError(error)
  }
}
