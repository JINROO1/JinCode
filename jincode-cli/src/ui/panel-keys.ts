/**
 * Keys of the panel overlay. Each section reads its own keys; the controller
 * applies the result. Kept apart from the screen so the rules can be tested.
 */
import { emptyBuffer, bufferOf, textOf, type Buffer } from './composer.ts'
import { editField, type KeyLike } from './keys.ts'
import { panelRowCount, panelSelection, CONFIRMED_PRESETS } from './Panel.tsx'
import { PANEL_SECTIONS, groupableSessions, type AppState, type AppController, type PanelSection } from '../app/controller.ts'
import { groupRows } from '../app/workspace-model.ts'
import { fileRowsOf } from '../app/file-model.ts'
import { isErase } from './keys.ts'
import {
  canReplaceSection,
  fieldEditKey,
  fieldText,
  parseFieldText,
  sectionEditKey,
  settingsFields,
} from '../app/settings-model.ts'

/**
 * Read the JSON of a whole section. It must be one object; the Host rejects anything else.
 * @param text - the typed text.
 * @returns the object, or the reason it was refused.
 */
function parseSectionText(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> }
    return { ok: false, error: 'la sección debe ser un objeto JSON' }
  } catch {
    return { ok: false, error: 'el JSON no es válido' }
  }
}

export interface PanelKeys {
  input: string
  key: KeyLike
  state: AppState
  controller: AppController
  field: Buffer
  setField: (value: Buffer) => void
  cursor: number
  setCursor: (value: number | ((index: number) => number)) => void
  pendingPreset: string | undefined
  setPendingPreset: (value: string | undefined) => void
  editingItem: string | undefined
  setEditingItem: (value: string | undefined) => void
}

/**
 * Keys of the panel overlay. Tab moves between sections; each section reads its
 * own keys. Destructive or broad actions need a second Enter (permissions) or
 * an empty field (goal removal), so a stray key cannot apply them.
 * @param keys - the event and the state and setters it needs.
 */
