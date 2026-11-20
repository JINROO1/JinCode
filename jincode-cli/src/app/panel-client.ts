/**
 * Remote calls and normalizers for the panel sections: the message queue,
 * permission presets, Host settings (read-only), goals, schedules and skills.
 * Every reply is normalized here, so the UI never reads raw wire shapes.
 */
import { randomUUID } from 'node:crypto'
import { call, type RemoteConnection, type RemoteMux } from '../wire/remote.ts'
import { normalizeWorkspace, type WorkspaceRow } from './workspace-model.ts'
import { normalizeListing, normalizeMatches, normalizePage, type FilePage, type FileEntry, type SearchResult } from './file-model.ts'
import { normalizeRecords, normalizeTask, normalizeTasks, type ScheduleRecord, type ScheduleTask } from './schedule-model.ts'

/** One message waiting for the running turn. */
export interface QueueRow {
  readonly id: string
  readonly placement: 'queued' | 'steering' | 'context'
  readonly text: string
}

/** The permission presets the Host offers and the one this Session uses. */
export interface PresetView {
  readonly options: readonly string[]
  readonly defaultPreset: string | undefined
}

/** One secret slot of a namespace: its path from the section root and whether it holds a value. */
export interface SecretSlot {
  readonly path: readonly string[]
  readonly set: boolean
}

/** One Host settings namespace: the resolved value, the user section and its secret slots. */
export interface SettingsRow {
  readonly ns: string
  readonly revision: number
  readonly applies: string
  readonly writable: boolean
  readonly value: unknown
  readonly user: Record<string, unknown> | undefined
  readonly secrets: readonly SecretSlot[]
}

/** One edit of a namespace's user section, applied in order by `settings/mutate`. */
export type SettingOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** A goal as the Host reports it. */
export interface GoalView {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: string
  readonly roundsStarted: number
  readonly maxGoalRounds: number
}

/** One agent preset the Host offers: the composition a Session runs. */
export interface AgentPresetRow {
  readonly id: string
  readonly isDefault: boolean
}

/** One loader entry (a plugin) the Host lists. */
export interface PluginRow {
  readonly id: string
  readonly title: string
  readonly enabled: boolean
  /** Why the row cannot change from the profile, when it cannot. */
  readonly readOnly: string | undefined
}

/** One bundle (a package that adds a patch layer) the Host lists. */
export interface BundleRow {
  readonly name: string
  readonly version: string | undefined
  readonly description: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly removable: boolean
  readonly readOnly: string | undefined
}

/** The answer of the Host about a package spec before installing it. */
export interface InspectRow {
  readonly status: string
  readonly name: string | undefined
  readonly version: string | undefined
  readonly reason: string | undefined
}

/** One skill the Session can use. */
export interface SkillRow {
  readonly name: string
  readonly description: string
}

/**
 * Read the queue of a Session from its state. A missing live Agent has no queue.
 * @param value - the `session/state` result.
 * @returns the queued messages in order.
 */
export function normalizeQueue(value: unknown): QueueRow[] {
  if (!isRecord(value) || !Array.isArray(value['queue'])) return []
  const rows: QueueRow[] = []
  for (const item of value['queue']) {
    if (!isRecord(item) || typeof item['id'] !== 'string') continue
    const placement = item['placement'] === 'steering' || item['placement'] === 'context' ? item['placement'] : 'queued'
    rows.push({ id: item['id'], placement, text: textOfBlocks(item['content']) })
  }
  return rows
}

/**
 * Read the preset catalog. Presets appear as `{ value, name }` rows.
 * @param value - the `permissionPresets/catalog` result.
 * @returns the preset names and the Host default.
 */
export function normalizePresets(value: unknown): PresetView {
  const options = isRecord(value) && Array.isArray(value['options'])
    ? value['options'].flatMap(option => isRecord(option) && typeof option['value'] === 'string' ? [option['value']] : [])
    : []
  const defaultPreset = isRecord(value) && typeof value['defaultPreset'] === 'string' ? value['defaultPreset'] : undefined
  return { options, defaultPreset }
}

/**
 * Read the settings namespaces from `settings/describe`.
 * @param value - the describe result.
 * @returns one row per namespace, in the Host's order.
 */
