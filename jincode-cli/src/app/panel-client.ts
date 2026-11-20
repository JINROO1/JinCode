/**
 * Remote calls and normalizers for the panel sections: the message queue,
 * permission presets, Host settings (read-only), goals, schedules and skills.
 * Every reply is normalized here, so the UI never reads raw wire shapes.
 */
import { call, type RemoteConnection, type RemoteMux } from '../wire/remote.ts'
import { normalizeWorkspace, type WorkspaceRow } from './workspace-model.ts'

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

/** One scheduled task, read-only. */
export interface ScheduleRow {
  readonly id: string
  readonly title: string
  readonly status: string
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
 * Read the schedule page. Titles fall back to the id, and status to `unknown`.
 * @param value - the `schedule/list` result.
 * @returns the tasks on the page.
 */
export function normalizeSchedule(value: unknown): ScheduleRow[] {
  if (!isRecord(value) || !Array.isArray(value['items'])) return []
  const rows: ScheduleRow[] = []
  for (const item of value['items']) {
    if (!isRecord(item) || typeof item['id'] !== 'string') continue
    rows.push({
      id: item['id'],
      title: typeof item['title'] === 'string' && item['title'].length > 0 ? item['title'] : item['id'],
      status: typeof item['status'] === 'string' ? item['status'] : 'unknown',
    })
  }
  return rows
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

  /** @returns the first page of scheduled tasks. */
  async schedules(): Promise<ScheduleRow[]> {
    return normalizeSchedule(await call(this.connection, 'schedule/list', { request: {} }))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
