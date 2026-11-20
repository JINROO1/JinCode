/**
 * MCP servers as the Host's `mcpManager/watch` stream reports them, turned into
 * the rows and texts the panel shows. Pure: no I/O, so it is tested directly.
 * The Host reports states; this module only names them in Spanish.
 */

/** Tone of one status, as the panel colours it. */
export type McpTone = 'success' | 'warning' | 'error' | 'muted'

/** One MCP server row of the panel. */
export interface McpServerRow {
  readonly name: string
  /** Whether a configured or registered entry still exists. */
  readonly configured: boolean
  /** The Host's state name, kept for the cursor and for tests. */
  readonly state: string
  /** The status in Spanish, for example «conectado · 3 herramientas». */
  readonly label: string
  readonly tone: McpTone
  /** The last error or the cleanup note, cut by the view to one line. */
  readonly detail: string | undefined
  /** The OAuth state, when the entry uses OAuth and an attempt exists. */
  readonly authorization: string | undefined
}

/** The last probe of one server, as the panel shows it. */
export interface McpProbeRow {
  readonly name: string
  readonly ok: boolean
  readonly text: string
}

const AUTHORIZATION_REASON: Readonly<Record<string, string>> = {
  missing: 'sin concesión guardada',
  expired: 'la concesión caducó',
  binding: 'la concesión es de otro servidor',
  rejected: 'el servidor rechazó la concesión',
  scope: 'faltan permisos en la concesión',
}

const AUTHORIZATION_PHASE: Readonly<Record<string, string>> = {
  starting: 'buscando el servidor de autorización',
  'waiting-browser': 'esperando el navegador del Host',
  exchanging: 'intercambiando el código',
  committing: 'guardando la concesión',
  authorized: 'autorizado',
  cancelled: 'autorización cancelada',
  failed: 'la autorización falló',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Name one OAuth attempt, so the panel can say what the server is waiting for.
 * @param view - the `authorization` field of a server view, when present.
 * @returns the Spanish line, or undefined when there is no attempt.
 */
export function authorizationLine(view: unknown): string | undefined {
  if (!isRecord(view)) return undefined
  const phase = text(view['phase'])
  if (phase === undefined) return undefined
  const label = AUTHORIZATION_PHASE[phase] ?? phase
  const url = text(view['authorizationUrl'])
  const failure = text(view['lastError'])
  const parts = [label]
  if (phase === 'waiting-browser' && url !== undefined) parts.push(`abre ${url}`)
  if (failure !== undefined && phase === 'failed') parts.push(failure)
  return parts.join(' · ')
}

/**
 * Name one server status in Spanish.
 * @param status - the `status` field of a server view.
 * @returns the label, the tone, and the detail line when the Host gives one.
 */
export function statusOf(status: unknown): { label: string; tone: McpTone; detail: string | undefined; state: string } {
  if (!isRecord(status)) return { label: 'estado desconocido', tone: 'muted', detail: undefined, state: 'unknown' }
  const state = text(status['state']) ?? 'unknown'
  const lastError = text(status['lastError'])
  switch (state) {
    case 'connected': {
      const tools = count(status['toolCount'])
      return { label: `conectado · ${tools} ${tools === 1 ? 'herramienta' : 'herramientas'}`, tone: 'success', detail: undefined, state }
    }
    case 'connecting': {
      const attempt = count(status['attempt'])
      return { label: attempt > 0 ? `conectando (intento ${attempt + 1})` : 'conectando', tone: 'warning', detail: undefined, state }
    }
    case 'reconnecting':
      return {
        label: `reconectando (intento ${count(status['attempt'])} de ${count(status['maxAttempts'])})`,
        tone: 'warning',
        detail: lastError,
        state,
      }
    case 'failed': {
      const reason = text(status['reason'])
      if (reason === 'cleanup') {
        const result = isRecord(status['result']) ? status['result'] : {}
        const cleanup = text(result['cleanupError'])
        return {
          label: 'cierre sin confirmar',
          tone: 'error',
          detail: cleanup ?? 'el cierre del servidor no se confirmó; reiniciar el Host lo libera',
          state,
        }
      }
      if (reason === 'load') return { label: 'no se pudo cargar', tone: 'error', detail: lastError, state }
      if (reason === 'gave-up') return { label: 'se agotaron los reintentos', tone: 'error', detail: lastError, state }
      if (reason === 'reconnect-disabled') return { label: 'desconectado (reconexión desactivada)', tone: 'error', detail: lastError, state }
      if (reason === 'unclosed-generation') return { label: 'bloqueado: cierre incompleto', tone: 'error', detail: lastError, state }
      return { label: 'falló', tone: 'error', detail: lastError, state }
    }
    case 'disabled':
      return { label: 'desactivado', tone: 'muted', detail: undefined, state }
    case 'waiting-credentials':
      return { label: 'esperando credenciales', tone: 'warning', detail: lastError, state }
    case 'waiting-authorization': {
      const reason = text(status['reason'])
      const why = reason === undefined ? undefined : AUTHORIZATION_REASON[reason] ?? reason
      return {
        label: why === undefined ? 'esperando autorización' : `esperando autorización: ${why}`,
        tone: 'warning',
        detail: lastError,
        state,
      }
    }
    case 'closed':
      return { label: 'cerrado', tone: 'muted', detail: undefined, state }
    default:
      return { label: state, tone: 'muted', detail: lastError, state }
  }
}

/**
 * Read the list the `mcpManager/watch` stream sends: the complete list each time.
 * @param value - one frame of the stream.
 * @returns the rows, in the Host's order; malformed entries are skipped.
 */
export function normalizeMcpViews(value: unknown): McpServerRow[] {
  if (!Array.isArray(value)) return []
  const rows: McpServerRow[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item['name'] !== 'string') continue
    const status = statusOf(item['status'])
    rows.push({
      name: item['name'],
      configured: item['configured'] !== false,
      state: status.state,
      label: status.label,
      tone: status.tone,
      detail: status.detail,
      authorization: authorizationLine(item['authorization']),
    })
  }
  return rows
}

/**
 * Say what a probe found, in one line.
 * @param name - the server probed.
 * @param value - the `mcpManager/probe` result.
 * @returns the text and whether the probe succeeded.
 */
export function probeRow(name: string, value: unknown): McpProbeRow {
  const record = isRecord(value) ? value : {}
  const closeNote = record['closeConfirmed'] === false ? ' · el cierre no se confirmó' : ''
  if (record['ok'] === true) {
    const names = Array.isArray(record['toolNames']) ? record['toolNames'].filter((item): item is string => typeof item === 'string') : []
    const info = isRecord(record['serverInfo']) ? text(record['serverInfo']['name']) : undefined
    const version = isRecord(record['serverInfo']) ? text(record['serverInfo']['version']) : undefined
    const who = info === undefined ? '' : ` (${info}${version === undefined ? '' : ` ${version}`})`
    const more = record['truncated'] === true ? ' y más' : ''
    const tools = names.length === 0 ? 'sin herramientas' : `${names.length} ${names.length === 1 ? 'herramienta' : 'herramientas'}: ${names.slice(0, 8).join(', ')}${more}`
    return { name, ok: true, text: `correcto${who} · ${tools}${closeNote}` }
  }
  const stage = record['stage'] === 'list' ? 'el listado de herramientas' : 'la conexión'
  const message = text(record['message']) ?? 'sin detalle'
  return { name, ok: false, text: `falló en ${stage}: ${message}${closeNote}` }
}
