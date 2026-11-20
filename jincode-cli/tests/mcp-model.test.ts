import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizationLine, normalizeMcpViews, probeRow, statusOf } from '../src/app/mcp-model.ts'

test('mcp status: each state the Host reports has a Spanish label, a tone, and the error when it gives one', () => {
  assert.deepEqual(statusOf({ state: 'connected', toolCount: 1, connectedAt: 1 }), { label: 'conectado · 1 herramienta', tone: 'success', detail: undefined, state: 'connected' })
  assert.equal(statusOf({ state: 'connected', toolCount: 4, connectedAt: 1 }).label, 'conectado · 4 herramientas')
  assert.equal(statusOf({ state: 'connecting', attempt: 0 }).label, 'conectando')
  assert.equal(statusOf({ state: 'connecting', attempt: 2 }).label, 'conectando (intento 3)')
  assert.deepEqual(statusOf({ state: 'reconnecting', attempt: 2, maxAttempts: 10, nextRetryAtMs: 1, lastError: 'spawn ENOENT' }), {
    label: 'reconectando (intento 2 de 10)', tone: 'warning', detail: 'spawn ENOENT', state: 'reconnecting',
  })
  assert.equal(statusOf({ state: 'failed', reason: 'gave-up', lastError: 'x' }).label, 'se agotaron los reintentos')
  assert.equal(statusOf({ state: 'failed', reason: 'reconnect-disabled' }).label, 'desconectado (reconexión desactivada)')
  assert.equal(statusOf({ state: 'failed', reason: 'unclosed-generation' }).label, 'bloqueado: cierre incompleto')
  assert.equal(statusOf({ state: 'failed', reason: 'load', lastError: 'bad entry' }).detail, 'bad entry')
  const cleanup = statusOf({ state: 'failed', reason: 'cleanup', result: { closeConfirmed: false, cleanupError: 'timeout al cerrar' } })
  assert.equal(cleanup.label, 'cierre sin confirmar')
  assert.equal(cleanup.tone, 'error')
  assert.equal(cleanup.detail, 'timeout al cerrar')
  assert.equal(statusOf({ state: 'disabled' }).label, 'desactivado')
  assert.equal(statusOf({ state: 'waiting-credentials', lastError: 'falta TOKEN' }).detail, 'falta TOKEN')
  assert.equal(statusOf({ state: 'waiting-authorization', reason: 'expired', lastError: 'caducó' }).label, 'esperando autorización: la concesión caducó')
  assert.equal(statusOf({ state: 'closed', result: { closeConfirmed: true } }).label, 'cerrado')
})

test('mcp status: a state the panel does not know shows its name rather than failing', () => {
  assert.deepEqual(statusOf({ state: 'future-state' }), { label: 'future-state', tone: 'muted', detail: undefined, state: 'future-state' })
  assert.equal(statusOf(undefined).label, 'estado desconocido')
})

test('mcp authorization: each phase of an OAuth attempt is named; the browser link and the failure are kept', () => {
  assert.equal(authorizationLine({ id: 'a', phase: 'starting' }), 'buscando el servidor de autorización')
  assert.equal(authorizationLine({ id: 'a', phase: 'waiting-browser', authorizationUrl: 'https://auth.example/x' }), 'esperando el navegador del Host · abre https://auth.example/x')
  assert.equal(authorizationLine({ id: 'a', phase: 'committing' }), 'guardando la concesión')
  assert.equal(authorizationLine({ id: 'a', phase: 'authorized' }), 'autorizado')
  assert.equal(authorizationLine({ id: 'a', phase: 'failed', lastError: 'access_denied' }), 'la autorización falló · access_denied')
  assert.equal(authorizationLine(undefined), undefined)
  assert.equal(authorizationLine({ id: 'a' }), undefined)
})

test('mcp list: every frame is the complete list; a malformed entry is skipped, the order is kept', () => {
  const rows = normalizeMcpViews([
    { name: 'echo', configured: true, status: { state: 'connected', toolCount: 1, connectedAt: 1 } },
    { configured: true },
    'nonsense',
    { name: 'roto', configured: false, status: { state: 'failed', reason: 'gave-up', lastError: 'spawn ENOENT' }, authorization: { id: 'x', phase: 'authorized' } },
  ])
  assert.deepEqual(rows.map(row => [row.name, row.configured, row.label, row.tone]), [
    ['echo', true, 'conectado · 1 herramienta', 'success'],
    ['roto', false, 'se agotaron los reintentos', 'error'],
  ])
  assert.equal(rows[1]?.detail, 'spawn ENOENT')
  assert.equal(rows[1]?.authorization, 'autorizado')
  assert.deepEqual(normalizeMcpViews({ not: 'a list' }), [])
})

test('mcp probe: a success names the server and its tools, capped in the text; a failure names the stage', () => {
  assert.deepEqual(probeRow('echo', { ok: true, serverInfo: { name: 'echo-test', version: '0.1.0' }, toolNames: ['echo'], truncated: false, durationMs: 3, closeConfirmed: true }), {
    name: 'echo', ok: true, text: 'correcto (echo-test 0.1.0) · 1 herramienta: echo',
  })
  const many = Array.from({ length: 10 }, (_, index) => `t${index}`)
  const capped = probeRow('big', { ok: true, toolNames: many, truncated: true, durationMs: 1, closeConfirmed: true })
  assert.equal(capped.text, 'correcto · 10 herramientas: t0, t1, t2, t3, t4, t5, t6, t7 y más')
  assert.equal(probeRow('none', { ok: true, toolNames: [], truncated: false, durationMs: 1, closeConfirmed: true }).text, 'correcto · sin herramientas')
  assert.equal(probeRow('roto', { ok: false, stage: 'connect', message: 'spawn ENOENT', durationMs: 2, closeConfirmed: true }).text, 'falló en la conexión: spawn ENOENT')
  const listing = probeRow('half', { ok: false, stage: 'list', message: 'timeout', durationMs: 9, closeConfirmed: false })
  assert.equal(listing.ok, false)
  assert.equal(listing.text, 'falló en el listado de herramientas: timeout · el cierre no se confirmó')
})
