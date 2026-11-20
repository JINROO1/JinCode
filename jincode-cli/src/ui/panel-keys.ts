/**
 * Keys of the panel overlay. Each section reads its own keys; the controller
 * applies the result. Kept apart from the screen so the rules can be tested.
 */
import { emptyBuffer, bufferOf, textOf, type Buffer } from './composer.ts'
import { editField, type KeyLike } from './keys.ts'
import { panelRowCount, panelSelection, CONFIRMED_PRESETS } from './Panel.tsx'
import { PANEL_SECTIONS, type AppState, type AppController, type PanelSection } from '../app/controller.ts'

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
