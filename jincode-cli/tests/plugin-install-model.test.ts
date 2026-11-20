import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failureReason, installLineOf, installOutcomeOf } from '../src/app/plugin-install-model.ts'

test('install outcome: the Host ChangeResult is read by its application, the bundle, and its error code', () => {
  const applied = installOutcomeOf({ stage: 'install', target: 'extra', changed: true, application: 'applied', bundle: 'extra', version: '0.2.0' })
  assert.deepEqual(applied, { application: 'applied', name: 'extra', version: '0.2.0', restartReason: undefined, code: undefined, diagnostic: undefined, pendingBuilds: [] })
  const failed = installOutcomeOf({ application: 'failed', error: { code: 'not-bundle', diagnostic: 'sin bundle' }, pendingBuilds: ['esbuild', '', 7] })
  assert.equal(failed.application, 'failed')
  assert.equal(failed.code, 'not-bundle')
  assert.equal(failed.diagnostic, 'sin bundle')
  assert.deepEqual(failed.pendingBuilds, ['esbuild'], 'only non-empty names are kept')
})

test('install outcome: an unknown or empty answer is unknown, never a guessed success', () => {
  for (const value of [null, undefined, 'applied', { application: 'maybe' }, { status: 'accepted' }, []]) {
    assert.equal(installOutcomeOf(value).application, 'unknown', JSON.stringify(value))
  }
  assert.equal(installLineOf(installOutcomeOf(null)).status, 'desconocido')
})

test('install line: each application has a Spanish status and a tone; a restart and an override say what to do', () => {
  assert.deepEqual(installLineOf(installOutcomeOf({ application: 'applied', bundle: 'extra', version: '0.2.0' })), {
    status: 'instalado', reason: 'extra 0.2.0 ya está activo', approvable: false, tone: 'success',
  })
  const restart = installLineOf(installOutcomeOf({ application: 'restart-required', restartReason: 'no-hmr', bundle: 'extra' }))
  assert.equal(restart.status, 'instalado')
  assert.equal(restart.reason, 'reinicie DSH para cargarlo · no-hmr')
  assert.equal(installLineOf(installOutcomeOf({ application: 'overridden' })).status, 'guardado')
  assert.equal(installLineOf(installOutcomeOf({ application: 'cancelled' })).reason, 'sus archivos se restauraron')
})

test('install line: a failure with pending scripts is approvable and names the scripts; one without is not', () => {
  const pending = installLineOf(installOutcomeOf({ application: 'failed', error: { code: 'operation-error' }, pendingBuilds: ['esbuild', 'sharp'] }))
  assert.equal(pending.status, 'pendiente de permiso')
  assert.equal(pending.approvable, true)
  assert.match(pending.reason ?? '', /esbuild, sharp/)
  const plain = installLineOf(installOutcomeOf({ application: 'failed', error: { code: 'not-bundle' } }))
  assert.equal(plain.status, 'falló')
  assert.equal(plain.approvable, false)
  assert.equal(plain.reason, 'el paquete no declara un bundle de DSH, así que no se puede administrar como plugin')
})

test('failure reasons: known codes are Spanish, an unknown code is kept as it is, and the diagnostic follows', () => {
  assert.equal(failureReason(installOutcomeOf({ application: 'failed', error: { code: 'already-installed' } })), 'este paquete ya está instalado; desinstálelo antes de instalar otra versión')
  assert.equal(failureReason(installOutcomeOf({ application: 'failed', error: { code: 'future-code' } })), 'future-code')
  assert.equal(failureReason(installOutcomeOf({ application: 'failed' })), 'sin motivo informado')
  assert.equal(failureReason(installOutcomeOf({ application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm falló' } })), 'el Host informó un error · pnpm falló')
})
