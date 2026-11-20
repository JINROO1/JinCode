/**
 * Keys of the question and approval cards, as pure reducers so the rules can be
 * tested without a terminal. Enter confirms the current question; the last
 * confirmation sends the whole batch.
 */
import {
  buildAnswers,
  emptyDrafts,
  isAnswered,
  nextUnconfirmed,
  pickRow,
  rowCount,
  setCustom,
  type AnswerItem,
  type PendingQuestion,
  type QuestionDraft,
} from '../app/interaction-rules.ts'
import { isErase, type KeyLike } from './keys.ts'

/** Where the person is on one question card. */
export interface CardState {
  /** The question shown. */
  readonly index: number
  /** The row under the cursor: an option, or the free-text row after the options. */
  readonly cursor: number
  readonly drafts: readonly QuestionDraft[]
  /** Set while the answer is being sent; keys are ignored until it settles. */
  readonly sending: boolean
}

/** What a key asks the owner to do. */
export type CardAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'submit'; readonly answers: readonly AnswerItem[] }
  | { readonly kind: 'delegate' }

/**
 * Start a card for one question.
 * @param item - the question.
 * @returns the first question, first row, nothing picked.
 */
export function startCard(item: PendingQuestion): CardState {
  return { index: 0, cursor: 0, drafts: emptyDrafts(item.questions), sending: false }
}

/**
 * Apply one key to a question card.
 * @param item - the question being answered.
 * @param state - the card state.
 * @param input - the raw input.
 * @param key - the parsed key flags.
 * @returns the next state and the action for the owner.
 */
export function reduceQuestion(
  item: PendingQuestion,
  state: CardState,
  input: string,
  key: KeyLike,
): { readonly state: CardState; readonly action: CardAction } {
  const none = { state, action: { kind: 'none' } as const }
  if (state.sending) return none
  if (key.escape === true) return { state, action: { kind: 'delegate' } }
  const question = item.questions[state.index]
  const draft = state.drafts[state.index]
  if (question === undefined || draft === undefined) return none
  const freeRow = question.options.length
  if (key.upArrow === true) return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, action: { kind: 'none' } }
  if (key.downArrow === true) {
    return { state: { ...state, cursor: Math.min(rowCount(question) - 1, state.cursor + 1) }, action: { kind: 'none' } }
  }
  if ((key.tab === true && key.shift !== true) || key.rightArrow === true) return { state: move(item, state, 1), action: { kind: 'none' } }
  if ((key.tab === true && key.shift === true) || key.leftArrow === true) return { state: move(item, state, -1), action: { kind: 'none' } }
  if (key.return === true) return confirm(item, state)
  if (isErase(key, input)) {
    if (state.cursor !== freeRow) return none
    return { state: withDraft(state, setCustom(question, draft, dropLast(draft.custom))), action: { kind: 'none' } }
  }
  if (input === ' ' && state.cursor < freeRow) {
    return { state: withDraft(state, pickRow(question, draft, state.cursor)), action: { kind: 'none' } }
  }
  if (state.cursor === freeRow && input.length > 0 && key.ctrl !== true && key.meta !== true && key.tab !== true) {
    const typed = input.replace(/[\r\n]/g, '')
    if (typed.length === 0) return none
    return { state: withDraft(state, setCustom(question, draft, draft.custom + typed)), action: { kind: 'none' } }
  }
  return none
}

/**
 * Map an approval key to the decision it asks for.
 * @param input - the raw input.
 * @param key - the parsed key flags.
 * @returns the decision, or undefined for keys that do nothing here.
 */
export function approvalKey(input: string, key: KeyLike): 'allow' | 'reject' | 'delegate' | undefined {
  if (key.escape === true) return 'delegate'
  if (key.ctrl === true || key.meta === true) return undefined
  if (input === 'y' || input === 'Y') return 'allow'
  if (input === 'n' || input === 'N') return 'reject'
  return undefined
}

/** Remove the last character of a text, counting code points. */
export function dropLast(text: string): string {
  const chars = Array.from(text)
  chars.pop()
  return chars.join('')
}

function move(item: PendingQuestion, state: CardState, step: number): CardState {
  const count = item.questions.length
  const index = (state.index + step + count) % count
  return { ...state, index, cursor: 0 }
}

function withDraft(state: CardState, draft: QuestionDraft): CardState {
  return { ...state, drafts: state.drafts.map((entry, position) => (position === state.index ? draft : entry)) }
}

function confirm(
  item: PendingQuestion,
  state: CardState,
): { readonly state: CardState; readonly action: CardAction } {
  const question = item.questions[state.index]
  const draft = state.drafts[state.index]
  if (question === undefined || draft === undefined) return { state, action: { kind: 'none' } }
  const freeRow = question.options.length
  // Enter on an option row picks it when it is not already picked.
  const picked = state.cursor < freeRow && !draft.picks.includes(state.cursor)
    ? pickRow(question, draft, state.cursor)
    : draft
  if (!isAnswered(question, picked)) {
    return { state: withDraft(state, picked), action: { kind: 'none' } }
  }
  const confirmed = { ...picked, confirmed: true }
  const drafts = state.drafts.map((entry, position) => (position === state.index ? confirmed : entry))
  const next = nextUnconfirmed(drafts, state.index)
  if (next !== undefined) {
    return { state: { ...state, drafts, index: next, cursor: 0 }, action: { kind: 'none' } }
  }
  const built = buildAnswers(item.questions, drafts)
  if ('missing' in built) return { state: { ...state, drafts }, action: { kind: 'none' } }
  return { state: { ...state, drafts, sending: true }, action: { kind: 'submit', answers: built.answers } }
}
