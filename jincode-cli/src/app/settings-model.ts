/**
 * Settings editing rules, kept apart from the screen so they can be tested.
 * A namespace shows one row per top-level field of its resolved value. A field
 * is edited with `settings/mutate` (one path, one value), an override is removed
 * with `unset`, and a whole section is replaced only when it holds no secrets:
 * a replace writes back what the Host shows, and secrets never ride in that view.
 */
import type { SettingsRow } from './panel-client.ts'

/** One editable top-level field of a namespace. */
export interface SettingsField {
  readonly ns: string
  readonly key: string
  /** The resolved value, or undefined for a secret the Host does not show. */
  readonly value: unknown
  readonly secret: boolean
  /** Whether the secret slot holds a value. Only meaningful for secrets. */
  readonly secretSet: boolean
  /** Whether the user section sets this field itself, so `unset` has an effect. */
  readonly overridden: boolean
  readonly revision: number
  readonly writable: boolean
}

/**
 * List the editable fields of every namespace, in the Host's order.
 * Secret slots at the top level appear even when the value does not carry them.
 * @param rows - the namespaces from `settings/describe`.
 * @returns the fields, grouped by namespace.
 */
export function settingsFields(rows: readonly SettingsRow[]): SettingsField[] {
  const fields: SettingsField[] = []
  for (const row of rows) {
    const keys: string[] = isRecord(row.value) ? Object.keys(row.value) : []
    for (const slot of row.secrets) {
      const [head] = slot.path
      if (slot.path.length === 1 && head !== undefined && !keys.includes(head)) keys.push(head)
    }
    for (const key of keys) {
      const slot = row.secrets.find(item => item.path.length === 1 && item.path[0] === key)
      const secret = slot !== undefined
      fields.push({
        ns: row.ns,
        key,
        value: secret || !isRecord(row.value) ? undefined : row.value[key],
        secret,
        secretSet: slot?.set === true,
        overridden: row.user !== undefined && Object.prototype.hasOwnProperty.call(row.user, key),
        revision: row.revision,
        writable: row.writable,
      })
    }
  }
  return fields
}

/**
 * Whether a namespace can be replaced as a whole. A section with any secret
 * slot cannot, because its user view is redacted and a replace would erase it.
 * @param row - the namespace.
 * @returns true when `settings/replace` is safe for this namespace.
 */
export function canReplaceSection(row: SettingsRow): boolean {
  return row.writable && row.secrets.length === 0 && row.user !== undefined
}

/**
 * Read the text the user typed for a field, in the type the field already has.
 * Booleans take `true`/`false`; numbers must be finite; objects and arrays are
 * JSON; anything else is text. A secret is always text and cannot be empty.
 * @param text - what the user typed.
 * @param current - the field's current value.
 * @param secret - whether the field is a secret.
 * @returns the parsed value, or the reason it was refused.
 */
export function parseFieldText(text: string, current: unknown, secret: boolean): { ok: true; value: unknown } | { ok: false; error: string } {
  if (secret) {
    return text.length === 0 ? { ok: false, error: 'un secreto no puede quedar vacío' } : { ok: true, value: text }
  }
  if (typeof current === 'boolean') {
    const word = text.trim().toLowerCase()
    if (word === 'true') return { ok: true, value: true }
    if (word === 'false') return { ok: true, value: false }
    return { ok: false, error: 'escribe true o false' }
  }
  if (typeof current === 'number') {
    const number = Number(text.trim())
    return text.trim().length > 0 && Number.isFinite(number) ? { ok: true, value: number } : { ok: false, error: 'escribe un número' }
  }
  const trimmed = text.trim()
  const json = typeof current === 'object' && current !== null
    ? true
    : (current === undefined || current === null) && (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed === 'null')
  if (json) {
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown }
    } catch {
      return { ok: false, error: 'el JSON no es válido' }
    }
  }
  return { ok: true, value: text }
}

/**
 * The text a field shows when it is opened for editing: strings as they are,
 * everything else as compact JSON.
 * @param value - the field's current value.
 * @returns the text to edit.
 */
export function fieldText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? ''
}

/**
 * A one-line summary of a field value for the list. Secrets never show their value.
 * @param field - the field.
 * @returns the summary.
 */
export function fieldSummary(field: SettingsField): string {
  if (field.secret) return field.secretSet ? '●●●● configurado' : 'sin configurar'
  const text = JSON.stringify(field.value) ?? 'null'
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}… (${text.length} caracteres)` : text
}

/** Characters of a value shown in the list; the whole value opens in the editor. */
export const SUMMARY_CHARS = 160

/** Key of an editable field while it is being edited. */
export function fieldEditKey(ns: string, key: string): string {
  return `${ns}\u0000${key}`
}

/** Key of a whole-section edit (`settings/replace`). */
export function sectionEditKey(ns: string): string {
  return `${ns}\u0000*`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
