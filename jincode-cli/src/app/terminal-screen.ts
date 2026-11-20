/**
 * The screen of one attached terminal. It runs the Host's output through a
 * headless emulator and turns the viewport into styled runs Ink can draw.
 */
// The ESM entry of the headless build exports only its default object.
import xterm, { type IBufferCell } from '@xterm/headless'

const { Terminal } = xterm

/** The style of one run of cells. Colors are `#rrggbb`; undefined is the terminal default. */
export interface CellStyle {
  readonly fg: string | undefined
  readonly bg: string | undefined
  readonly bold: boolean
  readonly italic: boolean
  readonly underline: boolean
  readonly inverse: boolean
  readonly dim: boolean
}

/** Consecutive cells with the same style. */
export interface ScreenRun {
  readonly text: string
  readonly style: CellStyle
}

/** One row of the viewport. */
export type ScreenLine = readonly ScreenRun[]

/** The 16 base colors, as xterm draws them by default. */
const BASE_16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
]

/**
 * The hex color of a palette index.
 * @param index - 0 to 255.
 * @returns `#rrggbb`.
 */
export function paletteHex(index: number): string {
  if (index < 16) return BASE_16[index] ?? '#ffffff'
  if (index < 232) {
    const level = (value: number): number => (value === 0 ? 0 : 55 + value * 40)
    const offset = index - 16
    const red = level(Math.floor(offset / 36))
    const green = level(Math.floor(offset / 6) % 6)
    const blue = level(offset % 6)
    return `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`
  }
  const gray = 8 + (index - 232) * 10
  const hex = gray.toString(16).padStart(2, '0')
  return `#${hex}${hex}${hex}`
}

function rgbHex(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`
}

function colorOf(cell: IBufferCell, foreground: boolean): string | undefined {
  if (foreground) {
    if (cell.isFgDefault()) return undefined
    if (cell.isFgRGB()) return rgbHex(cell.getFgColor())
    return paletteHex(cell.getFgColor())
  }
  if (cell.isBgDefault()) return undefined
  if (cell.isBgRGB()) return rgbHex(cell.getBgColor())
  return paletteHex(cell.getBgColor())
}

/** Emulates one terminal screen. Output is written in order; a snapshot replaces the screen. */
export class ScreenBuffer {
  private term: InstanceType<typeof Terminal>

  /**
   * @param cols - columns.
   * @param rows - rows.
   * @param scrollback - lines kept above the viewport.
   */
  constructor(cols: number, rows: number, scrollback = 1000) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  }

  /**
   * Feed output.
   * @param data - the bytes the Host sent.
   * @returns when the emulator has taken the bytes.
   */
  write(data: string): Promise<void> {
    return new Promise(resolve => this.term.write(data, resolve))
  }

  /**
   * Replace the whole screen with a snapshot.
   * @param screen - the snapshot the Host sent.
   */
  async reset(screen: string): Promise<void> {
    this.term.reset()
    await this.write(screen)
  }

  /**
   * Change the size of the emulated screen.
   * @param cols - columns.
   * @param rows - rows.
   */
  resize(cols: number, rows: number): void {
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows)
  }

  /** @returns the viewport size. */
  size(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows }
  }

  /** @returns whether the program asked for application cursor keys (arrows as `ESC O x`). */
  applicationCursor(): boolean {
    return this.term.modes.applicationCursorKeysMode
  }

  /** @returns the cursor position inside the viewport. */
  cursor(): { x: number; y: number } {
    const buffer = this.term.buffer.active
    return { x: buffer.cursorX, y: buffer.cursorY }
  }

  /**
   * The viewport as styled runs. The cursor cell is drawn inverted when `withCursor` is set.
   * @param withCursor - whether to mark the cursor cell.
   * @returns one entry per row.
   */
  lines(withCursor = true): ScreenLine[] {
    const buffer = this.term.buffer.active
    const cursor = withCursor ? this.cursor() : undefined
    const nullCell = buffer.getNullCell()
    const out: ScreenLine[] = []
    for (let y = 0; y < this.term.rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y)
      const runs: ScreenRun[] = []
      if (line !== undefined) {
        for (let x = 0; x < this.term.cols; x += 1) {
          const current = line.getCell(x, nullCell)
          if (current === undefined || current.getWidth() === 0) continue
          const style = styleOf(current)
          const atCursor = cursor !== undefined && cursor.x === x && cursor.y === y
          const finalStyle = atCursor ? { ...style, inverse: !style.inverse } : style
          const text = current.getChars() || ' '
          const last = runs[runs.length - 1]
          if (last !== undefined && sameStyle(last.style, finalStyle)) runs[runs.length - 1] = { text: last.text + text, style: last.style }
          else runs.push({ text, style: finalStyle })
        }
      }
      out.push(runs)
    }
    return out
  }

  /** Free the emulator. */
  dispose(): void {
    this.term.dispose()
  }
}

function styleOf(cell: IBufferCell): CellStyle {
  return {
    fg: colorOf(cell, true),
    bg: colorOf(cell, false),
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    inverse: cell.isInverse() !== 0,
    dim: cell.isDim() !== 0,
  }
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic
    && a.underline === b.underline && a.inverse === b.inverse && a.dim === b.dim
}

/**
 * The plain text of one row, for tests and for copying.
 * @param line - a row from `lines()`.
 * @returns the characters without styles.
 */
export function plainText(line: ScreenLine): string {
  return line.map(run => run.text).join('')
}
