/**
 * Pure model of the scheduled tasks: the Host's shapes, the text the form
 * accepts for timing and targets, and the requests the Host expects. The
 * controller and the panel use it; it does no I/O.
 */

/** Where a task delivers, as the Host stores it. */
export interface ScheduleTarget {
  readonly kind: 'session' | 'new' | 'new_once'
  readonly sessionId: string | undefined
}

/** One scheduled task as the panel shows it. */
export interface ScheduleTask {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly kind: string
  /** Human text of the timing, for example `cada 3600 s`. */
  readonly timing: string
  /** The same timing typed the way the form reads it, for example `every 3600`. */
  readonly timingText: string
  readonly status: string
  readonly scheduledAt: string | undefined
  readonly target: ScheduleTarget | undefined
  readonly involvedSessionIds: readonly string[]
  readonly updatedAt: string
  /** Whether a delivery is running now. */
  readonly executing: boolean
}

/** One delivery in the history. */
export interface ScheduleRecord {
  readonly scheduledAt: string
  readonly deliveredAt: string
  readonly targetSessionId: string
  readonly prompt: string
}

/** The form's text fields. Timing and target are typed in the forms below. */
export interface ScheduleForm {
  readonly mode: 'create' | 'edit'
  readonly id: string | undefined
  readonly expectedUpdatedAt: string | undefined
  readonly title: string
  readonly prompt: string
  readonly timing: string
  readonly target: string
}

/** Field names in the order the form shows them. */
export const SCHEDULE_FIELDS = ['title', 'prompt', 'timing', 'target'] as const
export type ScheduleField = (typeof SCHEDULE_FIELDS)[number]

/** The labels of the form fields. */
export const SCHEDULE_FIELD_LABEL: Record<ScheduleField, string> = {
  title: 'Título',
  prompt: 'Instrucción',
  timing: 'Cuándo',
  target: 'Destino',
}

/** The hint that explains the timing text. */
export const TIMING_HINT = 'after 600 · every 3600 · at 2026-12-01 09:30:00 Europe/Madrid · daily 09:00:00 UTC · weekly 09:00:00 UTC 1,3,5 · cron 0 9 * * 1 UTC · rrule DTSTART:…|RRULE:…'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Describe a task's timing in words.
 * @param item - a Host task.
 * @returns the text; unknown kinds show their name.
 */
export function timingLabel(item: Record<string, unknown>): string {
  const kind = text(item['kind']) ?? 'desconocida'
  const zone = text(item['timeZone']) ?? ''
  const time = (text(item['time']) ?? '').replace(/\.000$/, '')
  if (kind === 'after') return `en ${String(item['afterSeconds'] ?? '?')} s, una vez`
  if (kind === 'every') return `cada ${String(item['everySeconds'] ?? '?')} s`
  if (kind === 'at') return `una vez, ${text(item['scheduledAt']) ?? 'fecha fijada'}`
  if (kind === 'daily') return `cada día a las ${time} ${zone}`.trim()
  if (kind === 'weekly') {
    const days = Array.isArray(item['weekdays']) ? item['weekdays'].map(String).join(',') : '?'
    return `días ${days} a las ${time} ${zone}`.trim()
  }
  if (kind === 'cron') return `cron ${text(item['expression']) ?? '?'} ${zone}`.trim()
  if (kind === 'rrule') return `regla ${text(item['rrule']) ?? '?'}`
  return kind
}

function targetOf(value: Record<string, unknown>): ScheduleTarget {
  const kind = value['kind'] === 'new' || value['kind'] === 'new_once' ? value['kind'] : 'session'
  return { kind, sessionId: text(value['sessionId']) }
}

/**
 * The timing of a task typed the way the form reads it, so an edit starts from a value that parses.
 * @param item - a Host task.
 * @returns the typed timing.
 */