export function normalizeSettings(value: unknown): SettingsRow[] {
  if (!isRecord(value) || !Array.isArray(value['namespaces'])) return []
  const rows: SettingsRow[] = []
  for (const item of value['namespaces']) {
    if (!isRecord(item) || typeof item['ns'] !== 'string') continue
    rows.push({
      ns: item['ns'],
      revision: typeof item['revision'] === 'number' ? item['revision'] : 0,
      applies: typeof item['applies'] === 'string' ? item['applies'] : 'unknown',
      writable: value['writable'] === true,
      value: item['value'],
      user: isRecord(item['user']) ? item['user'] : undefined,
      secrets: Array.isArray(item['secrets'])
        ? item['secrets'].flatMap(slot => isRecord(slot) && Array.isArray(slot['path']) && slot['path'].every(part => typeof part === 'string')
          ? [{ path: slot['path'] as string[], set: slot['set'] === true }]
          : [])
        : [],
    })
  }
  return rows
}

/**
 * Read a goal. The Host answers `null` when the Session has no goal.
 * @param value - the `goals/get` result.
 * @returns the goal, or undefined when there is none.
 */
export function normalizeGoal(value: unknown): GoalView | undefined {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['revision'] !== 'number') return undefined
  return {
    id: value['id'],
    revision: value['revision'],
    objective: typeof value['objective'] === 'string' ? value['objective'] : '',
    phase: typeof value['phase'] === 'string' ? value['phase'] : 'unknown',
    roundsStarted: typeof value['roundsStarted'] === 'number' ? value['roundsStarted'] : 0,
    maxGoalRounds: typeof value['maxGoalRounds'] === 'number' ? value['maxGoalRounds'] : 0,
  }
}


/**
 * Read the skills list.
 * @param value - the `skills/list` result.
 * @returns the skills, with their descriptions.
 */
export function normalizeSkills(value: unknown): SkillRow[] {
  if (!isRecord(value) || !Array.isArray(value['skills'])) return []
  const rows: SkillRow[] = []
  for (const item of value['skills']) {
    if (!isRecord(item) || typeof item['name'] !== 'string') continue
    rows.push({ name: item['name'], description: typeof item['description'] === 'string' ? item['description'] : '' })
  }
  return rows
}

/** Thin wrappers over the Remote API, one per panel action. */
export class PanelClient {
  /**
   * @param connection - the Remote connection.
   * @param mux - the shared stream carrier; needed only for the Workspace stream.
   */
  constructor(private readonly connection: RemoteConnection, private readonly mux?: Pick<RemoteMux, 'open'>) {}

  /**
   * Follow the Workspace state: a baseline, then ordered increments. Frames are
   * passed on as received; the Workspace model folds them into a view.
   * @param onFrame - receives each frame.
   * @param onError - receives a terminal stream failure.
   * @returns a handle that stops delivery.
   */
  followWorkspaces(onFrame: (frame: unknown) => void, onError: (error: unknown) => void): { stop: () => void } {
    if (this.mux === undefined) return { stop: () => {} }
    const stream = this.mux.open('workspace/follow', {})
    let stopped = false
    void (async () => {
      try {
        for await (const frame of stream) {
          if (stopped) break
          onFrame(frame)
        }
      } catch (error) {
        if (!stopped) onError(error)
      }
    })()
    return {
      stop: () => {
        stopped = true
        stream.cancel()
      },
    }
  }

  /**
   * Create a Workspace over a directory. The Host answers with the existing one
   * when the directory already has a Workspace.
   * @param path - the directory.
   * @returns the Workspace.
   */
  async createWorkspace(path: string): Promise<WorkspaceRow | undefined> {
    const value = await call<{ workspace?: unknown }>(this.connection, 'workspace/create', { request: { path } })
    return normalizeWorkspace(value?.workspace)
  }

  /**
   * List one directory of a Session's workspace.
   * @param sessionId - the Session whose workspace is browsed.
   * @param path - the directory, relative to the root; empty for the root.
   * @returns the directory and its children, sorted for display.
   */
  async listFiles(sessionId: string, path: string): Promise<{ path: string; entries: FileEntry[] }> {
    return normalizeListing(await call(this.connection, 'workspaceFiles/list', { workspaceFileScopeId: sessionId, path: path.length === 0 ? '.' : path }))
  }

