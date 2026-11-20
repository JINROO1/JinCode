/**
 * The panel: one overlay with six sections (queue, permissions, settings, goals,
 * schedules, skills). The header and the footer stay fixed; the body scrolls so
 * the row under the cursor is always visible, and says how many lines are hidden
 * instead of cutting them silently.
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { AppState, PanelSection } from '../app/controller.ts'
import { PANEL_SECTIONS, groupableSessions } from '../app/controller.ts'
import { packHints, wrapText } from './layout.ts'
import { type Buffer, textOf } from './composer.ts'
import { type StyledLine, type Tone } from './format.ts'
import { palette } from './theme.ts'
import { fieldSummary, settingsFields } from '../app/settings-model.ts'
import { groupRows } from '../app/workspace-model.ts'
import { fileRowsOf, sizeLabel } from '../app/file-model.ts'

/** Human labels for the section tabs. */
export const SECTION_LABEL: Record<PanelSection, string> = {
  queue: 'Cola',
  permissions: 'Permisos',
  settings: 'Ajustes',
  workspaces: 'Espacios',
  files: 'Archivos',
  goals: 'Metas',
  schedule: 'Programaciones',
  skills: 'Habilidades',
}

/** Spanish labels for the goal phases the Host reports; unknown phases show as they are. */
export const PHASE_LABEL: Record<string, string> = {
  active: 'activa',
  paused: 'pausada',
  complete: 'completada',
  completed: 'completada',
  cleared: 'eliminada',
}

/** Presets whose effect needs an explicit confirmation before it applies. */
export const CONFIRMED_PRESETS: readonly string[] = ['danger-full-access']

/** Props the panel needs from the screen. */
export interface PanelProps {
  readonly state: AppState
  readonly width: number
  readonly height: number
  readonly cursor: number
  readonly field: Buffer
  /** Queue message being edited, when the edit mode is on. */
  readonly editing: string | undefined
  /** Preset waiting for confirmation. */
  readonly pendingPreset: string | undefined
}

/** What a section renders: a scrollable body, the row to keep in view, and fixed hints. */
export interface SectionView {
  readonly body: StyledLine[]
  /** Index in `body` of the row under the cursor, when the section has rows. */
  readonly focus: number | undefined
  readonly footer: StyledLine[]
}

/**
 * How many rows the current section lists, for cursor bounds.
 * @param state - the controller snapshot.
 * @returns the row count; zero for sections without a list.
 */
export function panelRowCount(state: AppState): number {
  const panel = state.panel
  switch (panel.section) {
    case 'queue': return panel.queue?.length ?? 0
    case 'permissions': return panel.presets?.options.length ?? 0
    case 'settings': return panel.settings === undefined ? 0 : settingsFields(panel.settings).length
    case 'workspaces': return panel.workspaces === undefined ? 0 : groupRows(panel.workspaces, groupableSessions(state.sessions)).length
    case 'files': return panel.files === undefined || panel.files.page !== undefined ? 0 : fileRowsOf(panel.files).length
    case 'schedule': return panel.schedules?.length ?? 0
    case 'skills': return panel.skills?.length ?? 0
    case 'goals': return 0
  }
}

/**
 * The item under the cursor in the current section, when it has one.
 * @param state - the controller snapshot.
 * @param cursor - the cursor position.
 * @returns the queue message id or the preset name, or undefined.
 */
export function panelSelection(state: AppState, cursor: number): { id: string; kind: 'queue' | 'preset' } | undefined {
  const panel = state.panel
  if (panel.section === 'queue') {
    const row = panel.queue?.[cursor]
    return row === undefined ? undefined : { id: row.id, kind: 'queue' }
  }
  if (panel.section === 'permissions') {
    const option = panel.presets?.options[cursor]
    return option === undefined ? undefined : { id: option, kind: 'preset' }
  }
  return undefined
}

/**
 * Choose the rows to show: the window of `available` lines that keeps `focus` visible.
 * @param total - all body lines.
 * @param available - rows the body may use.
 * @param focus - the line to keep in view, if any.
 * @returns the first line to show and how many lines are hidden above and below.
 */
export function bodyWindow(total: number, available: number, focus: number | undefined): { start: number; above: number; below: number } {
  if (total <= available) return { start: 0, above: 0, below: 0 }
  const size = Math.max(1, available)
  const wanted = focus === undefined ? 0 : focus - Math.floor(size / 2)
  const start = Math.max(0, Math.min(total - size, wanted))
  return { start, above: start, below: total - start - size }
}

/**
 * Render the panel overlay.
 * @param props - the screen state and the panel's local controls.
 * @returns the element, sized to the body area.
 */
