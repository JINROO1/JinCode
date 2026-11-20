/**
 * Application state and actions, independent of the rendering library. The UI
 * subscribes to snapshots and calls actions; every Host call goes through here.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { call, RemoteMux, type RemoteConnection } from '../wire/remote.ts'
import {
  SessionClient,
  type Follow,
  type ModelChoice,
  type SessionSummary,
} from './session-client.ts'
import { InteractionClient } from './interactions.ts'
import {
  imageMediaTypeOf,
  fileNameOf,
  resolvePath,
  sizeProblem,
  type AttachmentDraft,
} from './attachments.ts'
import type {
  AnswerItem,
  ApprovalDecision,
  PendingApproval,
  PendingInteraction,
  PendingQuestion,
} from './interaction-rules.ts'
import { emptyTranscript, type Transcript } from '../transcript/reducer.ts'
import { canReplaceSection } from './settings-model.ts'
import { applyWorkspaceFrame, emptyWorkspaces, groupRows, sessionMove, workspaceMove, type GroupableSession, type WorkspaceView } from './workspace-model.ts'
import {
  PanelClient,
  type GoalView,
  type PresetView,
  type QueueRow,
  type ScheduleRow,
  type SettingsRow,
  type SettingOp,
  type SkillRow,
} from './panel-client.ts'

/** The overlay covering the conversation, if any. */
export type Overlay = 'none' | 'sessions' | 'models' | 'keys' | 'rename' | 'search' | 'help' | 'panel' | 'attach'

/** How often the Session list is read again while a turn runs, to find continued questions. */
const POLL_MS = 2500

/** One change in the Workspace section. */
export type WorkspaceAction =
  | { readonly kind: 'create'; readonly path: string }
  | { readonly kind: 'rename'; readonly workspaceId: string; readonly title: string }
  | { readonly kind: 'delete'; readonly workspaceId: string }
  | { readonly kind: 'moveWorkspace'; readonly workspaceId: string; readonly direction: -1 | 1 }
  | { readonly kind: 'pin'; readonly sessionId: string; readonly pinned: boolean }
  | { readonly kind: 'archive'; readonly sessionId: string; readonly archived: boolean }
  | { readonly kind: 'moveSession'; readonly index: number; readonly direction: -1 | 1 }

/** One change to a namespace from the settings section. */
export type SettingAction =
  | { readonly kind: 'set'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'unset'; readonly key: string }
  | { readonly kind: 'replace'; readonly section: Record<string, unknown> }

/** Sections of the panel, in the order Tab cycles through them. */
export const PANEL_SECTIONS = ['queue', 'permissions', 'settings', 'workspaces', 'goals', 'schedule', 'skills'] as const
export type PanelSection = (typeof PANEL_SECTIONS)[number]

/** One provider route as the Host lists it. */
export interface ProviderRoute {
  readonly id: string
  readonly name: string
  /** Whether a key is stored under this route's reference. */
  readonly configured: boolean
}

/** A read-only snapshot the UI renders. */
export interface AppState {
  readonly sessions: readonly SessionSummary[]
  readonly activeId: string | undefined
  readonly transcript: Transcript
  readonly models: readonly ModelChoice[]
  readonly defaultChoice: ModelChoice | undefined
  readonly modelCursor: number
  readonly providers: readonly ProviderRoute[]
  readonly keyCursor: number
  readonly searchResults: ReadonlyArray<{ sessionId: string; snippet: string }>
  /** Why content search did not run, when the title and folder match is all there is. */
  readonly searchNote: string | undefined
  readonly panel: PanelState
  /** Questions and approvals waiting for the person; the first one is shown. */
  readonly interactions: readonly PendingInteraction[]
  /** Attachments waiting for the next prompt of the active Session. */
  readonly attachments: readonly AttachmentDraft[]
  readonly overlay: Overlay
  readonly notice: string | undefined
  readonly error: string | undefined
}

/** Data behind the panel sections. Undefined means not loaded yet. */
export interface PanelState {
  readonly section: PanelSection
  readonly queue: readonly QueueRow[] | undefined
  readonly presets: PresetView | undefined
  readonly settings: readonly SettingsRow[] | undefined
  /** The Workspace registry, pins and archives; undefined until the baseline arrives. */
  readonly workspaces: WorkspaceView | undefined
  /** `null` when the Session has no goal; undefined before the first read. */
  readonly goal: GoalView | null | undefined
  readonly schedules: readonly ScheduleRow[] | undefined
  readonly skills: readonly SkillRow[] | undefined
  readonly note: string | undefined
}