  /**
   * Read one page of a text file in the Session's workspace.
   * @param sessionId - the Session.
   * @param path - the file, relative to the root.
   * @param offset - the first line of the page.
   * @param limit - the most lines the page may hold.
   * @returns the page.
   */
  async readFile(sessionId: string, path: string, offset: number, limit: number): Promise<FilePage> {
    return normalizePage(await call(this.connection, 'workspaceFiles/read', { workspaceFileScopeId: sessionId, path, range: { offset, limit } }), path)
  }

  /**
   * Search file names in the Session's workspace, honouring the Host's ignore rules.
   * @param sessionId - the Session.
   * @param query - a case-insensitive substring.
   * @param includeHidden - whether hidden files are searched too.
   * @returns the hits, and whether the Host cut the list.
   */
  async searchFiles(sessionId: string, query: string, includeHidden: boolean): Promise<SearchResult> {
    return normalizeMatches(await call(this.connection, 'workspaceFiles/search', {
      workspaceFileScopeId: sessionId,
      request: { query, excludedPaths: [], includeHidden, respectGitignore: true },
    }))
  }

  /** Create or reuse the default Workspace, for the first-use flow. */
  async initializeDefaultWorkspace(): Promise<void> {
    await call(this.connection, 'workspace/initializeDefault', {})
  }

  /**
   * @param workspaceId - the Workspace.
   * @param title - the new title; the Host rejects blank or duplicate titles.
   */
  async renameWorkspace(workspaceId: string, title: string): Promise<void> {
    await call(this.connection, 'workspace/rename', { request: { workspaceId, title } })
  }

  /**
   * Remove a Workspace registration. Its files and Sessions stay.
   * @param workspaceId - the Workspace.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await call(this.connection, 'workspace/delete', { request: { workspaceId } })
  }

  /**
   * Move a Workspace in the registry order.
   * @param workspaceId - the Workspace to move.
   * @param beforeWorkspaceId - insert before this one; undefined moves it last.
   */
  async moveWorkspace(workspaceId: string, beforeWorkspaceId: string | undefined): Promise<void> {
    await call(this.connection, 'workspace/insertBefore', { request: beforeWorkspaceId === undefined ? { workspaceId } : { workspaceId, beforeWorkspaceId } })
  }

  /**
   * Move a Session inside a Workspace.
   * @param workspaceId - the Workspace.
   * @param sessionId - the Session.
   * @param beforeSessionId - insert before this one; undefined moves it last.
   */
  async moveSession(workspaceId: string, sessionId: string, beforeSessionId: string | undefined): Promise<void> {
    await call(this.connection, 'workspace/insertSessionBefore', {
      request: beforeSessionId === undefined ? { workspaceId, sessionId } : { workspaceId, sessionId, beforeSessionId },
    })
  }

