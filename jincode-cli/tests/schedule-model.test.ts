import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRequest,
  editRequest,
  emptyScheduleForm,
  mutationProblem,
  nextFieldIndex,
  normalizeRecords,
  normalizeTask,
  normalizeTasks,
  parseTarget,
  parseTiming,
  recordLine,
  scheduleFormOf,
  statusLabelOf,
  timingLabel,
  withField,
  fieldOf,
} from '../src/app/schedule-model.ts'

test('every timing kind the form types becomes the Host shape', () => {
  assert.deepEqual(parseTiming('after 600'), { ok: true, timing: { kind: 'after', after_seconds: 600 } })
  assert.deepEqual(parseTiming('every 3600'), { ok: true, timing: { kind: 'every', every_seconds: 3600 } })
  assert.deepEqual(parseTiming('at 2026-12-01 09:30 Europe/Madrid'), { ok: true, timing: { kind: 'at', at: { date: '2026-12-01', time: '09:30:00', time_zone: 'Europe/Madrid' } } })
  assert.deepEqual(parseTiming('daily 09:00 UTC'), { ok: true, timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } } })
  assert.deepEqual(parseTiming('weekly 09:00:30 UTC 1,3,5'), { ok: true, timing: { kind: 'weekly', weekly: { time: '09:00:30', time_zone: 'UTC', weekdays: [1, 3, 5] } } })
  assert.deepEqual(parseTiming('cron 0 9 * * 1 UTC'), { ok: true, timing: { kind: 'cron', cron: { expression: '0 9 * * 1', time_zone: 'UTC' } } })
  assert.deepEqual(parseTiming('rrule DTSTART:20261201T090000Z|RRULE:FREQ=DAILY'), { ok: true, timing: { kind: 'rrule', rrule: 'DTSTART:20261201T090000Z\nRRULE:FREQ=DAILY' } })
})

test('a timing the form cannot read says what to type instead', () => {
  const refused = (input: string): string => {
    const result = parseTiming(input)
    assert.equal(result.ok, false, input)
    return result.ok ? '' : result.error
  }
  assert.match(refused('after 0'), /after necesita/)
  assert.match(refused('every -5'), /every necesita/)
  assert.match(refused('at 2026-12-01'), /at necesita fecha/)
  assert.match(refused('at 2026-12-01 09:30 Madrid'), /zona debe ser UTC/)
  assert.match(refused('daily 25:00 UTC'), /daily necesita una hora/)
  assert.match(refused('weekly 09:00 UTC 1,9'), /días van de 1/)
  assert.match(refused('weekly 09:00 UTC 2,2'), /sin repetir/)
  assert.match(refused('cron 0 9 * *'), /cron necesita cinco campos/)
  assert.match(refused('rrule   '), /RRULE está vacía/)
  assert.match(refused('mensual'), /debe empezar por/)
})

test('targets: the open Session, a new Session, or a new Session once', () => {
  assert.deepEqual(parseTarget('sesión actual', 's-1'), { ok: true, target: { kind: 'session', sessionId: 's-1' } })
  assert.deepEqual(parseTarget('nueva sesión', 's-1'), { ok: true, target: { kind: 'new', create: {} } })
  assert.deepEqual(parseTarget('Nueva sesión una vez', undefined), { ok: true, target: { kind: 'new_once', create: {} } })
  assert.equal(parseTarget('sesión actual', undefined).ok, false, 'no open Session to target')
  assert.equal(parseTarget('otra', 's-1').ok, false)
})

test('a create form is checked before anything is sent', () => {
  const base = emptyScheduleForm(true)
  assert.deepEqual(createRequest({ ...base, title: '  Resumen  ', prompt: ' hola ' }, 's-1'), {
    ok: true,
    request: { title: 'Resumen', prompt: 'hola', timing: { kind: 'every', every_seconds: 3600 }, target: { kind: 'session', sessionId: 's-1' } },
  })
  const blank = createRequest({ ...base, title: '   ', prompt: 'p' }, 's-1')
  assert.equal(blank.ok, false)
  assert.equal(blank.ok ? '' : blank.error, 'el título no puede estar vacío')
  const long = createRequest({ ...base, title: 'x'.repeat(121), prompt: 'p' }, 's-1')
  assert.equal(long.ok ? '' : long.error, 'el título tiene más de 120 caracteres')
  const empty = createRequest({ ...base, title: 't', prompt: '  ' }, 's-1')
  assert.equal(empty.ok ? '' : empty.error, 'la instrucción no puede estar vacía')
})

test('an empty target starts as the open Session, or as a new one without a Session', () => {
  assert.equal(emptyScheduleForm(true).target, 'sesión actual')
  assert.equal(emptyScheduleForm(false).target, 'nueva sesión')
})

test('an edit keeps the revision the form read, and the task identity', () => {
  const task = normalizeTask({ id: 'sch-1', kind: 'daily', title: 'Diario', prompt: 'resume', time: '09:00:00.000', timeZone: 'UTC', status: 'paused', target: { kind: 'new', create: {} }, involvedSessionIds: [], updatedAt: '2026-11-19T10:00:00.000Z' })
  assert.ok(task)
  const form = scheduleFormOf(task)
  assert.equal(form.mode, 'edit')
  assert.equal(form.target, 'nueva sesión', 'the form shows the current destination')
  const request = editRequest(form, 's-1')
  assert.equal(request.ok, true)
  assert.deepEqual(request.ok ? request.request : {}, {
    id: 'sch-1',
    action: 'update',
    patch: { title: 'Diario', prompt: 'resume', timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } }, target: { kind: 'new', create: {} } },
    expectedUpdatedAt: '2026-11-19T10:00:00.000Z',
  })
})