/**
 * Derive the credential reference a provider's key is stored under. It matches
 * the Models page (`deriveKeyRef`), so a key saved in either place is the same.
 * @param provider - provider route id, for example `jincode`.
 * @returns the reference, for example `JINCODE_API_KEY`.
 */
export function keyRefFor(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Whether a Session matches a search by its title or its working folder. This
 * is the sidebar search of the web interface, which works without the content index.
 * @param session - the Session summary.
 * @param query - the text typed, matched case-insensitively.
 * @returns true when the title or the folder contains the text.
 */
export function matchesTitleOrFolder(session: SessionSummary, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (needle.length === 0) return false
  return (session.title ?? '').toLocaleLowerCase().includes(needle)
    || (session.cwd ?? '').toLocaleLowerCase().includes(needle)
}

/**
 * Pick the active Session's title for the header, or a fallback.
 * @param session - the summary, if known.
 * @returns a display title.
 */
export function titleOf(session: SessionSummary | undefined): string {
  if (session === undefined) return 'Nueva sesión'
  if (session.title !== undefined) return session.title
  return session.blank ? 'Sesión vacía' : 'Sesión sin título'
}

/**
 * The Sessions as the Workspace grouping reads them, with the titles the sidebar shows.
 * @param sessions - the Sessions the controller knows.
 * @returns one entry per Session.
 */
export function groupableSessions(sessions: readonly SessionSummary[]): GroupableSession[] {
  return sessions.map(session => ({ sessionId: session.sessionId, title: titleOf(session), running: session.running }))
}

/** Controller bound to one server connection. */
export class AppController {
  private readonly sessions: SessionClient
  private readonly panelClient: PanelClient
  private readonly interactionClient: InteractionClient
  private readonly attachmentsBySession = new Map<string, AttachmentDraft[]>()
  private poll: ReturnType<typeof setInterval> | undefined
  private follow: Follow | undefined
  private readonly listeners = new Set<(state: AppState) => void>()
  private state: AppState = {
    sessions: [],
    activeId: undefined,
    transcript: emptyTranscript(),
    models: [],
    defaultChoice: undefined,
    modelCursor: 0,
    providers: [],
    keyCursor: 0,
    searchResults: [],
    searchNote: undefined,
    panel: { section: 'queue', queue: undefined, presets: undefined, settings: undefined, workspaces: undefined, goal: undefined, schedules: undefined, skills: undefined, note: undefined },
    interactions: [],
    attachments: [],
    overlay: 'none',
    notice: undefined,
    error: undefined,
  }

  private workspaceFollow: { stop: () => void } | undefined

  constructor(private readonly connection: RemoteConnection) {
    // The Host accepts one multiplexed socket per connection, so every stream shares this one.
    const mux = new RemoteMux(connection)
    this.sessions = new SessionClient(connection, mux)
    this.panelClient = new PanelClient(connection, mux)
    this.interactionClient = new InteractionClient(connection, {
      onChange: pending => this.patch({ interactions: pending }),
      onError: error => this.fail(error),
    }, mux)
  }

  /** @returns the current snapshot. */
  snapshot(): AppState {
    return this.state
  }

  /**
   * Subscribe to snapshots.
   * @param listener - called after every change.
   * @returns an unsubscribe function.
   */
  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Load Sessions, the catalog and the provider routes, then open the most
   * recently updated Session, or create one when none exists.
   */
  async start(): Promise<void> {
    this.interactionClient.start()
    this.workspaceFollow ??= this.panelClient.followWorkspaces(
      frame => this.patchPanel({ workspaces: applyWorkspaceFrame(this.state.panel.workspaces ?? emptyWorkspaces(), frame) }),
      error => this.fail(error),
    )
    await Promise.all([this.refreshSessions(), this.refreshCatalog(), this.refreshProviders()])
    const first = this.state.sessions[0]
    if (first !== undefined) await this.open(first.sessionId)
    else await this.newSession()
  }

  /** Create a Session in the working directory and open it. */
  async newSession(): Promise<void> {
    await this.attempt(async () => {
      const id = await this.sessions.createSession({})
      await this.refreshSessions()
      await this.open(id)
    })
  }

  /**
   * Open a Session: stop following the previous one and follow this one.
   * @param sessionId - the Session to show.
   */
  async open(sessionId: string): Promise<void> {
    this.follow?.stop()
    this.patch({ activeId: sessionId, transcript: emptyTranscript(), overlay: 'none', error: undefined, attachments: this.attachmentsOf(sessionId) })
    this.follow = this.sessions.follow(
      sessionId,
      transcript => {
        if (this.state.activeId !== sessionId) return
        this.patch({ transcript })
        this.followPolling(transcript.running)
      },
      error => {
        this.fail(error)
      },
    )
  }

  /**
   * Send text to the active Session. While a turn runs the text steers it;
   * otherwise it queues the next turn.
   * @param text - the message.
   */
  async send(text: string): Promise<void> {
    const sessionId = this.state.activeId
    const body = text.trim()
    const drafts = this.attachmentsOf(sessionId)
    if (sessionId === undefined || (body.length === 0 && drafts.length === 0)) return
    const mode = this.state.transcript.running ? 'steer' : 'queue'
    await this.attempt(async () => {
      await this.sessions.sendPrompt(sessionId, body, mode, drafts.map(draft => draft.part))
      this.attachmentsBySession.delete(sessionId)
      this.patch({ error: undefined, attachments: [] })
    })
  }

  /**
   * Read a file from the terminal's machine and attach it to the next prompt of
   * the active Session. Images travel inline; other files are uploaded first.
   * @param input - the path as typed; `~` and relative paths are resolved here.
   */
  async attachFile(input: string): Promise<void> {
    const sessionId = this.state.activeId
    if (sessionId === undefined || input.trim().length === 0) return
    const path = resolvePath(input, homedir(), process.cwd())
    const name = fileNameOf(path)
    await this.attempt(async () => {
      let data: Buffer
      try {
        data = await readFile(path)
      } catch {
        throw new Error(`no se pudo leer ${path}`)
      }
      const problem = sizeProblem(data.byteLength)
      if (problem !== undefined) throw new Error(`${name}: ${problem}`)
      const mediaType = imageMediaTypeOf(name)
      const key = randomUUID()
      if (mediaType !== undefined) {
        this.addAttachment(sessionId, { key, name, size: data.byteLength, part: { type: 'image', mediaType, data: data.toString('base64'), name } })
      } else {
        this.patch({ notice: `subiendo ${name}…` })
        const uploaded = await this.sessions.uploadFile(sessionId, name, data)
        this.addAttachment(sessionId, { key, name: uploaded.name, size: data.byteLength, part: { type: 'file', receiptId: uploaded.receiptId } })
      }
      this.patch({ error: undefined, notice: `adjunto: ${name}` })
    })
  }

  /**
   * Drop one attachment from the next prompt.
   * @param index - the position in the attachment list.
   */
  removeAttachment(index: number): void {
    const sessionId = this.state.activeId
    if (sessionId === undefined) return
    const drafts = this.attachmentsOf(sessionId)
    if (index < 0 || index >= drafts.length) return
    const rest = drafts.filter((_, position) => position !== index)
    this.attachmentsBySession.set(sessionId, rest)
    this.patch({ attachments: rest })
  }

  /**
   * Answer a question the Agent asked.
   * @param item - the pending question.
   * @param answers - one answer per question.
   */
  async answerQuestion(item: PendingQuestion, answers: readonly AnswerItem[]): Promise<void> {
    await this.attempt(async () => {
      await this.interactionClient.answerQuestion(item, answers)
      this.patch({ error: undefined, notice: 'respuesta enviada' })
    })
  }

  /**
   * Decide a tool approval.
   * @param item - the pending approval.
   * @param decision - allow once, or reject.
   */
  async decideApproval(item: PendingApproval, decision: ApprovalDecision): Promise<void> {
    await this.attempt(async () => {
      await this.interactionClient.decideApproval(item, decision)
      this.patch({ error: undefined, notice: decision === 'allowed-once' ? 'herramienta aprobada una vez' : 'herramienta rechazada' })
    })
  }

  /**
   * Pass a pending interaction on to the next answerer.
   * @param item - the pending interaction.
   */
  async delegateInteraction(item: PendingInteraction): Promise<void> {
    await this.attempt(async () => {
      await this.interactionClient.delegate(item)
    })
  }

  /** Stop the running turn of the active Session. */
  async cancel(): Promise<void> {
    const sessionId = this.state.activeId
    if (sessionId === undefined) return
    await this.attempt(async () => {
      await this.sessions.cancel(sessionId)
      this.patch({ notice: 'turno cancelado' })
    })
  }

  /**
   * Rename the active Session.
   * @param title - the new title; blank titles are ignored.
   */
  async rename(title: string): Promise<void> {
    const sessionId = this.state.activeId
    const next = title.trim()
    if (sessionId === undefined || next.length === 0) return
    await this.attempt(async () => {
      await this.sessions.rename(sessionId, next)
      await this.refreshSessions()
      this.patch({ overlay: 'none', notice: 'sesión renombrada' })
    })
  }

  /** Fork the active Session and open the copy. */
  async fork(): Promise<void> {
    const sessionId = this.state.activeId
    if (sessionId === undefined) return
    await this.attempt(async () => {
      const copy = await this.sessions.fork(sessionId)
      await this.refreshSessions()
      await this.open(copy)
      this.patch({ notice: 'sesión bifurcada' })
    })
  }

  /**
   * Search Session content and show the results overlay.
   * @param query - the text to find.
   */
  async search(query: string): Promise<void> {
    const text = query.trim()
    if (text.length === 0) {
      this.patch({ searchResults: [], searchNote: undefined })
      return
    }
    const local = this.state.sessions
      .filter(session => matchesTitleOrFolder(session, text))
      .map(session => ({ sessionId: session.sessionId, snippet: session.cwd ?? session.title ?? session.sessionId }))
    try {
      const content = await this.sessions.search(text)
      const seen = new Set(local.map(item => item.sessionId))
      const merged = [...local, ...content.filter(item => !seen.has(item.sessionId))]
      this.patch({ searchResults: merged, searchNote: undefined, overlay: 'search' })
    } catch (error) {
      // Content search is optional on this profile; titles and folders still answer.
      const reason = error instanceof Error ? error.message : String(error)
      const note = /disabled|desactivad/i.test(reason)
        ? 'La búsqueda en el contenido está desactivada en este perfil: se buscan títulos y carpetas.'
        : `La búsqueda en el contenido falló: ${reason}. Se muestran títulos y carpetas.`
      this.patch({ searchResults: local, searchNote: note, overlay: 'search' })
    }
  }

  /**
   * Open a search result or a listed Session.
   * @param sessionId - the Session to show.
   */
  async openFromList(sessionId: string): Promise<void> {
    await this.open(sessionId)
  }

  /** Load the model catalog and show the models overlay. */
  async openModels(): Promise<void> {
    await this.attempt(async () => {
      await this.refreshCatalog()
      const current = this.state.sessions.find(item => item.sessionId === this.state.activeId)?.model
      const index = this.state.models.findIndex(item => `${item.provider}/${item.model}` === current)
      this.patch({
        overlay: 'models',
        modelCursor: index < 0 ? 0 : index,
        notice: this.state.models.length === 0 ? 'no hay modelos disponibles: guarde una clave de proveedor' : undefined,
      })
    })
  }

  /**
   * Move the highlighted row of the models overlay.
   * @param delta - rows to move; wraps around.
   */
  moveModel(delta: number): void {
    const count = this.state.models.length
    if (count === 0) return
    this.patch({ modelCursor: (this.state.modelCursor + delta + count) % count })
  }

  /**
   * Select the highlighted model for the active Session.
   * @param reasoningEffort - the effort to use, when the model offers efforts.
   */
  async chooseModel(reasoningEffort?: string): Promise<void> {
    const sessionId = this.state.activeId
    const choice = this.state.models[this.state.modelCursor]
    if (sessionId === undefined || choice === undefined) return
    await this.attempt(async () => {
      await this.sessions.selectModel(sessionId, choice.provider, choice.model, reasoningEffort)
      await this.refreshSessions()
      this.patch({ overlay: 'none', notice: `modelo: ${choice.provider}/${choice.model}` })
    })
  }

  /** Open the provider keys overlay and check which keys are stored. */
  async openKeys(): Promise<void> {
    await this.attempt(async () => {
      await this.refreshProviders()
      this.patch({ overlay: 'keys', keyCursor: 0 })
    })
  }

  /**
   * Move the highlighted provider in the keys overlay.
   * @param delta - rows to move; wraps around.
   */
  moveKey(delta: number): void {
    const count = this.state.providers.length
    if (count === 0) return
    this.patch({ keyCursor: (this.state.keyCursor + delta + count) % count })
  }

  /**
   * Store a key through the credentials service. The value goes only in this
   * direction; the UI never displays it again.
   * @param value - the key typed by the user.
   */
  async saveKey(value: string): Promise<void> {
    const provider = this.state.providers[this.state.keyCursor]
    if (provider === undefined || value.length === 0) return
    await this.attempt(async () => {
      await call(this.connection, 'credentials/set', { ref: keyRefFor(provider.id), value })
      await this.refreshProviders()
      await this.refreshCatalog()
      this.patch({ notice: `clave guardada para ${provider.name}` })
    })
  }

  /** Remove the stored key of the highlighted provider. */
  async clearKey(): Promise<void> {
    const provider = this.state.providers[this.state.keyCursor]
    if (provider === undefined) return
    await this.attempt(async () => {
      await call(this.connection, 'credentials/unset', { ref: keyRefFor(provider.id) })
      await this.refreshProviders()
      await this.refreshCatalog()
      this.patch({ notice: `clave eliminada para ${provider.name}` })
    })
  }

  /**
   * Show or hide an overlay.
   * @param overlay - the overlay to show; `none` closes it.
   */
  setOverlay(overlay: Overlay): void {
    this.patch({ overlay })
  }

  /**
   * Open the panel on a section and load its data.
   * @param section - the section to show.
   */
  async openPanel(section: PanelSection = 'queue'): Promise<void> {
    this.patch({ overlay: 'panel', panel: { ...this.state.panel, section, note: undefined } })
    await this.loadSection(section)
  }

  /**
   * Show another panel section and load it.
   * @param section - the section to show.
   */
  async setSection(section: PanelSection): Promise<void> {
    this.patch({ panel: { ...this.state.panel, section, note: undefined } })
    await this.loadSection(section)
  }

  /**
   * Load the data of one panel section. Sections that depend on a Session
   * need an active one; without it they stay empty.
   * @param section - the section to load.
   */
  async loadSection(section: PanelSection): Promise<void> {
    const sessionId = this.state.activeId
    await this.attempt(async () => {
      switch (section) {
        case 'queue': {
          if (sessionId === undefined) return
          this.patchPanel({ queue: await this.panelClient.queue(sessionId) })
          return
        }
        case 'permissions': {
          this.patchPanel({ presets: await this.panelClient.presets() })
          return
        }
        case 'settings': {
          this.patchPanel({ settings: await this.panelClient.settings() })
          return
        }
        case 'workspaces':
          // The stream started by `start` keeps this section current.
          return
        case 'goals': {
          if (sessionId === undefined) return
          this.patchPanel({ goal: (await this.panelClient.goal(sessionId)) ?? null })
          return
        }
        case 'schedule': {
          this.patchPanel({ schedules: await this.panelClient.schedules() })
          return
        }
        case 'skills': {
          if (sessionId === undefined) return
          this.patchPanel({ skills: await this.panelClient.skills(sessionId) })
          return
        }
      }
    })
  }

  /**
   * Steer, edit or remove a message waiting in the queue of the active Session.
   * @param itemId - the queued message.
   * @param action - the change to apply.
   */
  async queueAction(itemId: string, action: { kind: 'steer' } | { kind: 'remove' } | { kind: 'edit'; text: string }): Promise<void> {
    const sessionId = this.state.activeId
    if (sessionId === undefined) return
    await this.attempt(async () => {
      await this.panelClient.updateQueue(sessionId, itemId, action)
      this.patchPanel({ note: action.kind === 'steer' ? 'mensaje dirigido al turno en curso' : action.kind === 'remove' ? 'mensaje quitado de la cola' : 'mensaje editado' })
      await this.loadSection('queue')
    })
  }

  /**
   * Switch the permission preset of the active Session.
   * @param preset - a name from the catalog.
   */
  async setPreset(preset: string): Promise<void> {
    const sessionId = this.state.activeId
    if (sessionId === undefined) return
    await this.attempt(async () => {
      await this.panelClient.setPreset(sessionId, preset)
      await this.refreshSessions()
      this.patchPanel({ note: `permisos: ${preset}` })
    })
  }

  /**
   * Show a message in the panel's note line, for input the panel refused before any call.
   * @param note - the message.
   */
  notePanel(note: string): void {
    this.patchPanel({ note })
  }

  /**
   * Run one Workspace action. Pins, archives and moves are shown when the Host
   * streams them back, so the panel only reports what it asked for.
   * @param action - the change to apply.
   */
  async workspaceAction(action: WorkspaceAction): Promise<void> {
    const view = this.state.panel.workspaces ?? emptyWorkspaces()
    const sessions = this.state.sessions
    await this.attempt(async () => {
      switch (action.kind) {
        case 'create': {
          const path = action.path.trim()
          if (path.length === 0) {
            await this.panelClient.initializeDefaultWorkspace()
            this.patchPanel({ note: 'espacio predeterminado listo' })
            return
          }
          const created = await this.panelClient.createWorkspace(path)
          this.patchPanel({ note: created === undefined ? 'espacio creado' : `espacio «${created.title}» listo` })
          return
        }
        case 'rename': {
          const title = action.title.trim()
          if (title.length === 0) {
            this.patchPanel({ note: 'el título no puede estar vacío' })
            return
          }
          await this.panelClient.renameWorkspace(action.workspaceId, title)
          this.patchPanel({ note: 'espacio renombrado' })
          return
        }
        case 'delete':
          await this.panelClient.deleteWorkspace(action.workspaceId)
          this.patchPanel({ note: 'espacio quitado; sus archivos y sesiones se conservan' })
          return
        case 'moveWorkspace': {
          const move = workspaceMove(view, action.workspaceId, action.direction)
          if (move === undefined) return
          await this.panelClient.moveWorkspace(action.workspaceId, move.beforeWorkspaceId)
          return
        }
        case 'pin':
          await this.panelClient.setPinned(action.sessionId, action.pinned)
          this.patchPanel({ note: action.pinned ? 'sesión fijada' : 'sesión desfijada' })
          return
        case 'archive': {
          const session = sessions.find(item => item.sessionId === action.sessionId)
          if (action.archived && session?.running === true) {
            this.patchPanel({ note: 'la sesión tiene un turno en curso: espera a que termine o cancélalo' })
            return
          }
          await this.panelClient.setArchived(action.sessionId, action.archived)
          this.patchPanel({ note: action.archived ? 'sesión archivada' : 'sesión restaurada' })
          return
        }
        case 'moveSession': {
          const rows = groupRows(view, groupableSessions(sessions))
          const move = sessionMove(rows, action.index, action.direction)
          const row = rows[action.index]
          if (move === undefined || row?.kind !== 'session') return
          await this.panelClient.moveSession(move.workspaceId, row.sessionId, move.beforeSessionId)
          return
        }
      }
    })
  }

  /**
   * Change one field of a namespace, remove its override, or replace the whole
   * user section. Each write carries the revision the panel read, so a concurrent
   * change is refused by the Host and the panel reloads instead of overwriting it.
   * @param ns - the namespace.
   * @param action - the change to apply.
   */
  async settingAction(ns: string, action: SettingAction): Promise<void> {
    const row = this.state.panel.settings?.find(item => item.ns === ns)
    if (row === undefined) return
    if (!row.writable) {
      this.patchPanel({ note: 'los ajustes son de solo lectura en este perfil' })
      return
    }
    await this.attempt(async () => {
      if (action.kind === 'replace') {
        if (!canReplaceSection(row)) {
          this.patchPanel({ note: 'esta sección tiene secretos: edítala campo a campo' })
          return
        }
        await this.panelClient.replaceSection(ns, action.section, row.revision)
      } else {
        const op: SettingOp = action.kind === 'set'
          ? { op: 'set', path: [action.key], value: action.value }
          : { op: 'unset', path: [action.key] }
        await this.panelClient.writeSetting(ns, [op], row.revision)
      }
      this.patchPanel({ note: action.kind === 'replace' ? `${ns}: sección guardada` : action.kind === 'set' ? `${ns}.${action.key} guardado` : `${ns}.${action.key}: vuelve al valor base` })
      await this.loadSection('settings')
    })
  }

  /**
   * Create a goal for the active Session.
   * @param objective - what the goal should achieve; blank objectives are ignored.
   */
  async createGoal(objective: string): Promise<void> {
    const sessionId = this.state.activeId
    const text = objective.trim()
    if (sessionId === undefined || text.length === 0) return
    await this.attempt(async () => {
      await this.panelClient.createGoal(sessionId, text)
      this.patchPanel({ note: 'meta creada' })
      await this.loadSection('goals')
    })
  }

  /**
   * Pause, resume or complete the goal of the active Session.
   * @param action - the transition.
   */
  async goalAction(action: 'pause' | 'resume' | 'complete'): Promise<void> {
    const sessionId = this.state.activeId
    const goal = this.state.panel.goal
    if (sessionId === undefined || goal === undefined || goal === null) return
    await this.attempt(async () => {
      await this.panelClient.goalAction(sessionId, goal, action)
      this.patchPanel({ note: `meta: ${action}` })
      await this.loadSection('goals')
    })
  }

  /** Remove the goal of the active Session. */
  async clearGoal(): Promise<void> {
    const sessionId = this.state.activeId
    const goal = this.state.panel.goal
    if (sessionId === undefined || goal === undefined || goal === null) return
    await this.attempt(async () => {
      await this.panelClient.clearGoal(sessionId, goal)
      this.patchPanel({ note: 'meta eliminada' })
      await this.loadSection('goals')
    })
  }

  /** Refresh the Session list, most recently updated first. */
  async refreshSessions(): Promise<void> {
    await this.attempt(async () => {
      const sessions = await this.sessions.listSessions()
      for (const session of sessions) this.interactionClient.setContinued(session.sessionId, session.userQuestions)
      this.patch({ sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt) })
    })
  }

  /** Stop following, close the sockets and drop listeners. */
  dispose(): void {
    this.followPolling(false)
    this.workspaceFollow?.stop()
    this.follow?.stop()
    this.interactionClient.stop()
    this.sessions.close()
    this.listeners.clear()
  }

  private attachmentsOf(sessionId: string | undefined): AttachmentDraft[] {
    return sessionId === undefined ? [] : this.attachmentsBySession.get(sessionId) ?? []
  }

  private addAttachment(sessionId: string, draft: AttachmentDraft): void {
    const next = [...this.attachmentsOf(sessionId), draft]
    this.attachmentsBySession.set(sessionId, next)
    if (this.state.activeId === sessionId) this.patch({ attachments: next })
  }

  /** While a turn runs, read the Session list again so a timed question that becomes continued shows up. */
  private followPolling(running: boolean): void {
    if (running && this.poll === undefined) {
      this.poll = setInterval(() => {
        void this.refreshSessions()
      }, POLL_MS)
    } else if (!running && this.poll !== undefined) {
      clearInterval(this.poll)
      this.poll = undefined
    }
  }

  private async refreshCatalog(): Promise<void> {
    const view = await this.sessions.catalog()
    this.patch({ models: view.choices, defaultChoice: view.defaultChoice })
  }

  private async refreshProviders(): Promise<void> {
    const routes = await call<Array<{ id: string; name: string }>>(this.connection, 'llm/listProviders', {})
    const refs = routes.map(route => keyRefFor(route.id))
    const described = refs.length === 0
      ? {}
      : await call<Record<string, { configured: boolean }>>(this.connection, 'credentials/describe', { refs })
    const providers: ProviderRoute[] = routes.map(route => ({
      id: route.id,
      name: route.name,
      configured: described[keyRefFor(route.id)]?.configured === true,
    }))
    this.patch({ providers, keyCursor: Math.min(this.state.keyCursor, Math.max(0, providers.length - 1)) })
  }

  private async attempt(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown): void {
    this.patch({ error: error instanceof Error ? error.message : String(error) })
  }

  private patchPanel(partial: Partial<PanelState>): void {
    this.patch({ panel: { ...this.state.panel, ...partial } })
  }

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) listener(this.state)
  }
}
