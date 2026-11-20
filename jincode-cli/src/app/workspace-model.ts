/**
 * Workspace grouping, kept apart from the screen so the rules can be tested.
 * The Host streams a baseline and then ordered increments (`upsert`, `pinned`,
 * `archived`, `order`, `remove`). `applyWorkspaceFrame` folds each one into the
 * view, and `groupRows` lays the Sessions out as the Workspace surfaces do:
 * one group per Workspace, then the Sessions with no Workspace, then archived ones.
 */

/** One Workspace as the Host reports it. */
export interface WorkspaceRow {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  /** Sessions accounted to this Workspace, in manual order. */
  readonly sessionIds: readonly string[]
}

/** The whole Workspace state: the registry in display order, plus pins and archives. */
export interface WorkspaceView {
  readonly items: readonly WorkspaceRow[]
  readonly archivedSessionIds: readonly string[]
  readonly pinnedSessionIds: readonly string[]
}

/** One line of the Workspace section. Headers are not Sessions; they only group them. */
export type WorkspaceListRow =
  | { readonly kind: 'workspace'; readonly workspaceId: string; readonly title: string; readonly path: string; readonly count: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'archived' }
  | {
      readonly kind: 'session'
      readonly sessionId: string
      readonly title: string
      readonly workspaceId: string | undefined
      readonly pinned: boolean
      readonly archived: boolean
      readonly running: boolean
    }

/** A Session as the grouping needs it: the title is the one the sidebar shows. */
export interface GroupableSession {
  readonly sessionId: string
  readonly title: string
  readonly running: boolean
}

/** @returns an empty Workspace state, before the baseline arrives. */
export function emptyWorkspaces(): WorkspaceView {
  return { items: [], archivedSessionIds: [], pinnedSessionIds: [] }
}

/**
 * Read one Workspace. Entries without an id or a path are dropped.
 * @param value - a Workspace object from the Host.
 * @returns the Workspace, or undefined when it is not usable.
 */
export function normalizeWorkspace(value: unknown): WorkspaceRow | undefined {
  if (!isRecord(value) || typeof value['workspaceId'] !== 'string' || typeof value['path'] !== 'string') return undefined
  return {
    workspaceId: value['workspaceId'],
    path: value['path'],
    title: typeof value['title'] === 'string' && value['title'].length > 0 ? value['title'] : value['path'],
    sessionIds: stringList(value['sessionIds']),
  }
}

/**
 * Apply one frame of `workspace/follow` to the view. Unknown frames are ignored,
 * so a newer Host cannot break the section.
 * @param view - the view so far.
 * @param frame - one frame as received.
 * @returns the next view.
 */
export function applyWorkspaceFrame(view: WorkspaceView, frame: unknown): WorkspaceView {
  if (!isRecord(frame) || typeof frame['type'] !== 'string') return view
  switch (frame['type']) {
    case 'baseline': {
      const value = isRecord(frame['value']) ? frame['value'] : {}
      return {
        items: Array.isArray(value['items']) ? value['items'].flatMap(item => normalizeWorkspace(item) ?? []) : [],
        archivedSessionIds: stringList(value['archivedSessionIds']),
        pinnedSessionIds: stringList(value['pinnedSessionIds']),
      }
    }
    case 'upsert': {
      const next = normalizeWorkspace(frame['workspace'])
      if (next === undefined) return view
      const exists = view.items.some(item => item.workspaceId === next.workspaceId)
      return { ...view, items: exists ? view.items.map(item => (item.workspaceId === next.workspaceId ? next : item)) : [...view.items, next] }
    }
    case 'pinned': return { ...view, pinnedSessionIds: stringList(frame['pinnedSessionIds']) }
    case 'archived': return { ...view, archivedSessionIds: stringList(frame['archivedSessionIds']) }
    case 'order': {
      const order = stringList(frame['workspaceIds'])
      const byId = new Map(view.items.map(item => [item.workspaceId, item] as const))
      const ordered = order.flatMap(id => byId.get(id) ?? [])
      const rest = view.items.filter(item => !order.includes(item.workspaceId))
      return { ...view, items: [...ordered, ...rest] }
    }
    case 'remove': {
      const id = frame['workspaceId']
      return { ...view, items: view.items.filter(item => item.workspaceId !== id) }
    }
    default: return view
  }
}

