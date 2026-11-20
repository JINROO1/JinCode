import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyWorkspaceFrame, emptyWorkspaces, groupRows, sessionMove, workspaceMove, type WorkspaceView } from '../src/app/workspace-model.ts'

const ws = (id: string, sessionIds: string[] = [], title = id) => ({ workspaceId: id, path: `/p/${id}`, title, sessionIds, createdAt: 'x', updatedAt: 'x' })
const SESSIONS = [
  { sessionId: 's1', title: 'uno', running: false },
  { sessionId: 's2', title: 'dos', running: true },
  { sessionId: 's3', title: 'Sesión sin título', running: false },
  { sessionId: 's4', title: 'cuatro', running: false },
]

test('the baseline replaces the view; a malformed one reads as empty', () => {
  const view = applyWorkspaceFrame(emptyWorkspaces(), {
    type: 'baseline',
    value: { items: [ws('a', ['s1']), { title: 'sin id' }], archivedSessionIds: ['s4'], pinnedSessionIds: ['s2'] },
  })
  assert.deepEqual(view.items.map(item => item.workspaceId), ['a'])
  assert.deepEqual(view.archivedSessionIds, ['s4'])
  assert.deepEqual(view.pinnedSessionIds, ['s2'])
  assert.deepEqual(applyWorkspaceFrame(view, { type: 'baseline', value: null }), emptyWorkspaces())
})

test('increments fold in: upsert adds or replaces, order reorders, remove drops, pins and archives replace their lists', () => {
  let view: WorkspaceView = applyWorkspaceFrame(emptyWorkspaces(), { type: 'baseline', value: { items: [ws('a'), ws('b')] } })
  view = applyWorkspaceFrame(view, { type: 'upsert', workspace: ws('a', [], 'Alfa') })
  assert.deepEqual(view.items.map(item => [item.workspaceId, item.title]), [['a', 'Alfa'], ['b', 'b']])
  view = applyWorkspaceFrame(view, { type: 'upsert', workspace: ws('c') })
  assert.deepEqual(view.items.map(item => item.workspaceId), ['a', 'b', 'c'])
  view = applyWorkspaceFrame(view, { type: 'order', workspaceIds: ['c', 'a'] })
  assert.deepEqual(view.items.map(item => item.workspaceId), ['c', 'a', 'b'], 'ids not listed keep their place at the end')
  view = applyWorkspaceFrame(view, { type: 'remove', workspaceId: 'a' })
  assert.deepEqual(view.items.map(item => item.workspaceId), ['c', 'b'])
  view = applyWorkspaceFrame(view, { type: 'pinned', pinnedSessionIds: ['s1'] })
  view = applyWorkspaceFrame(view, { type: 'archived', archivedSessionIds: ['s3'] })
  assert.deepEqual([view.pinnedSessionIds, view.archivedSessionIds], [['s1'], ['s3']])
  assert.equal(applyWorkspaceFrame(view, { type: 'future-frame' }), view, 'unknown frames change nothing')
  assert.equal(applyWorkspaceFrame(view, 'not a frame'), view)
})

test('groups: each Workspace, then Sessions with no Workspace, then archived ones; pinned first inside a group', () => {
  const view: WorkspaceView = {
    items: [ws('a', ['s1', 's2'], 'Alfa'), ws('b', [], 'Beta')],
    archivedSessionIds: ['s4'],
    pinnedSessionIds: ['s2'],
  }
  const rows = groupRows(view, SESSIONS)
  const shape = rows.map(row => row.kind === 'session' ? `${row.sessionId}${row.pinned ? '*' : ''}${row.running ? '~' : ''}` : row.kind === 'workspace' ? `W:${row.title}(${row.count})` : row.kind)
  assert.deepEqual(shape, ['W:Alfa(2)', 's2*~', 's1', 'W:Beta(0)', 'none', 's3', 'archived', 's4'])
  const archived = rows.find(row => row.kind === 'session' && row.sessionId === 's4')
  assert.equal(archived?.kind === 'session' && archived.archived, true)
})

test('a session the Host no longer lists is not shown; the title is the one the sidebar shows', () => {
  const rows = groupRows({ items: [ws('a', ['gone', 's3'])], archivedSessionIds: ['also-gone'], pinnedSessionIds: [] }, SESSIONS)
  const titles = rows.flatMap(row => row.kind === 'session' ? [row.title] : [])
  assert.deepEqual(titles, ['Sesión sin título', 'uno', 'dos', 'cuatro'])
  assert.equal(titles.includes('gone'), false)
  assert.equal(titles.includes('also-gone'), false)
  assert.ok(titles.includes('Sesión sin título'))
})

test('a session moves among its siblings, and never out of its Workspace', () => {
  const view: WorkspaceView = { items: [ws('a', ['s1', 's2', 's4'])], archivedSessionIds: [], pinnedSessionIds: [] }
  const rows = groupRows(view, SESSIONS)
  const index = (id: string) => rows.findIndex(row => row.kind === 'session' && row.sessionId === id)
  assert.deepEqual(sessionMove(rows, index('s2'), -1), { workspaceId: 'a', beforeSessionId: 's1' })
  assert.deepEqual(sessionMove(rows, index('s2'), 1), { workspaceId: 'a', beforeSessionId: undefined }, 'moving down past the last one goes to the end')
  assert.deepEqual(sessionMove(rows, index('s1'), 1), { workspaceId: 'a', beforeSessionId: 's4' })
  assert.equal(sessionMove(rows, index('s1'), -1), undefined, 'the first cannot move up')
  assert.deepEqual(sessionMove(rows, index('s4'), 1), undefined, 'the last cannot move down')
  assert.equal(sessionMove(rows, 0, 1), undefined, 'a header cannot move')
})

test('a Workspace moves one place in the registry; the first and last cannot move past the ends', () => {
  const view: WorkspaceView = { items: [ws('a'), ws('b'), ws('c')], archivedSessionIds: [], pinnedSessionIds: [] }
  assert.deepEqual(workspaceMove(view, 'b', -1), { beforeWorkspaceId: 'a' })
  assert.deepEqual(workspaceMove(view, 'b', 1), { beforeWorkspaceId: undefined }, 'b goes after c, which is the end')
  assert.deepEqual(workspaceMove(view, 'a', 1), { beforeWorkspaceId: 'c' }, 'a goes after b')
  assert.equal(workspaceMove(view, 'c', 1), undefined, 'the last one cannot move down')
  assert.equal(workspaceMove(view, 'a', -1), undefined)
  assert.equal(workspaceMove(view, 'zz', 1), undefined)
})