export function timingTextOf(item: Record<string, unknown>): string {
  const kind = text(item['kind']) ?? ''
  const zone = text(item['timeZone']) ?? 'UTC'
  const time = (text(item['time']) ?? '00:00:00').replace(/\.000$/, '')
  if (kind === 'after') return `after ${String(item['afterSeconds'] ?? '')}`.trim()
  if (kind === 'every') return `every ${String(item['everySeconds'] ?? '')}`.trim()
  if (kind === 'at') {
    const at = text(item['scheduledAt']) ?? ''
    return `at ${at.slice(0, 10)} ${at.slice(11, 19)} UTC`
  }
  if (kind === 'daily') return `daily ${time} ${zone}`
  if (kind === 'weekly') {
    const days = Array.isArray(item['weekdays']) ? item['weekdays'].map(String).join(',') : ''
    return `weekly ${time} ${zone} ${days}`
  }
  if (kind === 'cron') return `cron ${text(item['expression']) ?? ''} ${zone}`
  if (kind === 'rrule') return `rrule ${(text(item['rrule']) ?? '').replace(/\n/g, '|')}`
  return kind
}

/**
 * Read one task from a Host response (`schedule/view`, `create`, `edit`, `run` or a list item).
 * @param value - the Host object.
 * @returns the task, or undefined when it has no identity.
 */
export function normalizeTask(value: unknown): ScheduleTask | undefined {
  if (!isRecord(value) || typeof value['id'] !== 'string') return undefined
  const id = value['id']
  const target = isRecord(value['target']) ? targetOf(value['target']) : undefined
  return {
    id,
    title: text(value['title']) ?? id,
    prompt: text(value['prompt']) ?? '',
    kind: text(value['kind']) ?? 'desconocida',
    timing: timingLabel(value),
    timingText: timingTextOf(value),
    status: text(value['status']) ?? 'desconocido',
    scheduledAt: text(value['scheduledAt']),
    target,
    involvedSessionIds: Array.isArray(value['involvedSessionIds']) ? value['involvedSessionIds'].filter((item): item is string => typeof item === 'string') : [],
    updatedAt: text(value['updatedAt']) ?? '',
    executing: value['executionActive'] === true,
  }
}

/**
 * Read the list of tasks.
 * @param value - the `schedule/catalog` result (an array) or a page with `items`.
 * @returns the usable tasks in the Host's order.
 */
export function normalizeTasks(value: unknown): ScheduleTask[] {
  // The catalog answers with the array itself; a page answers with `items`.
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value['items']) ? value['items'] : []
  return list.flatMap((item: unknown) => {
    const task = normalizeTask(item)
    return task === undefined ? [] : [task]
  })
}

/**
 * Read the deliveries of a task.
 * @param value - the `schedule/history` result.
 * @returns the records, newest first as the Host sends them.
 */
export function normalizeRecords(value: unknown): ScheduleRecord[] {
  if (!isRecord(value) || !Array.isArray(value['records'])) return []
  return value['records'].flatMap((item) => {
    if (!isRecord(item) || typeof item['deliveredAt'] !== 'string' || typeof item['targetSessionId'] !== 'string') return []
    return [{
      scheduledAt: text(item['scheduledAt']) ?? '',
      deliveredAt: item['deliveredAt'],
      targetSessionId: item['targetSessionId'],
      prompt: text(item['prompt']) ?? '',
    }]
  })
}

/**
 * The Host answers some conflicts with a `code` instead of an error.
 * @param value - a mutation result.
 * @returns the message to show, or undefined when the mutation was applied.
 */
export function mutationProblem(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value['code'] !== 'string') return undefined
  if (value['code'] === 'schedule_conflict') return 'La programación cambió desde que la leíste. Ábrela de nuevo y repite el cambio.'
  return `La programación no se pudo cambiar (${value['code']}).`
}

/**
 * A form for a new task. The target starts as the open Session when there is one.
 * @param hasSession - whether a Session is open.
 * @returns the empty form.
 */
export function emptyScheduleForm(hasSession: boolean): ScheduleForm {
  return { mode: 'create', id: undefined, expectedUpdatedAt: undefined, title: '', prompt: '', timing: 'every 3600', target: hasSession ? 'sesión actual' : 'nueva sesión' }
}

/**
 * Read one field of the form.
 * @param form - the form.
 * @param field - the field.
 * @returns its text.
 */
export function fieldOf(form: ScheduleForm, field: ScheduleField): string {
  return form[field]
}

/**
 * Replace one field of the form.
 * @param form - the form.
 * @param field - the field.
 * @param value - the new text.
 * @returns a new form.
 */
export function withField(form: ScheduleForm, field: ScheduleField, value: string): ScheduleForm {
  return { ...form, [field]: value }
}

