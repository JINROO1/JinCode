import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAgo, maskSecret, rule, transcriptLines, TOOL_OUTPUT_LINES } from '../src/ui/format.ts'
import { cellWidth } from '../src/ui/layout.ts'
import type { TranscriptItem } from '../src/transcript/reducer.ts'

test('every transcript line fits the width it was laid out for', () => {
  const long = 'palabra '.repeat(60) + 'supercalifragilisticoespialidosoxxxxxxxxxxxxxxxxxxxxxx'
  const items: TranscriptItem[] = [
    { kind: 'user', id: 'u', text: long },
    { kind: 'assistant', key: 'a', turn: 1, step: 1, text: long, reasoning: long, done: true, interrupted: false },
    { kind: 'tool', turn: 1, callId: 'c', name: 'bash', args: long, output: long, status: 'done' },
    { kind: 'system', id: 's', text: long },
    { kind: 'turn', turn: 1, ended: true, reason: 'error' },
  ]
  for (const width of [14, 40, 80]) {
    for (const line of transcriptLines(items, width)) {
      assert.ok(cellWidth(line.text) <= width, `"${line.text}" wider than ${width}`)
    }
  }
})

test('tool output longer than the limit is summarised with the count', () => {
  const output = Array.from({ length: TOOL_OUTPUT_LINES + 5 }, (_, i) => `línea ${i}`).join('\n')
  const lines = transcriptLines([{ kind: 'tool', turn: 1, callId: 'c', name: 'bash', args: '{}', output, status: 'done' }], 60)
  assert.ok(lines.some(line => line.text.includes('5 líneas más')))
  assert.ok(lines.some(line => line.text.includes(`línea ${TOOL_OUTPUT_LINES - 1}`)))
  assert.ok(!lines.some(line => line.text.includes(`línea ${TOOL_OUTPUT_LINES}`)))
})

test('a running assistant with no text yet says it is thinking', () => {
  const lines = transcriptLines([{ kind: 'assistant', key: 'a', turn: 1, step: 1, text: '', reasoning: '', done: false, interrupted: false }], 40)
  assert.ok(lines.some(line => line.text.includes('pensando')))
})

test('a failed turn is labelled with its reason in error colour', () => {
  const lines = transcriptLines([{ kind: 'turn', turn: 3, ended: true, reason: 'error' }], 40)
  assert.equal(lines[0]?.tone, 'error')
  assert.ok(lines[0]?.text.includes('turno 3 · error'))
  assert.equal(cellWidth(lines[0]?.text ?? ''), 40)
})

test('rule centres its label within the exact width', () => {
  assert.equal(cellWidth(rule('turno 1', 33)), 33)
  assert.ok(rule('x', 9).includes(' x '))
})

test('formatAgo speaks in short Spanish phrases', () => {
  const now = Date.UTC(2026, 10, 19, 12, 0, 0)
  assert.equal(formatAgo(now - 5_000, now), 'ahora')
  assert.equal(formatAgo(now - 5 * 60_000, now), 'hace 5 min')
  assert.equal(formatAgo(now - 3 * 3_600_000, now), 'hace 3 h')
  assert.equal(formatAgo(now - 2 * 86_400_000, now), 'hace 2 d')
  assert.equal(formatAgo(0, now), 'sin actividad')
})

test('maskSecret never returns the value, only its length', () => {
  const masked = maskSecret('sk-secreto-123')
  assert.ok(!masked.includes('secreto'))
  assert.ok(masked.includes('14 caracteres'))
  assert.equal(maskSecret(''), '')
})

test('sessionRows keeps every title whole and fits the width', async () => {
  const { sessionRows } = await import('../src/ui/format.ts')
  const now = Date.UTC(2026, 10, 19)
  const rows = sessionRows([
    { sessionId: 'a', title: 'Una conversación con un título muy largo que debe envolverse sin cortarse', running: true, blank: false, updatedAt: now },
    { sessionId: 'b', running: false, blank: true, updatedAt: now - 3_600_000 },
  ], 'a', 24, now)
  assert.equal(rows.length, 2)
  for (const row of rows) for (const line of row.lines) assert.ok(cellWidth(line.text) <= 24, `"${line.text}" too wide`)
  const titleText = rows[0]!.lines.filter(line => line.tone === 'brand' || line.tone === 'text').map(line => line.text.slice(2)).join(' ')
  assert.ok(titleText.replace(/\s+/g, ' ').includes('título muy largo que debe envolverse sin cortarse'))
  assert.ok(rows[0]!.lines.some(line => line.text.includes('ejecutando')))
  assert.equal(rows[1]!.lines.find(line => line.text.includes('hace'))?.text.trim(), 'hace 1 h')
  assert.ok(rows[1]!.lines[0]!.text.includes('Sesión vacía'))
})

test('a finished assistant message with no text shows no empty header', () => {
  const lines = transcriptLines([{ kind: 'assistant', key: 'a', turn: 1, step: 1, text: '', reasoning: '', done: true, interrupted: false }], 40)
  assert.equal(lines.length, 0)
})
