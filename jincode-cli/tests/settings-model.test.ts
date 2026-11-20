import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canReplaceSection, fieldSummary, fieldText, parseFieldText, settingsFields, SUMMARY_CHARS, fieldEditKey, sectionEditKey } from '../src/app/settings-model.ts'
import type { SettingsRow } from '../src/app/panel-client.ts'

function row(patch: Partial<SettingsRow>): SettingsRow {
  return { ns: 'agent', revision: 1, applies: 'live', writable: true, value: {}, user: undefined, secrets: [], ...patch }
}

test('one field per top-level key, in the Host order, with overrides marked', () => {
  const fields = settingsFields([
    row({ ns: 'agent', value: { maxSteps: 40, label: 'a' }, user: { maxSteps: 40 } }),
    row({ ns: 'web', value: { fetchProvider: 'http' }, user: {} }),
  ])
  assert.deepEqual(fields.map(item => [item.ns, item.key, item.overridden]), [
    ['agent', 'maxSteps', true],
    ['agent', 'label', false],
    ['web', 'fetchProvider', false],
  ])
})

test('a top-level secret appears even when the value does not carry it, and never shows a value', () => {
  const [field] = settingsFields([row({ value: {}, secrets: [{ path: ['apiKey'], set: true }] })])
  assert.equal(field?.key, 'apiKey')
  assert.equal(field?.secret, true)
  assert.equal(field?.value, undefined)
  assert.equal(fieldSummary(field!), '●●●● configurado')
})

test('a nested secret does not become a field of its own; its parent shows the value the Host gives', () => {
  const fields = settingsFields([row({ value: { providers: { x: {} } }, secrets: [{ path: ['providers', 'x', 'apiKey'], set: true }] })])
  assert.deepEqual(fields.map(item => [item.key, item.secret]), [['providers', false]])
  assert.equal(canReplaceSection(row({ secrets: [{ path: ['providers', 'x', 'apiKey'], set: true }], user: {} })), false)
})

test('a section can be replaced only when it is writable, has a user section and no secrets', () => {
  assert.equal(canReplaceSection(row({ user: {} })), true)
  assert.equal(canReplaceSection(row({ user: undefined })), false, 'no user section means nothing to replace')
  assert.equal(canReplaceSection(row({ user: {}, writable: false })), false)
  assert.equal(canReplaceSection(row({ user: {}, secrets: [{ path: ['k'], set: false }] })), false)
})

test('typed text takes the type the field already has', () => {
  assert.deepEqual(parseFieldText('true', true, false), { ok: true, value: true })
  assert.deepEqual(parseFieldText(' FALSE ', false, false), { ok: true, value: false })
  assert.equal(parseFieldText('sí', true, false).ok, false)
  assert.deepEqual(parseFieldText('12', 4, false), { ok: true, value: 12 })
  assert.equal(parseFieldText('', 4, false).ok, false)
  assert.equal(parseFieldText('doce', 4, false).ok, false)
  assert.deepEqual(parseFieldText('http://x', 'a', false), { ok: true, value: 'http://x' })
  assert.deepEqual(parseFieldText('{"a":1}', { b: 2 }, false), { ok: true, value: { a: 1 } })
  assert.equal(parseFieldText('{roto', { b: 2 }, false).ok, false)
  assert.equal(parseFieldText('texto', { b: 2 }, false).ok, false, 'an object stays an object')
  assert.deepEqual(parseFieldText('[1,2]', undefined, false), { ok: true, value: [1, 2] })
  assert.deepEqual(parseFieldText('texto', undefined, false), { ok: true, value: 'texto' })
})

test('a secret is text and cannot be emptied', () => {
  assert.deepEqual(parseFieldText('sk-1', undefined, true), { ok: true, value: 'sk-1' })
  assert.equal(parseFieldText('', undefined, true).ok, false)
})

test('the editor opens strings as they are and everything else as JSON; long values are cut', () => {
  assert.equal(fieldText('hola'), 'hola')
  assert.equal(fieldText({ a: [1] }), '{"a":[1]}')
  const long = 'x'.repeat(SUMMARY_CHARS + 40)
  const summary = fieldSummary({ ns: 'a', key: 'k', value: long, secret: false, secretSet: false, overridden: false, revision: 1, writable: true })
  assert.ok(summary.includes('caracteres'))
  assert.ok(summary.length < SUMMARY_CHARS + 40)
})

test('edit keys name the field or the whole section', () => {
  assert.equal(fieldEditKey('agent', 'maxSteps'), 'agent\u0000maxSteps')
  assert.equal(sectionEditKey('agent'), 'agent\u0000*')
})
