/**
 * Pure layout rules for the terminal interface: which regions are shown at a
 * given size, how text wraps by terminal cells, and which key hints fit. Nothing
 * here touches the terminal, so the rules are unit-tested directly.
 */

/** Which regions the screen shows. */
export interface Layout {
  /** `wide` shows the session sidebar beside the conversation; `compact` shows the conversation only. */
  readonly mode: 'wide' | 'compact'
  /** Columns given to the sidebar in wide mode; 0 when hidden. */
  readonly sidebarWidth: number
  /** Columns available to the conversation. */
  readonly mainWidth: number
}

/** Terminal width from which the sidebar sits beside the conversation. */
export const WIDE_BREAKPOINT = 100

/**
 * Choose the layout for a terminal width.
 * @param columns - terminal width in cells.
 * @returns the regions and their widths.
 */
export function pickLayout(columns: number): Layout {
  const width = Math.max(20, Math.floor(columns))
  if (width < WIDE_BREAKPOINT) return { mode: 'compact', sidebarWidth: 0, mainWidth: width }
  const sidebarWidth = Math.min(34, Math.max(26, Math.floor(width * 0.26)))
  return { mode: 'wide', sidebarWidth, mainWidth: width - sidebarWidth - 1 }
}

/**
 * Terminal cells a string occupies: wide East Asian and emoji code points take
 * two cells, combining marks and zero-width joiners take none.
 * @param text - the string to measure.
 * @returns the cell count.
 */
export function cellWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0 || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x0300 && code <= 0x036f)) continue
    width += isWide(code) ? 2 : 1
  }
  return width
}

/**
 * Wrap text to a cell width, breaking on spaces where possible and inside a word
 * otherwise. Existing newlines are kept.
 * @param text - the text to wrap.
 * @param width - the maximum cells per line; values below 1 are treated as 1.
 * @returns the wrapped lines.
 */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width))
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line.length === 0 ? word : `${line} ${word}`
      if (cellWidth(candidate) <= limit) {
        line = candidate
        continue
      }
      if (line.length > 0) lines.push(line)
      const pieces = breakWord(word, limit)
      line = pieces.pop() ?? ''
      lines.push(...pieces)
    }
    lines.push(line)
  }
  return lines
}

/**
 * Keep the key hints that fit in one footer row, in priority order, and append
 * an ellipsis hint when some do not fit. Nothing is cut mid-hint.
 * @param hints - hints ordered from most to least important, e.g. `Enter enviar`.
 * @param width - available cells.
 * @returns the hint line, never wider than `width`.
 */
export function fitHints(hints: readonly string[], width: number): string {
  const limit = Math.max(1, Math.floor(width))
  const separator = '  '
  const more = '…'
  const shown: string[] = []
  for (let index = 0; index < hints.length; index += 1) {
    const hint = hints[index] as string
    const used = shown.reduce((sum, item) => sum + cellWidth(item) + separator.length, 0)
    const remaining = hints.length - index - 1
    const tail = remaining > 0 ? separator.length + cellWidth(more) : 0
    if (used + cellWidth(hint) + tail <= limit) {
      shown.push(hint)
    } else {
      break
    }
  }
  if (shown.length === hints.length) return shown.join(separator)
  if (shown.length === 0) return truncate(hints[0] as string, limit)
  return `${shown.join(separator)}${separator}${more}`
}

/**
 * Cut a string to a cell width, adding an ellipsis when it had to shorten.
 * @param text - the text.
 * @param width - maximum cells.
 * @returns the text or its shortened form.
 */
export function truncate(text: string, width: number): string {
  const limit = Math.max(1, Math.floor(width))
  if (cellWidth(text) <= limit) return text
  let out = ''
  for (const char of text) {
    if (cellWidth(out + char) > limit - 1) break
    out += char
  }
  return `${out}…`
}

function breakWord(word: string, limit: number): string[] {
  const pieces: string[] = []
  let current = ''
  for (const char of word) {
    if (cellWidth(current + char) > limit && current.length > 0) {
      pieces.push(current)
      current = ''
    }
    current += char
  }
  pieces.push(current)
  return pieces
}

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd)
}

/**
 * Pack whole key hints into lines. A hint is never split: when the next one
 * does not fit on the current line, it starts a new line.
 * @param hints - hint phrases, each shown whole.
 * @param width - cells per line.
 * @param separator - text placed between hints on one line.
 * @returns the lines; every hint appears exactly once.
 */
export function packHints(hints: readonly string[], width: number, separator = '  ·  '): string[] {
  const limit = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let line = ''
  for (const hint of hints) {
    const candidate = line.length === 0 ? hint : `${line}${separator}${hint}`
    if (cellWidth(candidate) <= limit) {
      line = candidate
      continue
    }
    if (line.length > 0) lines.push(line)
    line = hint
  }
  if (line.length > 0) lines.push(line)
  return lines
}
