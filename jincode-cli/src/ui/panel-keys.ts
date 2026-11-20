/**
 * Keys of the panel overlay. Each section reads its own keys; the controller
 * applies the result. Kept apart from the screen so the rules can be tested.
 */
import { emptyBuffer, bufferOf, textOf, type Buffer } from './composer.ts'
import { editField, type KeyLike } from './keys.ts'
import { panelRowCount, panelSelection, CONFIRMED_PRESETS } from './Panel.tsx'
import { PANEL_SECTIONS, groupableSessions, subagentsOf, type AppState, type AppController, type PanelSection } from '../app/controller.ts'
import { groupRows } from '../app/workspace-model.ts'
import {
  SCHEDULE_FIELDS,
  createRequest,
  editRequest,
  emptyScheduleForm,
  fieldOf,
  nextFieldIndex,
  scheduleFormOf,
  withField,
  type ScheduleForm,
} from '../app/schedule-model.ts'
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

/** The schedule form while it is open: its values and the field that has the focus. */
export interface ScheduleEditor {
  readonly form: ScheduleForm
  readonly index: number
}

/**
 * Keys of the subagents section. Enter opens the subagent under the cursor, or
 * sends the typed message when there is one. Ctrl+X interrupts it and Ctrl+D
 * switches the delivery between the next turn (queue) and the current step (steer).
 * Control keys are used so that typing a message never triggers an action.
 * @param keys - the panel keys.
 */
function handleSubagentKey(keys: PanelKeys): void {
  const { input, key, state, controller, field, setField, cursor } = keys
  if (key.ctrl && input === 'x') {
    const child = subagentsOf(state.sessions, state.activeId)[cursor]
    if (child !== undefined) void controller.interruptChild(child.sessionId)
    return
  }
  if (key.ctrl && input === 'd') {
    controller.toggleSubagentDelivery()
    return
  }
  if (key.ctrl) return
  const child = subagentsOf(state.sessions, state.activeId)[cursor]
  if (child === undefined) return
  if (key.return) {
    const text = textOf(field)
    if (text.trim().length === 0) {
      void controller.openFromList(child.sessionId)
      controller.setOverlay('none')
      return
    }
    setField(emptyBuffer())
    void controller.sendToChild(child.sessionId, text)
    return
  }
  setField(editField(field, input, key))
}

/**
 * Keys of the schedule section. With the form open, the arrows move between
 * fields and Enter saves; the form is validated here before anything is sent.
 * In the list, n creates, Enter or e edits, p pauses or resumes, r runs, h reads
 * the deliveries, and x (or c for the ended ones) asks twice before deleting.
 * @param keys - the panel keys; `section` is the schedule section.
 */
