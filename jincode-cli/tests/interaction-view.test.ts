import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalCard, questionCard, windowCard } from '../src/ui/interaction-view.ts'
import { startCard } from '../src/ui/interaction-keys.ts'
import type { PendingApproval, PendingQuestion } from '../src/app/interaction-rules.ts'

const question: PendingQuestion = {
  kind: 'question', key: 'k', source: 'waterfall', sessionId: 's', eventId: 'e', remainingMs: 42_000,
  questions: [
    { id: 'a', question: 'Primera pregunta muy larga para que el texto se ajuste al ancho disponible', header: 'Uno', options: [{ label: 'Sí', description: 'con detalle' }, { label: 'No' }], multiSelect: false },
    { id: 'b', question: 'Segunda', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
  ],
}

test('question card shows the heading, the countdown, the options and the free-text row', () => {
  const card = questionCard(question, startCard(question), 40)
  const text = card.lines.map(line => line.text)
  assert.equal(text[0], 'Pregunta del agente · quedan 42 s')
  assert.ok(text.some(line => line.includes('1 de 2 · Uno')))
  assert.ok(text.some(line => line.includes('› ( ) Sí')))
  assert.ok(text.some(line => line.includes('con detalle')))
  assert.ok(text.some(line => line.includes('Otra respuesta: ')))
  assert.equal(card.lines[card.focus]?.text.startsWith('›'), true)
})

test('question card marks picks, confirmed questions and the continued origin', () => {
  const continued: PendingQuestion = { ...question, source: 'continued', remainingMs: undefined }
  const state = {
    ...startCard(continued),
    drafts: [{ picks: [1], custom: '', confirmed: true }, { picks: [0, 1], custom: 'extra', confirmed: false }],
    cursor: 0,
    index: 0,
  }
  const text = questionCard(continued, state, 60).lines.map(line => line.text)
  assert.equal(text[0], 'Pregunta del agente · se responde como nuevo turno')
  assert.ok(text.some(line => line.includes('1 de 2 · Uno  ✓')))
  assert.ok(text.some(line => line.includes('(•) No')))
  const multi = questionCard(continued, { ...state, index: 1, cursor: 0 }, 60).lines.map(line => line.text)
  assert.ok(multi.some(line => line.includes('[x] X')))
  assert.ok(multi.some(line => line.includes('[x] Y')))
  assert.ok(multi.some(line => line.includes('Otra respuesta: extra')))
})

test('the sending state is shown while the answer is in flight', () => {
  const card = questionCard(question, { ...startCard(question), sending: true }, 40)
  assert.equal(card.lines.at(-1)?.text, 'Enviando respuesta…')
})

test('approval card names the tool and the reason and keeps the decision line in focus', () => {
  const approval: PendingApproval = { kind: 'approval', key: 'a', eventId: 'e', sessionId: 's', toolName: 'bash', reason: 'borrar carpeta' }
  const card = approvalCard(approval, 40)
  const text = card.lines.map(line => line.text)
  assert.equal(text[0], 'Aprobación de herramienta')
  assert.ok(text.includes('herramienta: bash'))
  assert.ok(text.includes('motivo: borrar carpeta'))
  assert.equal(card.lines[card.focus]?.text, 'y aprobar una vez · n rechazar · Esc delegar')
})

test('windowCard keeps the focus line visible in a short space', () => {
  const lines = Array.from({ length: 30 }, (_, index) => ({ text: `l${index}`, tone: 'text' as const }))
  const window = windowCard({ lines, focus: 25 }, 5)
  assert.equal(window.length, 5)
  assert.ok(window.some(line => line.text === 'l25'))
  assert.equal(windowCard({ lines, focus: 0 }, 40).length, 30)
})