export function Panel(props: PanelProps): React.ReactElement {
  const { state, width, height } = props
  const tabs = packHints(PANEL_SECTIONS.map(section => SECTION_LABEL[section]), Math.max(10, width), '  ')
  const head: StyledLine[] = [
    { text: 'Panel', tone: 'brand', bold: true },
    ...tabs.map(text => ({ text, tone: 'accent' as Tone, bold: true })),
  ]
  const note: StyledLine[] = state.panel.note !== undefined
    ? wrapText(state.panel.note, width).map(text => ({ text, tone: 'success' as Tone }))
    : []
  const view = sectionView(props)
  let rows = Math.max(1, height - head.length - note.length - view.footer.length)
  const scrolls = view.body.length > rows
  if (scrolls) rows = Math.max(1, rows - 1)
  const span = bodyWindow(view.body.length, rows, view.focus)
  const visible = view.body.slice(span.start, span.start + rows)
  const indicator: StyledLine[] = scrolls
    ? [{ text: `▲ ${span.above} arriba · ▼ ${span.below} abajo · ↑↓ mueven el cursor`, tone: 'faint' }]
    : []
  const lines: StyledLine[] = [...head, ...visible, ...indicator, ...note, ...view.footer]
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {lines.slice(0, height).map((line, index) => (
        <Text key={index} color={toneOf(line.tone)} bold={line.bold} italic={line.italic}>{line.text.length === 0 ? ' ' : line.text}</Text>
      ))}
    </Box>
  )
}

/**
 * Lay out the section under the cursor. Every line is wrapped to the width, so
 * nothing is cut inside a row.
 * @param props - the panel props.
 * @returns the body, the focus row and the fixed footer.
 */