  /**
   * Pin or unpin a Session on the Workspace surfaces.
   * @param sessionId - the Session.
   * @param pinned - the new state.
   */
  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    await call(this.connection, pinned ? 'workspace/pinSession' : 'workspace/unpinSession', { request: { sessionId } })
  }

  /**
   * Hide a Session from the Workspace grouping, or restore it.
   * @param sessionId - the Session.
   * @param archived - the new state. Archiving a running Session is refused by the Host.
   */
  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    await call(this.connection, archived ? 'workspace/archiveSession' : 'workspace/unarchiveSession', { request: { sessionId } })
  }

  /** @returns the queue of a Session. */
  async queue(sessionId: string): Promise<QueueRow[]> {
    return normalizeQueue(await call(this.connection, 'session/state', { request: { sessionId } }))
  }

  /**
   * Steer, edit or remove one queued message.
   * @param sessionId - the Session that owns the queue.
   * @param itemId - the queued message.
   * @param action - `steer`, `remove`, or `edit` with the new text.
   */
  async updateQueue(sessionId: string, itemId: string, action: { kind: 'steer' } | { kind: 'remove' } | { kind: 'edit'; text: string }): Promise<void> {
    const wire = action.kind === 'edit' ? { kind: 'edit', content: [{ type: 'text', text: action.text }] } : { kind: action.kind }
    await call(this.connection, 'session/updateQueue', { request: { sessionId, itemId, action: wire } })
  }

  /** @returns the preset catalog. */
  async presets(): Promise<PresetView> {
    return normalizePresets(await call(this.connection, 'permissionPresets/catalog', {}))
  }

  /**
   * Switch the permission preset of a Session.
   * @param sessionId - the Session to change.
   * @param preset - a name from the catalog.
   */
  async setPreset(sessionId: string, preset: string): Promise<void> {
    await call(this.connection, 'permissionPresets/set', { request: { sessionId, preset } })
  }

  /** @returns the settings namespaces. */
  async settings(): Promise<SettingsRow[]> {
    return normalizeSettings(await call(this.connection, 'settings/describe', {}))
  }

  /**
   * Apply path edits to one namespace's user section. The Host refuses the write
   * when the revision read is stale, so the caller reloads after each change.
   * @param ns - the namespace.
   * @param ops - the edits, in order.
   * @param expectedRevision - the revision the caller read.
   */
  async writeSetting(ns: string, ops: readonly SettingOp[], expectedRevision: number): Promise<void> {
    await call(this.connection, 'settings/mutate', { ns, ops, expectedRevision })
  }

  /**
   * Replace the whole user section of one namespace.
   * @param ns - the namespace.
   * @param section - the complete new user section.
   * @param expectedRevision - the revision the caller read.
   */
  async replaceSection(ns: string, section: Record<string, unknown>, expectedRevision: number): Promise<void> {
    await call(this.connection, 'settings/replace', { ns, section, expectedRevision })
  }

  /** @returns the goal of a Session, or undefined. */
  async goal(agentId: string): Promise<GoalView | undefined> {
    return normalizeGoal(await call(this.connection, 'goals/get', { agentId }))
  }

  /**
   * Create a goal for a Session.
   * @param agentId - the Session.
   * @param objective - what the goal should achieve.
   */
  async createGoal(agentId: string, objective: string): Promise<void> {
    await call(this.connection, 'goals/create', { agentId, request: { objective } })
  }

  /**
   * Change the objective of the goal. The Host checks the revision read; a stale one is refused.
   * @param agentId - the Session.
   * @param goal - the goal as the panel read it.
   * @param objective - the new objective.
   */
  async editGoal(agentId: string, goal: GoalView, objective: string): Promise<void> {
    await call(this.connection, 'goals/edit', { agentId, ref: { id: goal.id, revision: goal.revision }, request: { objective } })
  }

  /**
   * Pause, resume or complete the goal; each change needs the revision the UI read.
   * @param agentId - the Session.
   * @param goal - the goal as last read.
   * @param action - the transition to apply.
   */
  async goalAction(agentId: string, goal: GoalView, action: 'pause' | 'resume' | 'complete'): Promise<void> {
    await call(this.connection, `goals/${action}`, { agentId, ref: { id: goal.id, revision: goal.revision } })
  }

  /**
   * Remove the goal of a Session. The Host needs both the Session and the revision read.
   * @param agentId - the Session.
   * @param goal - the goal as last read.
   */
  async clearGoal(agentId: string, goal: GoalView): Promise<void> {
    await call(this.connection, 'goals/clear', { agentId, ref: { id: goal.id, revision: goal.revision } })
  }

  /** @returns every scheduled task, active, paused and ended. */
  async schedules(): Promise<ScheduleTask[]> {
    return normalizeTasks(await call(this.connection, 'schedule/catalog', {}))
  }

  /** @returns the minimum seconds between deliveries that open a new Session. */
  async scheduleLimit(): Promise<number | undefined> {
    const value = await call<unknown>(this.connection, 'schedule/deliveryLimits', {})
    return isRecord(value) && typeof value['newSessionIntervalSeconds'] === 'number' ? value['newSessionIntervalSeconds'] : undefined
  }

  /**
   * Create a scheduled task.
   * @param request - the `schedule/create` request built by the form.
   * @returns the saved task.
   */
  async createSchedule(request: Record<string, unknown>): Promise<ScheduleTask | undefined> {
    return normalizeTask(await call(this.connection, 'schedule/create', { request }))
  }

  /**
   * Change a scheduled task. The Host answers a stale revision with a `code`, not an error.
   * @param request - the `schedule/edit` request (update or delete).
   * @returns the Host answer, which may carry a `code`.
   */
  async editSchedule(request: Record<string, unknown>): Promise<unknown> {
    return call(this.connection, 'schedule/edit', { request })
  }

  /**
   * Run a scheduled task now.
   * @param id - the task.
   */
  async runSchedule(id: string): Promise<void> {
    await call(this.connection, 'schedule/run', { request: { id } })
  }

  /**
   * Read the saved deliveries of a task, newest first.
   * @param id - the task.
   * @returns the deliveries in the page.
   */
  async scheduleHistory(id: string): Promise<ScheduleRecord[]> {
    return normalizeRecords(await call(this.connection, 'schedule/history', { request: { id, limit: 20 } }))
  }

  /**
   * Send a text message to a subagent. The request identity is minted here, before the call.
   * @param childSessionId - the subagent's Session.
   * @param text - the message.
   * @param delivery - `queue` waits for the next turn; `steer` targets the nearest step.
   * @returns the id of the message the subagent's inbox accepted.
   */
  async sendToChild(childSessionId: string, text: string, delivery: 'queue' | 'steer'): Promise<string> {
    const clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const value = await call<unknown>(this.connection, 'subagents/prompt', {
      request: { requestId: randomUUID(), childSessionId, delivery, content: [{ type: 'text', text }], clientTimeZone },
    })
    return isRecord(value) && typeof value['messageId'] === 'string' ? value['messageId'] : ''
  }

  /**
   * Interrupt a subagent on the user's behalf. The Host accepts an idle or absent target as a no-op.
   * @param childSessionId - the subagent's Session.
   */
  async interruptChild(childSessionId: string): Promise<void> {
    await call(this.connection, 'subagents/interruptByUser', { childSessionId })
  }

  /** @returns the agent presets the Host offers. */
  async agentPresets(): Promise<AgentPresetRow[]> {
    return normalizeAgentPresets(await call(this.connection, 'agentPresets/list', {}))
  }

  /**
   * Read the declaration of a preset, as YAML, for viewing only.
   * @param agentPreset - the preset.
   * @returns the YAML text.
   */
  async agentPresetYaml(agentPreset: string): Promise<string> {
    const value = await call<unknown>(this.connection, 'agentPresets/read', { agentPreset })
    return isRecord(value) && typeof value['content'] === 'string' ? value['content'] : ''
  }

  /**
   * Select a preset for a Session that has not started its first turn.
   * @param agentId - the Session.
   * @param agentPreset - the preset.
   * @returns the preset the Host selected.
   */
  async selectAgentPreset(agentId: string, agentPreset: string): Promise<string> {
    const value = await call<unknown>(this.connection, 'agentPresets/select', { agentId, agentPreset })
    return typeof value === 'string' ? value : agentPreset
  }

  /** @returns the loader entries (plugins) and the bundles, as the Host lists them. */
  async plugins(): Promise<{ plugins: PluginRow[]; bundles: BundleRow[] }> {
    const [entries, bundles] = await Promise.all([
      call<unknown>(this.connection, 'pluginManager/listPlugins', {}),
      call<unknown>(this.connection, 'pluginManager/listBundles', {}),
    ])
    return { plugins: normalizePlugins(entries), bundles: normalizeBundles(bundles) }
  }

  /**
   * Turn a plugin entry on or off on the live profiles.
   * @param id - the loader entry id.
   * @param enabled - the new state.
   */
  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    await call(this.connection, 'pluginManager/setPluginEnabled', { id, enabled })
  }

  /**
   * Select or deselect a bundle layer; its installed dependencies stay.
   * @param name - the bundle.
   * @param enabled - the new state.
   */
  async setBundleEnabled(name: string, enabled: boolean): Promise<void> {
    await call(this.connection, 'pluginManager/setBundleEnabled', { name, enabled })
  }

  /**
   * Remove a bundle dependency from the profile.
   * @param name - the bundle.
   */
  async removeBundle(name: string): Promise<void> {
    await call(this.connection, 'pluginManager/removeBundle', { name })
  }

  /**
   * Read what a spec names, without installing it.
   * @param spec - a registry name, path, git address or tarball.
   * @returns the Host's answer.
   */
  async inspectSpec(spec: string): Promise<InspectRow> {
    return normalizeInspect(await call(this.connection, 'pluginManager/inspect', { spec, options: {} }))
  }

  /**
   * Install a package. The request identity is minted here, so the install can be cancelled by name.
   * @param spec - the package spec.
   * @returns the Host's answer, with its status.
   */
  async installSpec(spec: string): Promise<{ requestId: string } & InspectRow> {
    const requestId = randomUUID()
    const value = await call<unknown>(this.connection, 'pluginManager/installBundle', { spec, options: { requestId } })
    return { requestId, ...normalizeInspect(value) }
  }

  /** @returns how many ended tasks the Host removed. */
  async clearEndedSchedules(): Promise<number> {
    const value = await call<unknown>(this.connection, 'schedule/deleteInactive', {})
    return isRecord(value) && typeof value['deleted'] === 'number' ? value['deleted'] : 0
  }

  /**
   * @param sessionId - the Session whose skills are listed.
   * @returns the skills available to it.
   */
  async skills(sessionId: string): Promise<SkillRow[]> {
    return normalizeSkills(await call(this.connection, 'skills/list', { request: { sessionId } }))
  }
}

