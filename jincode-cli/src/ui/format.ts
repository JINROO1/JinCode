/**
 * Turn transcript rows and Session data into styled lines for the terminal.
 * Pure: the caller decides colors through the tone names, and every line fits
 * the width it was built for, so nothing is clipped by the renderer.
 */
import { wrapText, cellWidth } from './layout.ts'
import type { TranscriptItem } from '../transcript/reducer.ts'

/** Semantic colour roles; the theme maps them to hex values. */
export type Tone = 'text' | 'muted' | 'faint' | 'brand' | 'accent' | 'user' | 'success' | 'warning' | 'error'

/** One styled terminal line. */
export interface StyledLine {
  readonly text: string
  readonly tone: Tone
  readonly bold?: boolean
  readonly italic?: boolean
}

/** Lines shown for one tool output before the rest is summarised. */
export const TOOL_OUTPUT_LINES = 12

/**
 * Lay out the transcript rows at a width.
 * @param items - the transcript rows in order.
 * @param width - the cells available.
 * @returns styled lines, every one at most `width` cells wide.
 */
export function transcriptLines(items: readonly TranscriptItem[], width: number): StyledLine[] {
  const out: StyledLine[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'user': {
        out.push(...wrapped('› Tú', width, 'user', { bold: true }))
        out.push(...indented(item.text, width, 'text'))
        out.push({ text: '', tone: 'text' })
        break
      }
      case 'assistant': {
        // A message that only calls tools has no text to show; its tool cards speak for it.
        if (item.done && item.text.length === 0 && item.reasoning.length === 0 && !item.interrupted) break
        out.push(...wrapped('◆ JinCode', width, 'brand', { bold: true }))
        if (item.reasoning.length > 0) out.push(...indented(item.reasoning, width, 'faint', { italic: true }))
        if (item.text.length > 0) out.push(...indented(item.text, width, 'text'))
        else if (!item.done) out.push(...indented('pensando…', width, 'muted', { italic: true }))
        if (item.interrupted) out.push(...indented('⚠ interrumpido', width, 'warning'))
        out.push({ text: '', tone: 'text' })
        break
      }
      case 'tool': {
        const mark = item.status === 'running' ? '◌' : item.status === 'done' ? '✓' : '✕'
        const tone: Tone = item.status === 'running' ? 'warning' : item.status === 'done' ? 'success' : 'error'
        out.push(...wrapped(`⚙ ${item.name} ${mark}`, width, 'accent', { bold: true }))
        if (item.args.length > 0 && item.args !== '{}') out.push(...indented(item.args, width, 'muted'))
        if (item.output.length > 0) {
          const lines = wrapText(item.output, Math.max(1, width - 2))
          for (const line of lines.slice(0, TOOL_OUTPUT_LINES)) out.push({ text: `  ${line}`, tone: 'muted' })
          if (lines.length > TOOL_OUTPUT_LINES) {
            out.push(...indented(`(${lines.length - TOOL_OUTPUT_LINES} líneas más en el registro)`, width, 'faint'))
          }
        }
        const status = item.status === 'running' ? 'ejecutando' : item.status === 'done' ? 'completado' : 'fallido'
        out.push(...indented(status, width, tone))
        out.push({ text: '', tone: 'text' })
        break
      }
      case 'system': {
        out.push(...indented(item.text, width, 'error'))
        out.push({ text: '', tone: 'text' })
        break
      }
      case 'turn': {
        const label = item.ended
          ? item.reason === undefined || item.reason === 'completed' ? `turno ${item.turn}` : `turno ${item.turn} · ${item.reason}`
          : `turno ${item.turn} · en curso`
        const tone: Tone = item.reason === 'error' ? 'error' : 'faint'
        if (cellWidth(` ${label} `) + 4 <= width) out.push({ text: rule(label, width), tone })
        else out.push(...wrapped(label, width, tone))
        break
      }
    }
  }
  return out
}

/** Wrap a line to the width with no indent. */
function wrapped(text: string, width: number, tone: Tone, style: Partial<StyledLine> = {}): StyledLine[] {
  return wrapText(text, Math.max(1, width)).map(line => ({ text: line, tone, ...style }))
}

/** Wrap a block to the width, indented by two cells, so every line fits. */
function indented(text: string, width: number, tone: Tone, style: Partial<StyledLine> = {}): StyledLine[] {
  return wrapText(text, Math.max(1, width - 2)).map(line => ({ text: `  ${line}`, tone, ...style }))
}

/**
 * A horizontal rule with a centred label, exactly `width` cells wide.
 * @param label - text placed in the middle.
 * @param width - total cells.
 * @returns the rule.
 */
export function rule(label: string, width: number): string {
  const inner = ` ${label} `
  const room = Math.max(0, width - cellWidth(inner))
  const left = Math.floor(room / 2)
  return '─'.repeat(left) + inner + '─'.repeat(room - left)
}

/**
 * Describe how long ago a Session was updated, in Spanish.
 * @param updatedAt - epoch milliseconds.
 * @param now - epoch milliseconds for the current time.
 * @returns a short phrase such as `hace 5 min`.
 */
export function formatAgo(updatedAt: number, now: number): string {
  if (updatedAt <= 0) return 'sin actividad'
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000))
  if (seconds < 60) return 'ahora'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `hace ${days} d`
  return new Date(updatedAt).toISOString().slice(0, 10)
}

/**
 * Mask a secret for display: bullets only, with the length so the user can
 * check what was pasted. The value itself is never returned.
 * @param value - the typed key.
 * @returns a masked label.
 */
export function maskSecret(value: string): string {
  const count = Array.from(value).length
  if (count === 0) return ''
  return `${'•'.repeat(Math.min(count, 40))}  (${count} caracteres)`
}

/** One row of the Session list, already laid out. */
export interface SessionRow {
  readonly sessionId: string
  readonly lines: readonly StyledLine[]
}

/**
 * Lay out Session rows for the sidebar or the sessions overlay. A row is its
 * title wrapped to the width, then one meta line: state and age.
 * @param sessions - rows from `session/list`, already ordered.
 * @param activeId - the open Session, highlighted.
 * @param width - cells available.
 * @param now - epoch milliseconds for relative times.
 * @returns one entry per Session, in order.
 */
export function sessionRows(
  sessions: ReadonlyArray<{ sessionId: string; title?: string; running: boolean; blank: boolean; updatedAt: number; model?: string }>,
  activeId: string | undefined,
  width: number,
  now: number,
): SessionRow[] {
  return sessions.map(session => {
    const active = session.sessionId === activeId
    const title = session.title ?? (session.blank ? 'Sesión vacía' : 'Sesión sin título')
    const titleLines = wrapText(title, Math.max(4, width - 2)).map((line, index) => ({
      text: `${index === 0 && active ? '▸' : ' '} ${line}`,
      tone: active ? 'brand' as Tone : 'text' as Tone,
      bold: active,
    }))
    const state = session.running ? '● ejecutando' : formatAgo(session.updatedAt, now)
    const meta = wrapText(`  ${state}`, Math.max(4, width)).map(line => ({ text: line, tone: session.running ? 'success' as Tone : 'muted' as Tone }))
    return { sessionId: session.sessionId, lines: [...titleLines, ...meta, { text: '', tone: 'text' as Tone }] }
  })
}