export function sectionView(props: PanelProps): SectionView {
  const { state, width, cursor, field, editing, pendingPreset } = props
  const panel = state.panel
  const body: StyledLine[] = []
  const footer: StyledLine[] = []
  let focus: number | undefined
  const add = (text: string, tone: Tone = 'text', extra: Partial<StyledLine> = {}): void => {
    for (const line of wrapText(text, width)) body.push({ text: line, tone, ...extra })
  }
  const row = (text: string, active: boolean): void => {
    if (active) focus = body.length
    add(text, active ? 'brand' : 'text', { bold: active })
  }
  const hint = (text: string): void => {
    for (const line of wrapText(text, width)) footer.push({ text: line, tone: 'faint' })
  }
  const notice = (text: string, tone: Tone): void => {
    for (const line of wrapText(text, width)) footer.push({ text: line, tone })
  }

  switch (panel.section) {
    case 'queue': {
      if (state.activeId === undefined) return { body: [{ text: 'Abre una sesión para ver su cola.', tone: 'muted' }], focus, footer }
      if (panel.queue === undefined) return { body: [{ text: 'Cargando la cola…', tone: 'muted' }], focus, footer }
      if (panel.queue.length === 0) {
        add('La cola está vacía. Escribe mientras hay un turno en curso para encolar un mensaje.', 'muted')
        return { body, focus, footer }
      }
      panel.queue.forEach((item, index) => {
        const placement = item.placement === 'steering' ? 'dirigiendo' : item.placement === 'context' ? 'contexto' : 'en cola'
        row(`${index === cursor ? '›' : ' '} [${placement}] ${item.text}`, index === cursor)
      })
      if (editing !== undefined) {
        notice('Editar el mensaje · Enter guarda · Esc cancela', 'accent')
        notice(`${textOf(field)}▌`, 'text')
      } else {
        hint('s dirigir al turno · e editar · x quitar · Tab cambia de sección')
      }
      return { body, focus, footer }
    }
    case 'permissions': {
      if (panel.presets === undefined) return { body: [{ text: 'Cargando los permisos…', tone: 'muted' }], focus, footer }
      const current = state.sessions.find(item => item.sessionId === state.activeId)?.permission
      add(`Actual: ${current ?? 'desconocido'} · Predeterminado del Host: ${panel.presets.defaultPreset ?? '—'}`, 'muted')
      panel.presets.options.forEach((option, index) => {
        const mark = option === current ? '✓' : ' '
        row(`${mark} ${index === cursor ? '›' : ' '} ${option}`, index === cursor)
      })
      if (pendingPreset !== undefined) {
        notice(`⚠ ${pendingPreset} no tiene confinamiento: el agente puede ejecutar comandos y tocar archivos fuera del espacio de trabajo.`, 'warning')
        notice('Enter otra vez confirma · Esc cancela', 'warning')
      } else {
        hint('Enter aplica el permiso a los turnos siguientes')
      }
      return { body, focus, footer }
    }
    case 'settings': {
      if (panel.settings === undefined) return { body: [{ text: 'Cargando los ajustes…', tone: 'muted' }], focus, footer }
      const fields = settingsFields(panel.settings)
      if (fields.length === 0) {
        add('Este perfil no tiene ajustes.', 'muted')
        return { body, focus, footer }
      }
      let group: string | undefined
      fields.forEach((item, index) => {
        if (item.ns !== group) {
          group = item.ns
          const meta = panel.settings?.find(entry => entry.ns === item.ns)
          add(`${item.ns} · rev ${item.revision} · ${meta?.applies ?? ''}`, 'accent', { bold: true })
        }
        const active = index === cursor
        const mark = item.overridden ? ' ✎' : ''
        row(`${active ? '›' : ' '} ${item.key}${mark}: ${fieldSummary(item)}`, active)
      })
      const selected = fields[cursor]
      if (selected !== undefined && editing !== undefined && editing.endsWith('\u0000*')) {
        notice(`Editar la sección ${selected.ns} (JSON) · Enter guarda · Esc cancela`, 'accent')
        notice(`${textOf(field)}▌`, 'text')
      } else if (selected !== undefined && editing !== undefined) {
        notice(`Editar ${selected.key} · Enter guarda · Esc cancela`, 'accent')
        notice(selected.secret ? `${'•'.repeat(textOf(field).length)}▌` : `${textOf(field)}▌`, 'text')
      } else if (selected !== undefined && !selected.writable) {
        hint('Solo lectura en este perfil')
      } else if (selected !== undefined) {
        const replaceable = panel.settings.find(entry => entry.ns === selected.ns)
        hint(`Enter editar · u quitar el valor propio (✎) · ${replaceable?.secrets.length === 0 ? 'j editar la sección completa' : 'la sección tiene secretos: no se edita entera'}`)
      }
      return { body, focus, footer }
    }
    case 'workspaces': {
      if (panel.workspaces === undefined) return { body: [{ text: 'Cargando los espacios…', tone: 'muted' }], focus, footer }
      const rows = groupRows(panel.workspaces, groupableSessions(state.sessions))
      rows.forEach((item, index) => {
        const active = index === cursor
        const pointer = active ? '›' : ' '
        if (item.kind === 'workspace') row(`${pointer} ▣ ${item.title} (${item.count}) · ${item.path}`, active)
        else if (item.kind === 'none') add('Sin espacio', 'accent', { bold: true })
        else if (item.kind === 'archived') add('Archivadas', 'accent', { bold: true })
        else {
          const tags = [item.pinned ? 'fijada' : undefined, item.archived ? 'archivada' : undefined, item.running ? 'en curso' : undefined].filter(tag => tag !== undefined)
          row(`${pointer}   ${item.title}${tags.length > 0 ? ` [${tags.join(' · ')}]` : ''}`, active)
        }
      })
      const selected = rows[cursor]
      if (editing === 'create') {
        notice('Ruta de la carpeta · Enter crea · vacío = espacio predeterminado · Esc cancela', 'accent')
        notice(`${textOf(field)}▌`, 'text')
      } else if (editing?.startsWith('rename:') === true) {
        notice('Nuevo título · Enter guarda · Esc cancela', 'accent')
        notice(`${textOf(field)}▌`, 'text')
      } else if (selected?.kind === 'workspace') {
        if (pendingPreset === `delete:${selected.workspaceId}`) notice('x otra vez quita el espacio (sus archivos y sesiones se conservan) · Esc cancela', 'warning')
        else hint('n crear · r renombrar · x quitar (dos veces) · [ ] mover')
      } else if (selected?.kind === 'session') {
        hint('p fijar/desfijar · a archivar/restaurar · [ ] mover dentro de su espacio · n crear espacio')
      } else {
        hint('n crear espacio · ↑↓ elegir una fila')
      }
      return { body, focus, footer }
    }
    case 'files': {
      if (state.activeId === undefined) return { body: [{ text: 'Abre una sesión para ver los archivos de su espacio.', tone: 'muted' }], focus, footer }
      const view = panel.files
      if (view === undefined) return { body: [{ text: 'Cargando los archivos…', tone: 'muted' }], focus, footer }
      if (view.page !== undefined) {
        const page = view.page
        const last = page.offset + Math.max(0, page.lines - 1)
        add(`${page.path.length > 0 ? page.path : '.'} · líneas ${page.offset}–${last}${page.eof ? ' (fin)' : ''}`, 'accent', { bold: true })
        if (page.lines === 0) add('La página está fuera del archivo.', 'muted')
        else page.text.split('\n').forEach((line, index) => add(`${String(page.offset + index).padStart(4)} │ ${line}`, 'text'))
        hint('[ página anterior · ] página siguiente · Backspace vuelve al listado')
        return { body, focus, footer }
      }
      const rows = fileRowsOf(view)
      if (view.matches !== undefined) {
        add(`Resultados para «${view.matches.query}»${view.includeHidden ? ' (con ocultos)' : ''}`, 'accent', { bold: true })
        if (view.matches.truncated) add('El Host cortó la lista: afina la búsqueda para ver el resto.', 'warning')
      }
      else add(`Carpeta: ${view.path.length > 0 ? view.path : '(raíz del espacio)'}`, 'accent', { bold: true })
      if (rows.length === 0) add(view.matches !== undefined ? 'Ningún archivo coincide.' : 'La carpeta está vacía.', 'muted')
      rows.forEach((item, index) => {
        const active = index === cursor
        const pointer = active ? '›' : ' '
        if (item.kind === 'up') row(`${pointer} ../`, active)
        else if (item.kind === 'match') row(`${pointer} ${item.type === 'directory' ? '▸' : ' '} ${item.path}${item.type === 'directory' ? '/' : ''}`, active)
        else {
          const label = item.type === 'directory' ? `${item.name}/` : item.type === 'file' ? `${item.name}  ${sizeLabel(item.size)}`.trimEnd() : `${item.name} (otro)`
          row(`${pointer} ${item.type === 'directory' ? '▸' : ' '} ${label}`, active)
        }
      })
      if (editing === 'search') {
        notice('Buscar por nombre · Enter busca · Esc cancela', 'accent')
        notice(`${textOf(field)}▌`, 'text')
      } else hint(`Enter abrir · Backspace subir · / buscar · h ocultos en búsquedas (${view.includeHidden ? 'sí' : 'no'}) · r recargar`)
      return { body, focus, footer }
    }
    case 'goals': {
      if (state.activeId === undefined) return { body: [{ text: 'Abre una sesión para ver sus metas.', tone: 'muted' }], focus, footer }
      if (panel.goal === undefined) return { body: [{ text: 'Cargando la meta…', tone: 'muted' }], focus, footer }
      if (panel.goal === null) {
        add('Sin meta activa. Escribe el objetivo y pulsa Enter para crearla.', 'muted')
        add(`Objetivo: ${textOf(field)}▌`, 'text')
        return { body, focus, footer }
      }
      const goal = panel.goal
      add(`Objetivo: ${goal.objective}`, 'text', { bold: true })
      add(`Estado: ${PHASE_LABEL[goal.phase] ?? goal.phase} · rondas ${goal.roundsStarted}/${goal.maxGoalRounds}`, 'muted')
      hint('p pausar · r reanudar · c completar · x eliminar (con el campo vacío)')
      return { body, focus, footer }
    }
    case 'schedule': {
      if (panel.schedules === undefined) return { body: [{ text: 'Cargando las programaciones…', tone: 'muted' }], focus, footer }
      if (panel.schedules.length === 0) {
        add('No hay tareas programadas.', 'muted')
      }
      panel.schedules.forEach((item, index) => {
        row(`${index === cursor ? '›' : ' '} ${item.title} · ${item.status}`, index === cursor)
      })
      hint('Solo lectura: crear y editar tareas llega en una fase posterior.')
      return { body, focus, footer }
    }
    case 'skills': {
      if (state.activeId === undefined) return { body: [{ text: 'Abre una sesión para ver sus habilidades.', tone: 'muted' }], focus, footer }
      if (panel.skills === undefined) return { body: [{ text: 'Cargando las habilidades…', tone: 'muted' }], focus, footer }
      if (panel.skills.length === 0) add('No hay habilidades disponibles para esta sesión.', 'muted')
      panel.skills.forEach((item, index) => {
        row(`${index === cursor ? '›' : ' '} ${item.name}`, index === cursor)
        if (item.description.length > 0) add(`    ${item.description}`, 'muted')
      })
      return { body, focus, footer }
    }
  }
}

function toneOf(tone: Tone): string | undefined {
  const map: Record<Tone, string | undefined> = {
    text: undefined,
    muted: palette.muted,
    faint: palette.faint,
    brand: palette.brand,
    accent: palette.accent,
    user: palette.user,
    success: palette.success,
    warning: palette.warning,
    error: palette.error,
  }
  return map[tone]
}
