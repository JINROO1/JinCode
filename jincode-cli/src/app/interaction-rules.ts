/**
 * Pure rules for the questions and approvals the Agent asks the person.
 * They parse Host frames, keep the answer draft of one question card, and
 * decide when a draft is complete. No I/O, so every rule is testable alone.
 */

/** One choice of an `ask_user_question` question. */
export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

/** One question of a request, as the Host sent it. */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options: readonly QuestionOption[]
  readonly multiSelect: boolean
}

/** One structured answer, the shape `$events/result` and `userQuestions/answer` expect. */
export interface AnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** A question the Agent is waiting on. `waterfall` answers the open tool call; `continued` answers a new turn. */
export interface PendingQuestion {
  readonly kind: 'question'
  readonly key: string
  readonly source: 'waterfall' | 'continued'
  readonly sessionId: string
  readonly eventId?: string
  readonly callId?: string
  readonly questions: readonly QuestionItem[]
  /** Milliseconds left in a timed wait, when the Host reported one. */
  readonly remainingMs?: number
}

/** A tool call waiting for the person's decision. */
export interface PendingApproval {
  readonly kind: 'approval'
  readonly key: string
  readonly eventId: string
  readonly sessionId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
}

export type PendingInteraction = PendingQuestion | PendingApproval

/** The decisions a person can take on an approval. */
export type ApprovalDecision = 'allowed-once' | 'rejected'

/** Downlink frames of the `$events` stream this client reads. */
export type EventsFrame =
  | { readonly type: 'ready'; readonly clientId: string }
  | { readonly type: 'waterfall'; readonly event: string; readonly eventId: string; readonly agentId: string; readonly request: Record<string, unknown> }
  | { readonly type: 'cancel'; readonly eventId: string }
  | { readonly type: 'emit'; readonly event: string; readonly args: readonly unknown[] }

/**
 * Parse one `$events` frame.
 * @param value - the stream item as the Host sent it.
 * @returns the frame, or undefined when its shape is not one this client reads.
 */
export function parseEventsFrame(value: unknown): EventsFrame | undefined {
  if (!isRecord(value)) return undefined
  if (value['type'] === 'ready' && typeof value['clientId'] === 'string') {
    return { type: 'ready', clientId: value['clientId'] }
  }
  if (value['type'] === 'cancel' && typeof value['eventId'] === 'string') {
    return { type: 'cancel', eventId: value['eventId'] }
  }
  if (value['type'] === 'emit' && typeof value['event'] === 'string' && Array.isArray(value['args'])) {
    return { type: 'emit', event: value['event'], args: value['args'] }
  }
  if (value['type'] === 'waterfall' && typeof value['event'] === 'string' && typeof value['eventId'] === 'string'
    && typeof value['agentId'] === 'string' && isRecord(value['request'])) {
    return {
      type: 'waterfall',
      event: value['event'],
      eventId: value['eventId'],
      agentId: value['agentId'],
      request: value['request'],
    }
  }
  return undefined
}

/**
 * Read the questions of one `user-questions/request` payload. A question without
 * a usable id or text is dropped; a request left with no question is refused.
 * @param value - the `questions` array of the request.
 * @returns the valid questions, or undefined when none is valid.
 */
export function questionsOf(value: unknown): QuestionItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const questions: QuestionItem[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['question'] !== 'string') continue
    const options: QuestionOption[] = []
    if (Array.isArray(item['options'])) {
      for (const option of item['options']) {
        if (!isRecord(option) || typeof option['label'] !== 'string') continue
        options.push({
          label: option['label'],
          ...typeof option['description'] === 'string' ? { description: option['description'] } : {},
        })
      }
    }
    questions.push({
      id: item['id'],
      question: item['question'],
      ...typeof item['detail'] === 'string' ? { detail: item['detail'] } : {},
      ...typeof item['header'] === 'string' ? { header: item['header'] } : {},
      options,
      multiSelect: item['multiSelect'] === true,
    })
  }
  return questions.length > 0 ? questions : undefined
}

/**
 * Turn a `user-questions/request` waterfall into a pending question.
 * @param frame - the waterfall frame.
 * @returns the question, or undefined when the request carries no valid question.
 */
export function questionFromWaterfall(frame: Extract<EventsFrame, { type: 'waterfall' }>): PendingQuestion | undefined {
  const questions = questionsOf(frame.request['questions'])
  if (questions === undefined) return undefined
  const wait = isRecord(frame.request['wait']) ? frame.request['wait'] : undefined
  const callId = wait !== undefined && typeof wait['callId'] === 'string' ? wait['callId'] : undefined
  return {
    kind: 'question',
    key: `waterfall:${frame.eventId}`,
    source: 'waterfall',
    sessionId: frame.agentId,
    eventId: frame.eventId,
    ...callId === undefined ? {} : { callId },
    questions,
  }
}

/**
 * Turn a `approval/request` waterfall into a pending approval.
 * @param frame - the waterfall frame.
 * @returns the approval, or undefined when the request names no tool.
 */