function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block => isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [])
    .join('\n')
}

/**
 * Read the agent presets the Host offers.
 * @param value - the `agentPresets/list` result.
 * @returns the presets in the Host's order.
 */
export function normalizeAgentPresets(value: unknown): AgentPresetRow[] {
  if (!isRecord(value) || !Array.isArray(value['presets'])) return []
  const rows: AgentPresetRow[] = []
  for (const item of value['presets']) {
    if (!isRecord(item) || typeof item['id'] !== 'string') continue
    rows.push({ id: item['id'], isDefault: item['isDefault'] === true })
  }
  return rows
}

/**
 * Read the loader entries the Host lists. A title is taken in Spanish, then English, then the module name.
 * @param value - the `pluginManager/listPlugins` result.
 * @returns the entries.
 */
export function normalizePlugins(value: unknown): PluginRow[] {
  if (!Array.isArray(value)) return []
  const rows: PluginRow[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item['entryId'] !== 'string') continue
    const meta = isRecord(item['meta']) && isRecord(item['meta']['title']) ? item['meta']['title'] : undefined
    const title = typeof meta?.['es'] === 'string' ? meta['es'] : typeof meta?.['en'] === 'string' ? meta['en'] : typeof item['moduleName'] === 'string' ? item['moduleName'] : item['entryId']
    rows.push({
      id: item['entryId'],
      title,
      enabled: item['enabled'] === true,
      readOnly: typeof item['readOnlyReason'] === 'string' ? item['readOnlyReason'] : undefined,
    })
  }
  return rows
}