/**
 * Lay the Sessions out in groups. Pinned Sessions come first inside each group.
 * A Session that the Host no longer lists is not shown.
 * @param view - the Workspace state.
 * @param sessions - the Sessions the panel knows.
 * @returns the rows, headers included, in display order.
 */
export function groupRows(view: WorkspaceView, sessions: readonly GroupableSession[]): WorkspaceListRow[] {
  const known = new Map(sessions.map(session => [session.sessionId, session] as const))
  const archived = new Set(view.archivedSessionIds)
  const pinned = new Set(view.pinnedSessionIds)
  const accounted = new Set<string>()
  const rows: WorkspaceListRow[] = []
  const sessionRow = (sessionId: string, workspaceId: string | undefined, isArchived: boolean): WorkspaceListRow | undefined => {
    const session = known.get(sessionId)
    if (session === undefined) return undefined
    return {
      kind: 'session',
      sessionId,
      title: session.title.length > 0 ? session.title : sessionId,
      workspaceId,
      pinned: pinned.has(sessionId),
      archived: isArchived,
      running: session.running,
    }
  }
  const sorted = (list: WorkspaceListRow[]): WorkspaceListRow[] => [
    ...list.filter(row => row.kind === 'session' && row.pinned),
    ...list.filter(row => !(row.kind === 'session' && row.pinned)),
  ]

  for (const workspace of view.items) {
    const members: WorkspaceListRow[] = []
    for (const sessionId of workspace.sessionIds) {
      accounted.add(sessionId)
      if (archived.has(sessionId)) continue
      const row = sessionRow(sessionId, workspace.workspaceId, false)
      if (row !== undefined) members.push(row)
    }
    rows.push({ kind: 'workspace', workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path, count: members.length })
    rows.push(...sorted(members))
  }

  const loose: WorkspaceListRow[] = []
  for (const session of sessions) {
    if (accounted.has(session.sessionId) || archived.has(session.sessionId)) continue
    const row = sessionRow(session.sessionId, undefined, false)
    if (row !== undefined) loose.push(row)
  }
  rows.push({ kind: 'none' }, ...sorted(loose))

  const hidden: WorkspaceListRow[] = []
  for (const sessionId of view.archivedSessionIds) {
    const row = sessionRow(sessionId, undefined, true)
    if (row !== undefined) hidden.push(row)
  }
  if (hidden.length > 0) rows.push({ kind: 'archived' }, ...hidden)
  return rows
}

/**
 * Where a Session moves when the user shifts it one place among its siblings.
 * Moves stay inside the group the row belongs to.
 * @param rows - the rows as displayed.
 * @param index - the row being moved.
 * @param direction - -1 up, +1 down.
 * @returns the Workspace and the Session to insert before (undefined = last), or undefined when it cannot move.
 */
export function sessionMove(rows: readonly WorkspaceListRow[], index: number, direction: -1 | 1): { workspaceId: string; beforeSessionId: string | undefined } | undefined {
  const row = rows[index]
  if (row === undefined || row.kind !== 'session' || row.workspaceId === undefined) return undefined
  const siblings: string[] = []
  for (const item of rows) {
    if (item.kind === 'session' && item.workspaceId === row.workspaceId) siblings.push(item.sessionId)
  }
  const at = siblings.indexOf(row.sessionId)
  const target = at + direction * 1
  if (target < 0 || target >= siblings.length) return undefined
  if (direction < 0) return { workspaceId: row.workspaceId, beforeSessionId: siblings[target] }
  return { workspaceId: row.workspaceId, beforeSessionId: siblings[target + 1] }
}

/**
 * Where a Workspace moves when shifted one place in the registry order.
 * @param view - the Workspace state.
 * @param workspaceId - the Workspace to move.
 * @param direction - -1 up, +1 down.
 * @returns the Workspace to insert before (undefined = last), or undefined when it cannot move.
 */
export function workspaceMove(view: WorkspaceView, workspaceId: string, direction: -1 | 1): { beforeWorkspaceId: string | undefined } | undefined {
  const at = view.items.findIndex(item => item.workspaceId === workspaceId)
  const target = at + direction
  if (at < 0 || target < 0 || target >= view.items.length) return undefined
  if (direction < 0) return { beforeWorkspaceId: view.items[target]?.workspaceId }
  return { beforeWorkspaceId: view.items[target + 1]?.workspaceId }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
