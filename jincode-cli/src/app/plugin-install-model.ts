/**
 * What an installation's result says, read from the Host's ChangeResult. The Host answers
 * `pluginManager/installBundle` with the change it made: its `application` decides the outcome,
 * `error.code` says why a failure failed, and `pendingBuilds` lists the install scripts pnpm did
 * not run, which the person may allow for this profile before a retry.
 */

export type InstallApplication = 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled' | 'unknown'

export interface InstallOutcome {
  readonly application: InstallApplication
  /** The bundle the installation added, when it added one. */
  readonly name: string | undefined
  readonly version: string | undefined
  readonly restartReason: string | undefined
  /** The Host's refusal code, for a failure. */
  readonly code: string | undefined
  /** The diagnostic the Host gave with the refusal, when it gave one. */
  readonly diagnostic: string | undefined
  /** Package names whose install scripts were not run and may be allowed. */
  readonly pendingBuilds: readonly string[]
}

const APPLICATIONS: readonly InstallApplication[] = ['applied', 'restart-required', 'overridden', 'failed', 'cancelled']

/**
 * Read the Host's installation answer. Unknown shapes become `unknown`, never a guess.
 * @param value - the `pluginManager/installBundle` result.
 * @returns the outcome.
 */
export function installOutcomeOf(value: unknown): InstallOutcome {
  const record = isRecord(value) ? value : {}
  const application = APPLICATIONS.find(item => item === record['application']) ?? 'unknown'
  const error = isRecord(record['error']) ? record['error'] : {}
  return {
    application,
    name: text(record['bundle']),
    version: text(record['version']),
    restartReason: text(record['restartReason']),
    code: text(error['code']),
    diagnostic: text(error['diagnostic']),
    pendingBuilds: Array.isArray(record['pendingBuilds'])
      ? record['pendingBuilds'].filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [],
  }
}

/** What a settled installation shows in the panel. */
export interface InstallLine {
  /** Short status, the first word the person reads. */
  readonly status: string
  /** The sentence that explains the status; absent when the status says all there is. */
  readonly reason: string | undefined
  /** Whether a retry with the pending scripts allowed is offered. */
  readonly approvable: boolean
  readonly tone: 'success' | 'warning' | 'error' | 'muted'
}

/**
 * The panel line for an installation outcome. Spanish, like the rest of the panel.
 * @param outcome - the outcome read by `installOutcomeOf`.
 * @returns the line.
 */
export function installLineOf(outcome: InstallOutcome): InstallLine {
  const approvable = outcome.application === 'failed' && outcome.pendingBuilds.length > 0
  if (approvable) {
    return {
      status: 'pendiente de permiso',
      reason: `pnpm no ejecutó los scripts de instalación de ${outcome.pendingBuilds.join(', ')}; Enter, con el mismo texto, los permite para este perfil y vuelve a instalar.`,
      approvable: true,
      tone: 'warning',
    }
  }
  switch (outcome.application) {
    case 'applied':
      return { status: 'instalado', reason: outcome.name === undefined ? undefined : `${outcome.name}${outcome.version === undefined ? '' : ` ${outcome.version}`} ya está activo`, approvable: false, tone: 'success' }
    case 'restart-required':
      return { status: 'instalado', reason: `reinicie DSH para cargarlo${outcome.restartReason === undefined ? '' : ` · ${outcome.restartReason}`}`, approvable: false, tone: 'success' }
    case 'overridden':
      return { status: 'guardado', reason: 'otra configuración de mayor prioridad lo anula; no está vigente', approvable: false, tone: 'warning' }
    case 'cancelled':
      return { status: 'cancelada', reason: 'sus archivos se restauraron', approvable: false, tone: 'muted' }
    case 'failed':
      return { status: 'falló', reason: failureReason(outcome), approvable: false, tone: 'error' }
    default:
      return { status: 'desconocido', reason: 'el Host no dijo el resultado de la instalación; revise Plugins antes de volver a intentarlo', approvable: false, tone: 'warning' }
  }
}

/**
 * Why an installation failed, in Spanish, from the Host's refusal code.
 * @param outcome - a failed outcome.
 * @returns the sentence.
 */
export function failureReason(outcome: InstallOutcome): string {
  const reasons: Record<string, string> = {
    'invalid-spec': 'la especificación del paquete no es válida',
    'already-installed': 'este paquete ya está instalado; desinstálelo antes de instalar otra versión',
    'ambiguous-install': 'no se puede saber qué paquete se instaló a partir del cambio de dependencias',
    'not-bundle': 'el paquete no declara un bundle de DSH, así que no se puede administrar como plugin',
    'incompatible-version': 'el paquete es incompatible con esta versión de DSH',
    'unsupported-platform': 'el paquete no admite este sistema operativo',
    'unexpected-package': 'la fuente instaló otro paquete o versión; se deshizo la instalación',
    'stale-approval': 'las aprobaciones de scripts pendientes cambiaron; vuelva a instalarlo',
    'operation-error': 'el Host informó un error',
  }
  const known = outcome.code === undefined ? undefined : reasons[outcome.code]
  const cause = known ?? (outcome.code === undefined ? 'sin motivo informado' : outcome.code)
  return outcome.diagnostic === undefined ? cause : `${cause} · ${outcome.diagnostic}`
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
