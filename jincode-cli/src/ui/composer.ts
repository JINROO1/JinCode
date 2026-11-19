/**
 * Pure text buffer for the message composer. The cursor is a code-point index,
 * so emoji and accented characters are never split. No terminal I/O here.
 */

/** Editable text and the cursor position inside it. */
export interface Buffer {
  readonly chars: readonly string[]
  /** Insertion point, from 0 (before the first character) to chars.length. */
  readonly cursor: number
}

/** @returns an empty buffer. */
export function emptyBuffer(): Buffer {
  return { chars: [], cursor: 0 }
}

/**
 * Build a buffer holding the text, cursor at the end.
 * @param text - initial content.
 * @returns the buffer.
 */
export function bufferOf(text: string): Buffer {
  const chars = Array.from(text)
  return { chars, cursor: chars.length }
}

/** @returns the buffer content as one string. */
export function textOf(buffer: Buffer): string {
  return buffer.chars.join('')
}

/**
 * Insert text at the cursor.
 * @param buffer - the current buffer.
 * @param text - characters to insert; newlines are kept.
 * @returns the next buffer.
 */
export function insert(buffer: Buffer, text: string): Buffer {
  const added = Array.from(text.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ''))
  if (added.length === 0) return buffer
  const chars = [...buffer.chars.slice(0, buffer.cursor), ...added, ...buffer.chars.slice(buffer.cursor)]
  return { chars, cursor: buffer.cursor + added.length }
}

/** Delete the character before the cursor. */
export function backspace(buffer: Buffer): Buffer {
  if (buffer.cursor === 0) return buffer
  return {
    chars: [...buffer.chars.slice(0, buffer.cursor - 1), ...buffer.chars.slice(buffer.cursor)],
    cursor: buffer.cursor - 1,
  }
}

/** Delete the character under the cursor. */
export function deleteForward(buffer: Buffer): Buffer {
  if (buffer.cursor >= buffer.chars.length) return buffer
  return { chars: [...buffer.chars.slice(0, buffer.cursor), ...buffer.chars.slice(buffer.cursor + 1)], cursor: buffer.cursor }
}

/** Move the cursor one character left, stopping at the start. */
export function left(buffer: Buffer): Buffer {
  return { chars: buffer.chars, cursor: Math.max(0, buffer.cursor - 1) }
}

/** Move the cursor one character right, stopping at the end. */
export function right(buffer: Buffer): Buffer {
  return { chars: buffer.chars, cursor: Math.min(buffer.chars.length, buffer.cursor + 1) }
}

/** Split the buffer into lines with the row and column of the cursor. */
export function layout(buffer: Buffer): { lines: string[]; row: number; column: number } {
  const lines: string[] = ['']
  let row = 0
  let column = 0
  buffer.chars.forEach((char, index) => {
    if (index === buffer.cursor) {
      row = lines.length - 1
      column = Array.from(lines[lines.length - 1] ?? '').length
    }
    if (char === '\n') lines.push('')
    else lines[lines.length - 1] += char
  })
  if (buffer.cursor >= buffer.chars.length) {
    row = lines.length - 1
    column = Array.from(lines[lines.length - 1] ?? '').length
  }
  return { lines, row, column }
}

/** Move the cursor to the same column on the line above, or to the start. */
export function up(buffer: Buffer): Buffer {
  const { lines, row, column } = layout(buffer)
  if (row === 0) return { chars: buffer.chars, cursor: 0 }
  return { chars: buffer.chars, cursor: indexAt(lines, row - 1, column) }
}

/** Move the cursor to the same column on the line below, or to the end. */
export function down(buffer: Buffer): Buffer {
  const { lines, row, column } = layout(buffer)
  if (row >= lines.length - 1) return { chars: buffer.chars, cursor: buffer.chars.length }
  return { chars: buffer.chars, cursor: indexAt(lines, row + 1, column) }
}

/** Move the cursor to the start of its line. */
export function home(buffer: Buffer): Buffer {
  const { lines, row } = layout(buffer)
  return { chars: buffer.chars, cursor: indexAt(lines, row, 0) }
}

/** Move the cursor to the end of its line. */
export function end(buffer: Buffer): Buffer {
  const { lines, row } = layout(buffer)
  return { chars: buffer.chars, cursor: indexAt(lines, row, Array.from(lines[row] ?? '').length) }
}

/** @returns an empty buffer. */
export function clear(): Buffer {
  return emptyBuffer()
}

function indexAt(lines: readonly string[], row: number, column: number): number {
  let index = 0
  for (let i = 0; i < row; i++) index += Array.from(lines[i] ?? '').length + 1
  return index + Math.min(column, Array.from(lines[row] ?? '').length)
}
