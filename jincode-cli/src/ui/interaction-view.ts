/**
 * Lines of the question and approval cards. Pure: the screen renders them, and
 * the focus index tells it which line to keep in view when the card is taller
 * than the space it has.
 */
import type { PendingApproval, PendingQuestion } from '../app/interaction-rules.ts'
import type { CardState } from './interaction-keys.ts'
import { wrapText } from './layout.ts'
import type { StyledLine } from './format.ts'

/** Lines of one card and the line that carries the cursor. */
export interface CardLines {
  readonly lines: StyledLine[]
  readonly focus: number
}

/**
 * Build the lines of a question card.
 * @param item - the question.
 * @param state - the card state.
 * @param width - the width in cells.
 * @returns the lines and the focus line.
 */
export function questionCard(item: PendingQuestion, state: CardState, width: number): CardLines {
  const lines: StyledLine[] = []
  let focus = 0
  const count = item.questions.length
  const origin = item.source === 'continued' ? ' · se responde como nuevo turno' : ''
  const wait = item.remainingMs !== undefined ? ` · quedan ${Math.max(0, Math.ceil(item.remainingMs / 1000))} s` : ''
  lines.push({ text: `Pregunta del agente${origin}${wait}`, tone: 'brand', bold: true })
  for (const line of wrapText('↑↓ mover · Espacio elige · Enter confirma · Tab cambia de pregunta · Esc delega', width)) {
    lines.push({ text: line, tone: 'faint' })
  }
  item.questions.forEach((question, index) => {
    const draft = state.drafts[index]
    const current = index === state.index
    const done = draft?.confirmed === true
    const counter = count > 1 ? `${index + 1} de ${count}` : ''
    const heading = [counter, question.header].filter(part => part !== undefined && part.length > 0).join(' · ')
    if (heading.length > 0) lines.push({ text: `${heading}${done ? '  ✓' : ''}`, tone: current ? 'accent' : 'muted', bold: current })
    for (const line of wrapText(question.question, width)) lines.push({ text: line, tone: current ? 'text' : 'muted', bold: current })
    if (question.detail !== undefined) for (const line of wrapText(question.detail, width - 2)) lines.push({ text: `  ${line}`, tone: 'faint' })
    question.options.forEach((option, row) => {
      const cursor = current && state.cursor === row
      const picked = draft?.picks.includes(row) === true
      const mark = question.multiSelect ? (picked ? '[x]' : '[ ]') : (picked ? '(•)' : '( )')
      if (cursor) focus = lines.length
      lines.push({ text: `${cursor ? '›' : ' '} ${mark} ${option.label}`, tone: cursor ? 'brand' : 'text', bold: cursor })
      if (option.description !== undefined) for (const line of wrapText(option.description, width - 8)) lines.push({ text: `        ${line}`, tone: 'faint' })
    })
    const freeCursor = current && state.cursor === question.options.length
    if (freeCursor) focus = lines.length
    const typed = draft?.custom ?? ''
    const text = typed.length > 0 ? `${typed}${freeCursor ? '▌' : ''}` : (freeCursor ? '▌' : '')
    lines.push({
      text: `${freeCursor ? '›' : ' '} ${question.options.length > 0 ? 'Otra respuesta: ' : 'Respuesta: '}${text}`,
      tone: freeCursor ? 'brand' : 'muted',
      bold: freeCursor,
    })
  })
  if (state.sending) lines.push({ text: 'Enviando respuesta…', tone: 'warning' })
  return { lines, focus }
}

/**
 * Build the lines of an approval card.
 * @param item - the approval.
 * @param width - the width in cells.
 * @returns the lines; the cursor is always on the decision line.
 */
export function approvalCard(item: PendingApproval, width: number): CardLines {
  const lines: StyledLine[] = [{ text: 'Aprobación de herramienta', tone: 'brand', bold: true }]
  for (const line of wrapText(`herramienta: ${item.toolName}`, width)) lines.push({ text: line, tone: 'text', bold: true })
  if (item.reason !== undefined) for (const line of wrapText(`motivo: ${item.reason}`, width)) lines.push({ text: line, tone: 'muted' })
  const focus = lines.length
  lines.push({ text: 'y aprobar una vez · n rechazar · Esc delegar', tone: 'accent', bold: true })
  for (const line of wrapText('Sin otro respondedor, Esc deja la herramienta sin aprobar.', width)) lines.push({ text: line, tone: 'faint' })
  return { lines, focus }
}

/**
 * Keep the focus line inside a window of `height` lines.
 * @param card - the lines and focus line.
 * @param height - the number of lines available.
 * @returns the visible slice.
 */
export function windowCard(card: CardLines, height: number): StyledLine[] {
  const { lines, focus } = card
  if (lines.length <= height) return lines
  const start = Math.min(Math.max(0, focus - Math.floor(height / 2)), lines.length - height)
  return lines.slice(start, start + height)
}