function handleScheduleKey(keys: PanelKeys & { section: PanelSection }): void {
  const { input, key, state, controller, field, setField, cursor, scheduleEditor, setScheduleEditor, armed, setArmed } = keys
  const sessionOpen = state.activeId !== undefined
  if (scheduleEditor !== undefined) {
    const { index } = scheduleEditor
    const form = withField(scheduleEditor.form, SCHEDULE_FIELDS[index] ?? 'title', textOf(field))
    if (key.upArrow || key.downArrow) {
      const next = nextFieldIndex(index, key.downArrow === true ? 1 : -1)
      setScheduleEditor({ form, index: next })
      setField(bufferOf(fieldOf(form, SCHEDULE_FIELDS[next] ?? 'title')))
      return
    }
    if (key.return) {
      const built = form.mode === 'edit' ? editRequest(form, state.activeId) : createRequest(form, state.activeId)
      if (!built.ok) {
        setScheduleEditor({ form, index })
        controller.notePanel(built.error)
        return
      }
      setScheduleEditor({ form, index })
      void controller.saveSchedule(built.request, form.mode === 'edit').then((saved) => {
        if (saved) {
          setScheduleEditor(undefined)
          setField(emptyBuffer())
        }
      })
      return
    }
    setField(editField(field, input, key))
    return
  }

  const tasks = state.panel.schedules ?? []
  const task = tasks[cursor]
  const wasArmed = armed
  if (wasArmed !== undefined) setArmed(undefined)
  if (key.ctrl) return
  if (input === 'n') {
    setScheduleEditor({ form: emptyScheduleForm(sessionOpen), index: 0 })
    setField(emptyBuffer())
    return
  }
  if (input === 'c') {
    if (wasArmed === 'clear') {
      void controller.clearEndedSchedules()
      return
    }
    setArmed('clear')
    controller.notePanel('pulsa c otra vez para eliminar todas las programaciones terminadas')
    return
  }
  if (task === undefined) return
  if (key.return || input === 'e') {
    const form = scheduleFormOf(task)
    setScheduleEditor({ form, index: 0 })
    setField(bufferOf(form.title))
  } else if (input === 'p') {
    void controller.toggleSchedule(task)
  } else if (input === 'r') {
    void controller.runSchedule(task)
  } else if (input === 'h') {
    void controller.loadScheduleHistory(task)
  } else if (input === 'x') {
    if (wasArmed === `delete:${task.id}`) {
      void controller.deleteSchedule(task)
      return
    }
    setArmed(`delete:${task.id}`)
    controller.notePanel(`pulsa x otra vez para eliminar «${task.title}»`)
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
  scheduleEditor: ScheduleEditor | undefined
  setScheduleEditor: (value: ScheduleEditor | undefined) => void
  /** A destructive schedule action waiting for its second key press. */
  armed: string | undefined
  setArmed: (value: string | undefined) => void
}

/**
 * Keys of the panel overlay. Tab moves between sections; each section reads its
 * own keys. Destructive or broad actions need a second Enter (permissions) or
 * an empty field (goal removal), so a stray key cannot apply them.
 * @param keys - the event and the state and setters it needs.
 */
export function handlePanelKey(keys: PanelKeys): void {
  const { input, key, state, controller, field, setField, cursor, setCursor, pendingPreset, setPendingPreset, editingItem, setEditingItem, scheduleEditor, setScheduleEditor, armed, setArmed } = keys
  const section = state.panel.section
  const moveSection = (delta: number): void => {
    const index = PANEL_SECTIONS.indexOf(section)
    const next = PANEL_SECTIONS[(index + delta + PANEL_SECTIONS.length) % PANEL_SECTIONS.length] as PanelSection
    setCursor(0)
    setPendingPreset(undefined)
    setEditingItem(undefined)
    setScheduleEditor(undefined)
    setArmed(undefined)
    setField(emptyBuffer())
    void controller.setSection(next)
  }
  if (key.tab) {
    moveSection(key.shift === true ? -1 : 1)
    return
  }
  const count = panelRowCount(state)
  // The schedule form uses the arrows to move between its fields.
  if (key.upArrow && editingItem === undefined && scheduleEditor === undefined) {
    setCursor(index => Math.max(0, index - 1))
    setPendingPreset(undefined)
    setArmed(undefined)
    return
  }
  if (key.downArrow && editingItem === undefined && scheduleEditor === undefined) {
    setCursor(index => Math.min(Math.max(0, count - 1), index + 1))
    setPendingPreset(undefined)
    setArmed(undefined)
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

  if (section === 'terminals') {
    const view = state.panel.terminals
    if (view === undefined || view.sessionId !== state.activeId) return
    if (view.choosing) {
      if (key.return) {
        const shell = view.shells?.[cursor]
        setCursor(0)
        void controller.startTerminal(shell?.path)
      }
      return
    }
    if (editingItem !== undefined) {
      if (!key.return) {
        setField(editField(field, input, key))
        return
      }
      const text = textOf(field)
      const target = view.items?.[cursor]
      setEditingItem(undefined)
      setField(emptyBuffer())
      if (target !== undefined) void controller.renameTerminal(target.id, text)
      return
    }
    const target = view.items?.[cursor]
    if (key.return) {
      if (target !== undefined) void controller.attachTerminal(target.id)
    } else if (input === 'n') {
      setCursor(0)
      void controller.openTerminalChoice()
    } else if (input === 'r') {
      if (target !== undefined) {
        setEditingItem('rename')
        setField(bufferOf(target.title.length > 0 ? target.title : target.shell.name))
      }
    } else if (input === 'x') {
      if (target !== undefined) {
        setCursor(index => Math.max(0, index - 1))
        void controller.closeTerminal(target.id)
      }
    }
    return
  }

  if (section === 'schedule') {
    handleScheduleKey({ ...keys, section })
    return
  }

  if (section === 'subagents') {
    handleSubagentKey(keys)
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
    // Editing the objective: the field starts with the current one; Enter saves it, Esc cancels.
    if (editingItem === 'goal') {
      if (key.return) {
        const objective = textOf(field)
        setEditingItem(undefined)
        setField(emptyBuffer())
        void controller.editGoal(objective)
      } else setField(editField(field, input, key))
      return
    }
    if (textOf(field).length === 0) {
      if (input === 'p') void controller.goalAction('pause')
      else if (input === 'r') void controller.goalAction('resume')
      else if (input === 'c') void controller.goalAction('complete')
      else if (input === 'x') void controller.clearGoal()
      else if (input === 'e' && state.panel.goal !== undefined && state.panel.goal !== null) {
        setEditingItem('goal')
        setField(bufferOf(state.panel.goal.objective))
      }
    }
    return
  }
}
