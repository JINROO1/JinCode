/**
 * Application state and actions, independent of the rendering library. The UI
 * subscribes to snapshots and calls actions; every Host call goes through here.
 */
import { call, type RemoteConnection } from '../wire/remote.ts'
import {
  SessionClient,
  type Follow,
  type ModelChoice,
  type SessionSummary,
} from './session-client.ts'
import { emptyTranscript, type Transcript } from '../transcript/reducer.ts'

/** The overlay covering the conversation, if any. */
export type Overlay = 'none' | 'sessions' | 'models' | 'keys' | 'rename' | 'search' | 'help'

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
  readonly overlay: Overlay
  readonly notice: string | undefined
  readonly error: string | undefined
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

/** Controller bound to one server connection. */
export class AppController {
  private readonly sessions: SessionClient
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
    overlay: 'none',
    notice: undefined,
    error: undefined,
  }

  constructor(private readonly connection: RemoteConnection) {
    this.sessions = new SessionClient(connection)
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
    this.patch({ activeId: sessionId, transcript: emptyTranscript(), overlay: 'none', error: undefined })
    this.follow = this.sessions.follow(
      sessionId,
      transcript => {
        if (this.state.activeId === sessionId) this.patch({ transcript })
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
    if (sessionId === undefined || body.length === 0) return
    const mode = this.state.transcript.running ? 'steer' : 'queue'
    await this.attempt(async () => {
      await this.sessions.sendPrompt(sessionId, body, mode)
      this.patch({ error: undefined })
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

  /** Select the highlighted model for the active Session. */
  async chooseModel(): Promise<void> {
    const sessionId = this.state.activeId
    const choice = this.state.models[this.state.modelCursor]
    if (sessionId === undefined || choice === undefined) return
    await this.attempt(async () => {
      await this.sessions.selectModel(sessionId, choice.provider, choice.model)
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

  /** Refresh the Session list, most recently updated first. */
  async refreshSessions(): Promise<void> {
    await this.attempt(async () => {
      const sessions = await this.sessions.listSessions()
      this.patch({ sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt) })
    })
  }

  /** Stop following, close the socket and drop listeners. */
  dispose(): void {
    this.follow?.stop()
    this.sessions.close()
    this.listeners.clear()
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

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) listener(this.state)
  }
}