export function handlePanelKey(keys: PanelKeys): void {
  const { input, key, state, controller, field, setField, cursor, setCursor, pendingPreset, setPendingPreset, editingItem, setEditingItem } = keys
  const section = state.panel.section
  const moveSection = (delta: number): void => {
    const index = PANEL_SECTIONS.indexOf(section)
    const next = PANEL_SECTIONS[(index + delta + PANEL_SECTIONS.length) % PANEL_SECTIONS.length] as PanelSection
    setCursor(0)
    setPendingPreset(undefined)
    setEditingItem(undefined)
    setField(emptyBuffer())
    void controller.setSection(next)
  }
  if (key.tab) {
    moveSection(key.shift === true ? -1 : 1)
    return
  }
  const count = panelRowCount(state)
  if (key.upArrow && editingItem === undefined) {
    setCursor(index => Math.max(0, index - 1))
    setPendingPreset(undefined)
    return
  }
  if (key.downArrow && editingItem === undefined) {
    setCursor(index => Math.min(Math.max(0, count - 1), index + 1))
    setPendingPreset(undefined)
    return
  }

  if (section === 'queue') {
    if (editingItem !== undefined) {
      if (key.return) {
        const text = textOf(field)
        setEditingItem(undefined)
        setField(emptyBuffer())
        if (text.trim().length > 0) void controller.queueAction(editingItem, { kind: 'edit', text })
      } else setField(editField(field, input, key))
      return
    }
    const selected = panelSelection(state, cursor)
    if (selected === undefined) return
    if (input === 's') void controller.queueAction(selected.id, { kind: 'steer' })
    else if (input === 'x') void controller.queueAction(selected.id, { kind: 'remove' })
    else if (input === 'e') {
      const row = state.panel.queue?.[cursor]
      if (row !== undefined) {
        setEditingItem(row.id)
        setField(bufferOf(row.text))
      }
    }
    return
  }

  if (section === 'permissions') {
    const selected = panelSelection(state, cursor)
    if (selected === undefined || !key.return) return
    const preset = selected.id
    if (CONFIRMED_PRESETS.includes(preset) && pendingPreset !== preset) {
      setPendingPreset(preset)
      return
    }
    setPendingPreset(undefined)
    void controller.setPreset(preset)
    return
  }

  if (section === 'settings') {
    const rows = state.panel.settings ?? []
    const fields = settingsFields(rows)
    if (editingItem !== undefined) {
      if (!key.return) {
        setField(editField(field, input, key))
        return
      }
      const [ns = '', part = ''] = editingItem.split('\u0000')
      const text = textOf(field)
      if (part === '*') {
        const row = rows.find(item => item.ns === ns)
        if (row === undefined || !canReplaceSection(row)) return
        const parsed = parseSectionText(text)
        if (!parsed.ok) {
          controller.notePanel(parsed.error)
          return
        }
        setEditingItem(undefined)
        setField(emptyBuffer())
        void controller.settingAction(ns, { kind: 'replace', section: parsed.value })
        return
      }
      const target = fields.find(item => item.ns === ns && item.key === part)
      if (target === undefined) {
        setEditingItem(undefined)
        return
      }
      const parsed = parseFieldText(text, target.value, target.secret)
      if (!parsed.ok) {
        controller.notePanel(parsed.error)
        return
      }
      setEditingItem(undefined)
      setField(emptyBuffer())
      void controller.settingAction(ns, { kind: 'set', key: target.key, value: parsed.value })
      return
    }
    const selected = fields[cursor]
    if (selected === undefined) return
    if (input === 'u') {
      if (selected.writable && selected.overridden) void controller.settingAction(selected.ns, { kind: 'unset', key: selected.key })
      return
    }
    if (input === 'j') {
      const row = rows.find(item => item.ns === selected.ns)
      if (row === undefined) return
      if (!canReplaceSection(row)) {
        controller.notePanel('esta sección tiene secretos: edítala campo a campo')
        return
      }
      setEditingItem(sectionEditKey(row.ns))
      setField(bufferOf(JSON.stringify(row.user ?? {})))
      return
    }
    if (key.return) {
      if (!selected.writable) {
        controller.notePanel('los ajustes son de solo lectura en este perfil')
        return
      }
      setEditingItem(fieldEditKey(selected.ns, selected.key))
      setField(bufferOf(selected.secret ? '' : fieldText(selected.value)))
    }
    return
  }

  if (section === 'files') {
    const view = state.panel.files
    if (editingItem !== undefined) {
      if (!key.return) {
        setField(editField(field, input, key))
        return
      }
      const text = textOf(field)
      setEditingItem(undefined)
      setField(emptyBuffer())
      setCursor(0)
      void controller.searchFiles(text)
      return
    }
    if (view === undefined) return
    if (view.page !== undefined) {
      if (input === '[') void controller.pageFile(-1)
      else if (input === ']') void controller.pageFile(1)
      else if (isErase(key, input)) controller.closeFileView()
      return
    }
    if (isErase(key, input)) {
      setCursor(0)
      if (view.matches !== undefined) controller.closeFileView()
      else void controller.upFiles()
      return
    }
    if (input === '/') {
      setEditingItem('search')
      setField(emptyBuffer())
      return
    }
    if (input === 'r') {
      void controller.reloadFiles()
      return
    }
    if (input === 'h') {
      void controller.toggleHidden()
      return
    }
    if (key.return) {
      const row = fileRowsOf(view)[cursor]
      if (row === undefined) return
      if (row.kind === 'up') {
        setCursor(0)
        void controller.upFiles()
      } else if (row.type === 'directory') {
        setCursor(0)
        void controller.browseFiles(row.path)
      } else if (row.type === 'file') void controller.openFile(row.path)
    }
    return
  }

  if (section === 'workspaces') {
    const view = state.panel.workspaces
    const rows = view === undefined ? [] : groupRows(view, groupableSessions(state.sessions))
    if (editingItem !== undefined) {
      if (!key.return) {
        setField(editField(field, input, key))
        return
      }
      const text = textOf(field)
      setEditingItem(undefined)
      setField(emptyBuffer())
      if (editingItem === 'create') void controller.workspaceAction({ kind: 'create', path: text })
      else if (editingItem.startsWith('rename:')) void controller.workspaceAction({ kind: 'rename', workspaceId: editingItem.slice('rename:'.length), title: text })
      return
    }
    if (input === 'n') {
      setEditingItem('create')
      setField(emptyBuffer())
      return
    }
    const selected = rows[cursor]
    if (selected?.kind === 'workspace') {
      const confirm = `delete:${selected.workspaceId}`
      if (input === 'r') {
        setEditingItem(`rename:${selected.workspaceId}`)
        setField(bufferOf(selected.title))
      } else if (input === 'x') {
        if (pendingPreset === confirm) {
          setPendingPreset(undefined)
          void controller.workspaceAction({ kind: 'delete', workspaceId: selected.workspaceId })
        } else setPendingPreset(confirm)
      } else if (input === '[' || input === ']') {
        void controller.workspaceAction({ kind: 'moveWorkspace', workspaceId: selected.workspaceId, direction: input === '[' ? -1 : 1 })
      }
      return
    }
    if (selected?.kind === 'session') {
      if (input === 'p') void controller.workspaceAction({ kind: 'pin', sessionId: selected.sessionId, pinned: !selected.pinned })
      else if (input === 'a') void controller.workspaceAction({ kind: 'archive', sessionId: selected.sessionId, archived: !selected.archived })
      else if (input === '[' || input === ']') void controller.workspaceAction({ kind: 'moveSession', index: cursor, direction: input === '[' ? -1 : 1 })
    }
    return
  }

  if (section === 'goals') {
    if (state.panel.goal === null || state.panel.goal === undefined) {
      if (key.return) {
        const objective = textOf(field)
        setField(emptyBuffer())
        void controller.createGoal(objective)
      } else if (state.panel.goal === null) setField(editField(field, input, key))
      return
    }
    if (textOf(field).length === 0) {
      if (input === 'p') void controller.goalAction('pause')
      else if (input === 'r') void controller.goalAction('resume')
      else if (input === 'c') void controller.goalAction('complete')
      else if (input === 'x') void controller.clearGoal()
    }
    return
  }
}