/**
 * Move the field focus, wrapping at both ends.
 * @param index - the current field index.
 * @param delta - +1 or -1.
 * @returns the next index.
 */
export function nextFieldIndex(index: number, delta: number): number {
  const count = SCHEDULE_FIELDS.length
  return (index + delta + count) % count
}

/**
 * The form that edits a task. Timing and target are typed again; the target reads as the current one.
 * @param task - the task to edit.
 * @returns the form with the task's text.
 */
export function scheduleFormOf(task: ScheduleTask): ScheduleForm {
  const target = task.target?.kind === 'new' ? 'nueva sesión' : task.target?.kind === 'new_once' ? 'nueva sesión una vez' : 'sesión actual'
  return { mode: 'edit', id: task.id, expectedUpdatedAt: task.updatedAt, title: task.title, prompt: task.prompt, timing: task.timingText, target }
}

/** Timing as the Host takes it. Each variant follows the schedule/create schema. */
export type TimingSpec = Record<string, unknown>

const DATE = /^\d{4}-\d{2}-\d{2}$/
const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/

function zoneOf(token: string | undefined): string | undefined {
  if (token === undefined) return undefined
  if (token === 'UTC') return token
  return /^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(token) ? token : undefined
}

function clockOf(token: string | undefined): string | undefined {
  if (token === undefined) return undefined
  const match = CLOCK.exec(token)
  if (match === null) return undefined
  const [, hours, minutes, seconds = '00', fraction = ''] = match
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return undefined
  return `${hours}:${minutes}:${seconds}${fraction}`
}

function positive(token: string | undefined): number | undefined {
  if (token === undefined || !/^\d+$/.test(token)) return undefined
  const value = Number(token)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Read the timing the form types.
 * @param input - for example `every 3600`, `daily 09:00 UTC`, `cron 0 9 * * 1 UTC`.
 * @returns the timing for the Host, or the reason it was refused.
 */
export function parseTiming(input: string): { ok: true; timing: TimingSpec } | { ok: false; error: string } {
  const trimmed = input.trim()
  const [head = '', ...rest] = trimmed.split(/\s+/)
  const kind = head.toLowerCase()
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })
  if (kind === 'rrule') {
    const rule = trimmed.slice(head.length).trim().replace(/\|/g, '\n')
    return rule.length === 0 ? fail('la regla RRULE está vacía') : { ok: true, timing: { kind: 'rrule', rrule: rule } }
  }
  if (kind === 'after') {
    const seconds = positive(rest[0])
    return seconds === undefined ? fail('after necesita segundos enteros positivos, p. ej. after 600') : { ok: true, timing: { kind, after_seconds: seconds } }
  }
  if (kind === 'every') {
    const seconds = positive(rest[0])
    return seconds === undefined ? fail('every necesita segundos enteros positivos, p. ej. every 3600') : { ok: true, timing: { kind, every_seconds: seconds } }
  }
  if (kind === 'at') {
    const [date, clock, zone] = rest
    const time = clockOf(clock)
    if (date === undefined || !DATE.test(date) || time === undefined) return fail('at necesita fecha YYYY-MM-DD y hora HH:mm[:ss], p. ej. at 2026-12-01 09:30 UTC')
    const timeZone = zoneOf(zone)
    if (timeZone === undefined) return fail('la zona debe ser UTC o Área/Ciudad, p. ej. Europe/Madrid')
    return { ok: true, timing: { kind, at: { date, time, time_zone: timeZone } } }
  }
  if (kind === 'daily') {
    const time = clockOf(rest[0])
    const timeZone = zoneOf(rest[1])
    if (time === undefined) return fail('daily necesita una hora HH:mm[:ss], p. ej. daily 09:00 UTC')
    if (timeZone === undefined) return fail('la zona debe ser UTC o Área/Ciudad')
    return { ok: true, timing: { kind, daily: { time, time_zone: timeZone } } }
  }
  if (kind === 'weekly') {
    const time = clockOf(rest[0])
    const timeZone = zoneOf(rest[1])
    const days = (rest[2] ?? '').split(',').map(Number)
    if (time === undefined || timeZone === undefined) return fail('weekly necesita hora, zona y días, p. ej. weekly 09:00 UTC 1,3,5')
    const unique = new Set(days)
    if (days.length === 0 || unique.size !== days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) return fail('los días van de 1 (lunes) a 7 (domingo), sin repetir')
    return { ok: true, timing: { kind, weekly: { time, time_zone: timeZone, weekdays: days } } }
  }
  if (kind === 'cron') {
    const fields = rest.slice(0, 5)
    const timeZone = zoneOf(rest[5])
    if (fields.length !== 5) return fail('cron necesita cinco campos y una zona, p. ej. cron 0 9 * * 1 UTC')
    if (timeZone === undefined) return fail('la zona debe ser UTC o Área/Ciudad')
    return { ok: true, timing: { kind, cron: { expression: fields.join(' '), time_zone: timeZone } } }
  }
  return fail('la temporización debe empezar por after, every, at, daily, weekly, cron o rrule')
}

