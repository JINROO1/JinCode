/**
 * Key helpers shared by the screen and the panel: which events erase, and how
 * a single-line field takes typed text. Ink flags one erase byte, but a held key
 * or a paste delivers several at once, so both forms are handled here.
 */
import { backspace, insert, left, right, type Buffer } from './composer.ts'

export interface KeyLike {
  backspace?: boolean
  delete?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  upArrow?: boolean
  downArrow?: boolean
  ctrl?: boolean
  meta?: boolean
  tab?: boolean
  shift?: boolean
  escape?: boolean
  return?: boolean
}

/** Apply one key to a single-line field. */
export function editField(field: Buffer, input: string, key: KeyLike): Buffer {
  if (isErase(key, input)) return eraseBack(field, input)
  if (key.leftArrow) return left(field)
  if (key.rightArrow) return right(field)
  if (key.ctrl || key.meta || key.tab || key.escape || key.return) return field
  return insert(field, input.replace(/[\r\n]/g, ''))
}

/**
 * Whether an event is an erase. Ink flags a lone erase byte, but a burst of them
 * arrives as plain text, so the input itself is checked too.
 * @param key - the parsed key flags.
 * @param input - the raw input.
 * @returns true for an erase key or a run of erase bytes.
 */
export function isErase(key: KeyLike, input: string): boolean {
  return key.backspace === true || key.delete === true || /^[\x7f\b]+$/.test(input)
}

/**
 * Erase one character per erase byte received. A terminal sends one per key,
 * but a held key or a paste can deliver several in one event.
 * @param buffer - the buffer to edit.
 * @param input - the raw input of the event.
 * @returns the buffer with that many characters removed before the cursor.
 */
export function eraseBack(buffer: Buffer, input: string): Buffer {
  const count = Math.max(1, Array.from(input).filter(char => char === '\x7f' || char === '\b').length)
  let next = buffer
  for (let i = 0; i < count; i++) next = backspace(next)
  return next
}