export function approvalFromWaterfall(frame: Extract<EventsFrame, { type: 'waterfall' }>): PendingApproval | undefined {
  const toolName = frame.request['toolName']
  if (typeof toolName !== 'string' || toolName.length === 0) return undefined
  const callId = typeof frame.request['callId'] === 'string' ? frame.request['callId'] : undefined
  const reason = typeof frame.request['reason'] === 'string' ? frame.request['reason'] : undefined
  return {
    kind: 'approval',
    key: `approval:${frame.eventId}`,
    eventId: frame.eventId,
    sessionId: frame.agentId,
    toolName,
    ...callId === undefined ? {} : { callId },
    ...reason === undefined ? {} : { reason },
  }
}

/**
 * Read the questions a Session's projection lists as `continued`: timed questions
 * whose wait ended and that can now be answered as a new turn.
 * @param sessionId - the Session that owns the projection.
 * @param projection - the `userQuestions` projection value.
 * @returns one pending question per continued call, in ask order.
 */
export function continuedQuestionsOf(sessionId: string, projection: unknown): PendingQuestion[] {
  if (!isRecord(projection) || !Array.isArray(projection['active'])) return []
  const pending: PendingQuestion[] = []
  for (const entry of projection['active']) {
    if (!isRecord(entry) || entry['state'] !== 'continued' || typeof entry['callId'] !== 'string') continue
    const questions = questionsOf(entry['questions'])
    if (questions === undefined) continue
    pending.push({
      kind: 'question',
      key: `continued:${sessionId}:${entry['callId']}`,
      source: 'continued',
      sessionId,
      callId: entry['callId'],
      questions,
    })
  }
  return pending
}

/**
 * Draft of one question card: which rows are picked and the free text.
 * `confirmed` is set when the person presses Enter on the question.
 */
export interface QuestionDraft {
  readonly picks: readonly number[]
  readonly custom: string
  readonly confirmed: boolean
}

/** Starting draft for a list of questions. */
export function emptyDrafts(questions: readonly QuestionItem[]): QuestionDraft[] {
  return questions.map(() => ({ picks: [], custom: '', confirmed: false }))
}

/**
 * Rows a question card shows: its options, then the free-text "Other" row.
 * @param question - the question.
 * @returns the number of rows.
 */
export function rowCount(question: QuestionItem): number {
  return question.options.length + 1
}

/**
 * Whether one draft holds an answer.
 * @param question - the question.
 * @param draft - its draft.
 * @returns true when at least one option or some free text is chosen.
 */
export function isAnswered(_question: QuestionItem, draft: QuestionDraft): boolean {
  return draft.picks.length > 0 || draft.custom.trim().length > 0
}

/**
 * Select a row for one question. A single-select question keeps one pick;
 * a multi-select question toggles the row. The free-text row is never a pick.
 * @param question - the question.
 * @param draft - the current draft.
 * @param row - the option index.
 * @returns the next draft.
 */
export function pickRow(question: QuestionItem, draft: QuestionDraft, row: number): QuestionDraft {
  if (row < 0 || row >= question.options.length) return draft
  if (!question.multiSelect) return { ...draft, picks: [row], custom: '', confirmed: false }
  const picks = draft.picks.includes(row) ? draft.picks.filter(item => item !== row) : [...draft.picks, row]
  return { ...draft, picks, confirmed: false }
}

/**
 * Build the complete answer batch once every question is confirmed and answered.
 * @param questions - the questions of the card.
 * @param drafts - one draft per question.
 * @returns the answers, or the ids of the questions still unanswered.
 */
export function buildAnswers(
  questions: readonly QuestionItem[],
  drafts: readonly QuestionDraft[],
): { readonly answers: AnswerItem[] } | { readonly missing: string[] } {
  const missing: string[] = []
  const answers: AnswerItem[] = []
  questions.forEach((question, index) => {
    const draft = drafts[index]
    if (draft === undefined || !draft.confirmed || !isAnswered(question, draft)) {
      missing.push(question.id)
      return
    }
    const selected = [...draft.picks].sort((a, b) => a - b).map(row => question.options[row]?.label ?? '')
      .filter(label => label.length > 0)
    const custom = draft.custom.trim()
    answers.push({
      id: question.id,
      selected,
      ...custom.length > 0 ? { custom } : {},
    })
  })
  return missing.length === 0 ? { answers } : { missing }
}

/**
 * Index of the first question not yet confirmed, starting after `from`.
 * @param drafts - the drafts.
 * @param from - the question the person is on.
 * @returns that index, or undefined when every question is confirmed.
 */
export function nextUnconfirmed(drafts: readonly QuestionDraft[], from: number): number | undefined {
  for (let step = 1; step <= drafts.length; step += 1) {
    const index = (from + step) % drafts.length
    if (drafts[index] !== undefined && !drafts[index].confirmed) return index
  }
  return undefined
}

/**
 * Apply one edit to a draft's free text. A single-select question keeps one
 * answer, so typing text clears any option pick; a multi-select question may
 * combine picks with text.
 * @param question - the question.
 * @param draft - the current draft.
 * @param text - the new text.
 * @returns the next draft.
 */
export function setCustom(question: QuestionItem, draft: QuestionDraft, text: string): QuestionDraft {
  if (!question.multiSelect) return { ...draft, picks: [], custom: text, confirmed: false }
  return { ...draft, custom: text, confirmed: false }
}

/**
 * Heading line of a question card: the header, when present, then the question.
 * @param question - the question.
 * @returns the plain text.
 */
export function questionTitle(question: QuestionItem): string {
  return question.header !== undefined && question.header.length > 0
    ? `${question.header}: ${question.question}`
    : question.question
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