test('tasks read from the catalog array or from a page, and keep the Host state', () => {
  const item = {
    id: 'sch-1', kind: 'every', title: 'Resumen', prompt: 'p', everySeconds: 3600, scheduledAt: '2026-11-20T10:00:00.000Z',
    target: { kind: 'session', sessionId: 's-1' }, involvedSessionIds: ['s-1'], status: 'paused', updatedAt: 'u1', executionActive: true,
  }
  const [task] = normalizeTasks([item])
  assert.deepEqual(task, {
    id: 'sch-1', title: 'Resumen', prompt: 'p', kind: 'every', timing: 'cada 3600 s', timingText: 'every 3600', status: 'paused', scheduledAt: '2026-11-20T10:00:00.000Z',
    target: { kind: 'session', sessionId: 's-1' }, involvedSessionIds: ['s-1'], updatedAt: 'u1', executing: true,
  })
  assert.equal(normalizeTasks({ items: [item] }).length, 1, 'a page with items reads the same')
  assert.deepEqual(normalizeTasks({ items: [] }), [])
  assert.deepEqual(normalizeTasks([{ title: 'sin id' }]), [], 'a task without identity is skipped')
  assert.equal(normalizeTask({ id: 's2' })?.title, 's2', 'a missing title falls back to the id')
  assert.equal(normalizeTask({ id: 's2' })?.status, 'desconocido')
})

test('a task keeps its timing typed the way the form reads it, so an edit parses again', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ kind: 'after', afterSeconds: 600 }, 'after 600'],
    [{ kind: 'every', everySeconds: 60 }, 'every 60'],
    [{ kind: 'at', scheduledAt: '2026-12-01T09:30:00.000Z' }, 'at 2026-12-01 09:30:00 UTC'],
    [{ kind: 'daily', time: '09:00:00.000', timeZone: 'Europe/Madrid' }, 'daily 09:00:00 Europe/Madrid'],
    [{ kind: 'weekly', time: '09:30:00.000', timeZone: 'UTC', weekdays: [1, 3] }, 'weekly 09:30:00 UTC 1,3'],
    [{ kind: 'cron', expression: '0 9 * * 1', timeZone: 'UTC' }, 'cron 0 9 * * 1 UTC'],
    [{ kind: 'rrule', rrule: 'DTSTART:20261201T090000Z\nRRULE:FREQ=DAILY' }, 'rrule DTSTART:20261201T090000Z|RRULE:FREQ=DAILY'],
  ]
  for (const [item, typed] of cases) {
    const task = normalizeTask({ id: 'x', title: 't', prompt: 'p', status: 'active', updatedAt: 'u', ...item })
    assert.equal(task?.timingText, typed)
    assert.equal(parseTiming(typed).ok, true, `${typed} must parse`)
  }
})

test('timing labels cover every kind the Host stores', () => {
  assert.equal(timingLabel({ kind: 'after', afterSeconds: 600 }), 'en 600 s, una vez')
  assert.equal(timingLabel({ kind: 'every', everySeconds: 60 }), 'cada 60 s')
  assert.equal(timingLabel({ kind: 'daily', time: '09:00:00.000', timeZone: 'UTC' }), 'cada día a las 09:00:00 UTC')
  assert.equal(timingLabel({ kind: 'weekly', time: '09:30:00.000', timeZone: 'UTC', weekdays: [1, 3] }), 'días 1,3 a las 09:30:00 UTC')
  assert.equal(timingLabel({ kind: 'cron', expression: '0 9 * * 1', timeZone: 'UTC' }), 'cron 0 9 * * 1 UTC')
  assert.equal(timingLabel({ kind: 'rrule', rrule: 'FREQ=DAILY' }), 'regla FREQ=DAILY')
  assert.equal(timingLabel({ kind: 'nueva' }), 'nueva')
})

test('deliveries are read newest first, and a line keeps the prompt short', () => {
  const records = normalizeRecords({
    records: [
      { scheduledAt: '2026-11-19T10:00:00.000Z', deliveredAt: '2026-11-19T10:00:01.000Z', messageId: 'm', targetSessionId: 's-1', prompt: 'a'.repeat(60) },
      { scheduledAt: 'x' },
    ],
  })
  assert.equal(records.length, 1)
  assert.equal(recordLine(records[0]!), `2026-11-19 10:00 · ${'a'.repeat(39)}…`)
  assert.deepEqual(normalizeRecords({}), [])
})

test('a conflict or refusal is reported as a message, a clean answer is no problem', () => {
  assert.equal(mutationProblem({ id: 's', code: 'schedule_conflict' }), 'La programación cambió desde que la leíste. Ábrela de nuevo y repite el cambio.')
  assert.equal(mutationProblem({ id: 's', code: 'schedule_missing' }), 'La programación no se pudo cambiar (schedule_missing).')
  assert.equal(mutationProblem({ id: 's', deleted: true }), undefined)
  assert.equal(mutationProblem(null), undefined)
})

test('status labels read in Spanish; a running delivery shows first', () => {
  assert.equal(statusLabelOf({ status: 'active', executing: false }), 'activa')
  assert.equal(statusLabelOf({ status: 'paused', executing: false }), 'pausada')
  assert.equal(statusLabelOf({ status: 'ended', executing: false }), 'terminada')
  assert.equal(statusLabelOf({ status: 'active', executing: true }), 'ejecutando')
  assert.equal(statusLabelOf({ status: 'raro', executing: false }), 'raro')
})

test('the form fields wrap and hold their own text', () => {
  assert.equal(nextFieldIndex(0, -1), 3)
  assert.equal(nextFieldIndex(3, 1), 0)
  const form = withField(emptyScheduleForm(true), 'prompt', 'hola')
  assert.equal(fieldOf(form, 'prompt'), 'hola')
  assert.equal(fieldOf(form, 'title'), '')
})