/**
 * Read the destination the form types.
 * @param input - `sesión actual`, `nueva sesión` or `nueva sesión una vez`.
 * @param sessionId - the Session the form was opened in.
 * @returns the target, or the reason it was refused.
 */
export function parseTarget(input: string, sessionId: string | undefined): { ok: true; target: Record<string, unknown> } | { ok: false; error: string } {
  const value = input.trim().toLowerCase()
  if (value === '' || value === 'sesión actual' || value === 'sesion actual') {
    if (sessionId === undefined) return { ok: false, error: 'abre una sesión para elegirla como destino' }
    return { ok: true, target: { kind: 'session', sessionId } }
  }
  if (value === 'nueva sesión' || value === 'nueva sesion' || value === 'nueva') return { ok: true, target: { kind: 'new', create: {} } }
  if (value === 'nueva sesión una vez' || value === 'nueva sesion una vez' || value === 'nueva una vez') return { ok: true, target: { kind: 'new_once', create: {} } }
  return { ok: false, error: 'el destino es «sesión actual», «nueva sesión» o «nueva sesión una vez»' }
}

/**
 * Turn the form into the request `schedule/create` expects.
 * @param form - the form.
 * @param sessionId - the Session the form was opened in.
 * @returns the request, or the first problem found.
 */
export function createRequest(form: ScheduleForm, sessionId: string | undefined): { ok: true; request: Record<string, unknown> } | { ok: false; error: string } {
  const title = form.title.trim()
  const prompt = form.prompt.trim()
  if (title.length === 0) return { ok: false, error: 'el título no puede estar vacío' }
  if (title.length > 120) return { ok: false, error: 'el título tiene más de 120 caracteres' }
  if (prompt.length === 0) return { ok: false, error: 'la instrucción no puede estar vacía' }
  const timing = parseTiming(form.timing)
  if (!timing.ok) return timing
  const target = parseTarget(form.target, sessionId)
  if (!target.ok) return target
  return { ok: true, request: { title, prompt, timing: timing.timing, target: target.target } }
}

/**
 * Turn an edit form into the patch and the optimistic revision `schedule/edit` expects.
 * @param form - the form of an existing task.
 * @param sessionId - the Session the form was opened in.
 * @returns the request, or the first problem found.
 */
export function editRequest(form: ScheduleForm, sessionId: string | undefined): { ok: true; request: Record<string, unknown> } | { ok: false; error: string } {
  const created = createRequest(form, sessionId)
  if (!created.ok) return created
  if (form.id === undefined) return { ok: false, error: 'falta la programación a cambiar' }
  return {
    ok: true,
    request: { id: form.id, action: 'update', patch: created.request, expectedUpdatedAt: form.expectedUpdatedAt },
  }
}

/**
 * One line that says what a delivery was.
 * @param record - the delivery.
 * @returns the text.
 */
export function recordLine(record: ScheduleRecord): string {
  return `${record.deliveredAt.replace('T', ' ').slice(0, 16)} · ${record.prompt.length > 40 ? `${record.prompt.slice(0, 39)}…` : record.prompt}`
}

/**
 * The state of a task in words. A running delivery shows first.
 * @param task - the task.
 * @returns the label.
 */
export function statusLabelOf(task: Pick<ScheduleTask, 'status' | 'executing'>): string {
  if (task.executing) return 'ejecutando'
  if (task.status === 'active') return 'activa'
  if (task.status === 'paused') return 'pausada'
  if (task.status === 'ended') return 'terminada'
  return task.status
}