/**
 * Read the bundles the Host lists.
 * @param value - the `pluginManager/listBundles` result.
 * @returns the bundles.
 */
export function normalizeBundles(value: unknown): BundleRow[] {
  if (!Array.isArray(value)) return []
  const rows: BundleRow[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item['name'] !== 'string') continue
    rows.push({
      name: item['name'],
      version: typeof item['version'] === 'string' ? item['version'] : undefined,
      description: typeof item['description'] === 'string' ? item['description'] : '',
      enabled: item['enabled'] === true,
      installed: item['installed'] === true,
      removable: item['removable'] === true,
      readOnly: typeof item['readOnlyReason'] === 'string' ? item['readOnlyReason'] : undefined,
    })
  }
  return rows
}

/**
 * Read the answer to an inspection or an install.
 * @param value - the Host answer.
 * @returns the status and what it names.
 */
export function normalizeInspect(value: unknown): InspectRow {
  const record = isRecord(value) ? value : {}
  return {
    status: typeof record['status'] === 'string' ? record['status'] : 'desconocido',
    name: typeof record['name'] === 'string' ? record['name'] : undefined,
    version: typeof record['version'] === 'string' ? record['version'] : undefined,
    reason: typeof record['reason'] === 'string' ? record['reason'] : typeof record['problem'] === 'string' ? record['problem'] : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
