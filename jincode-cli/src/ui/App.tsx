/**
 * The full-screen terminal interface. It renders the controller's snapshot and
 * forwards keys to it. Layout rules live in layout.ts and text layout in
 * format.ts, so this file only composes them.
 */
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { AppController, titleOf, type AppState, type Overlay } from '../app/controller.ts'
import { bufferOf, clear, down, emptyBuffer, end, home, insert, layout, left, right, textOf, up, type Buffer } from './composer.ts'
import { cellWidth, packHints, pickLayout, truncate, wrapText } from './layout.ts'
import { maskSecret, rule, sessionRows, transcriptLines, type StyledLine, type Tone } from './format.ts'
import { glyph, palette } from './theme.ts'
import { Panel } from './Panel.tsx'
import { editField, eraseBack, isErase, type KeyLike } from './keys.ts'
import { handlePanelKey } from './panel-keys.ts'

const toneColor: Record<Tone, string> = {
  text: '',
  muted: palette.muted,
  faint: palette.faint,
  brand: palette.brand,
  accent: palette.accent,
  user: palette.user,
  success: palette.success,
  warning: palette.warning,
  error: palette.error,
}

const HINTS = [
  'Enter enviar',
  'Alt+Enter nueva línea',
  'Ctrl+K sesiones',
  'Ctrl+T panel',
  'Ctrl+O modelo',
  'Ctrl+G claves',
  'Ctrl+F buscar',
  'Ctrl+Q salir',
]

/** Props for the root component. */
export interface AppProps {
  readonly controller: AppController
  /** Host address shown in the header, without the token. */
  readonly hostLabel: string
}

/**
 * Keep the component in step with the controller's snapshots.
 * @param controller - the bound controller.
 * @returns the current snapshot.
 */
function useAppState(controller: AppController): AppState {
  return useSyncExternalStore(
    listener => controller.subscribe(() => listener()),
    () => controller.snapshot(),
  )
}

/**
 * Track the terminal size and re-render on resize.
 * @returns columns and rows.
 */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout()
  const [size, setSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
  useEffect(() => {
    const onResize = (): void => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  return size
}

/** The root screen. */
export function App({ controller, hostLabel }: AppProps): React.ReactElement {
  const state = useAppState(controller)
  const { exit } = useApp()
  const { columns, rows } = useTerminalSize()
  const [buffer, setBuffer] = useState<Buffer>(emptyBuffer())
  const [field, setField] = useState<Buffer>(emptyBuffer())
  const [listCursor, setListCursor] = useState(0)
  const [scroll, setScroll] = useState(0)
  const [lastQuery, setLastQuery] = useState('')
  const [panelCursor, setPanelCursor] = useState(0)
  const [pendingPreset, setPendingPreset] = useState<string | undefined>(undefined)
  const [editingItem, setEditingItem] = useState<string | undefined>(undefined)
  const [effortIndex, setEffortIndex] = useState(0)
  const runningNow = state.transcript.running

  // A finished turn may have changed the queue or the goal: refresh the panel once.
  const [wasRunning, setWasRunning] = useState(runningNow)
  if (wasRunning !== runningNow) {
    setWasRunning(runningNow)
    if (!runningNow && state.overlay === 'panel' && state.panel.section === 'queue') void controller.loadSection('queue')
  }

  const layoutRule = pickLayout(columns)
  const activeSession = state.sessions.find(item => item.sessionId === state.activeId)
  const running = state.transcript.running
  const now = Date.now()

  const transcript = useMemo(
    () => transcriptLines(state.transcript.items, Math.max(10, layoutRule.mainWidth - 2)),
    [state.transcript.items, layoutRule.mainWidth],
  )

  const composerLines = Math.min(4, Math.max(1, layout(buffer).lines.length))
  const hintLines = packHints(HINTS, Math.max(10, columns - 2))
  const model = activeSession?.model ?? (state.defaultChoice !== undefined ? `${state.defaultChoice.provider}/${state.defaultChoice.model}` : 'sin modelo')
  const headerTitleLines = wrapText(titleOf(activeSession), Math.max(10, columns - 2))
  const modelLines = wrapText(`modelo ${model}`, Math.max(10, columns - 2))
  const headerRows = 1 + headerTitleLines.length + modelLines.length
  const errorLines = state.error !== undefined ? wrapText(`⚠ ${state.error}`, Math.max(10, columns - 2)) : []
  const bodyHeight = bodyHeightOf(rows, {
    composer: composerLines,
    footer: hintLines.length,
    error: errorLines.length,
    header: headerRows,
  })

  useInput((input, key) => {
    const overlay: Overlay = state.overlay
    if (key.ctrl && input === 'q') {
      controller.dispose()
      exit()
      return
    }
    if (key.ctrl && input === 'c') {
      if (running) void controller.cancel()
      return
    }
    if (key.escape) {
      if (overlay === 'panel' && (editingItem !== undefined || pendingPreset !== undefined)) {
        setEditingItem(undefined)
        setPendingPreset(undefined)
        setField(emptyBuffer())
        return
      }
      if (overlay !== 'none') controller.setOverlay('none')
      else if (running) void controller.cancel()
      return
    }
    if (key.ctrl && input === 'n') {
      void controller.newSession()
      setScroll(0)
      return
    }
    if (key.ctrl && input === 'k') {
      setListCursor(Math.max(0, state.sessions.findIndex(item => item.sessionId === state.activeId)))
      controller.setOverlay(overlay === 'sessions' ? 'none' : 'sessions')
      return
    }
    if (key.ctrl && input === 't') {
      if (overlay === 'panel') {
        controller.setOverlay('none')
        return
      }
      setPanelCursor(0)
      setPendingPreset(undefined)
      setEditingItem(undefined)
      setField(emptyBuffer())
      void controller.openPanel('queue')
      return
    }
    if (key.ctrl && input === 'o') {
      setEffortIndex(0)
      void controller.openModels()
      return
    }
    if (key.ctrl && input === 'g') {
      setField(emptyBuffer())
      void controller.openKeys()
      return
    }
    if (key.ctrl && input === 'f') {
      setField(emptyBuffer())
      setListCursor(0)
      controller.setOverlay('search')
      return
    }
    if (key.ctrl && input === 'r') {
      if (state.activeId === undefined) return
      setField(bufferOf(titleOf(activeSession)))
      controller.setOverlay('rename')
      return
    }
    if (key.ctrl && input === 'b') {
      void controller.fork()
      return
    }
    if (key.ctrl && input === 'p') {
      controller.setOverlay(overlay === 'help' ? 'none' : 'help')
      return
    }

    if (overlay === 'help') {
      controller.setOverlay('none')
      return
    }

    if (overlay === 'sessions') {
      if (key.upArrow) setListCursor(index => Math.max(0, index - 1))
      else if (key.downArrow) setListCursor(index => Math.min(state.sessions.length - 1, index + 1))
      else if (key.return) {
        const target = state.sessions[listCursor]
        if (target !== undefined) void controller.open(target.sessionId)
      }
      return
    }

    if (overlay === 'models') {
      const choice = state.models[state.modelCursor]
      const efforts = choice?.reasoningEfforts ?? []
      if (key.upArrow) {
        controller.moveModel(-1)
        setEffortIndex(0)
      } else if (key.downArrow) {
        controller.moveModel(1)
        setEffortIndex(0)
      } else if (key.tab && efforts.length > 0) {
        setEffortIndex(index => (index + 1) % efforts.length)
      } else if (key.return) {
        void controller.chooseModel(efforts.length > 0 ? efforts[effortIndex % efforts.length] : undefined)
      }
      return
    }

    if (overlay === 'panel') {
      handlePanelKey({
        input,
        key,
        state,
        controller,
        field,
        setField,
        cursor: panelCursor,
        setCursor: setPanelCursor,
        pendingPreset,
        setPendingPreset,
        editingItem,
        setEditingItem,
      })
      return
    }

    if (overlay === 'keys') {
      if (key.upArrow) controller.moveKey(-1)
      else if (key.downArrow || key.tab) controller.moveKey(1)
      else if (key.return) {
        const value = textOf(field)
        setField(emptyBuffer())
        void controller.saveKey(value)
      } else if (key.ctrl && input === 'd') void controller.clearKey()
      else setField(editField(field, input, key))
      return
    }

    if (overlay === 'rename') {
      if (key.return) {
        const title = textOf(field)
        void controller.rename(title)
      } else setField(editField(field, input, key))
      return
    }

    if (overlay === 'search') {
      const query = textOf(field)
      if (key.return) {
        if (state.searchResults.length > 0 && query === lastQuery) {
          const target = state.searchResults[listCursor]
          if (target !== undefined) void controller.openFromList(target.sessionId)
        } else {
          setLastQuery(query)
          setListCursor(0)
          void controller.search(query)
        }
      } else if (key.upArrow) setListCursor(index => Math.max(0, index - 1))
      else if (key.downArrow) setListCursor(index => Math.min(state.searchResults.length - 1, index + 1))
      else setField(editField(field, input, key))
      return
    }

    // The conversation overlay is closed: the composer and the scroll keys are live.
    if (key.pageUp) {
      setScroll(value => value + Math.max(3, Math.floor(bodyHeight / 2)))
      return
    }
    if (key.pageDown) {
      setScroll(value => Math.max(0, value - Math.max(3, Math.floor(bodyHeight / 2))))
      return
    }
    if (key.return) {
      if (key.meta || input === '\n') {
        setBuffer(current => insert(current, '\n'))
        return
      }
      const text = textOf(buffer)
      if (text.trim().length === 0) return
      setBuffer(clear())
      setScroll(0)
      void controller.send(text)
      return
    }
    if (key.ctrl && input === 'j') {
      setBuffer(current => insert(current, '\n'))
      return
    }
    if (input === '?' && textOf(buffer).length === 0) {
      controller.setOverlay('help')
      return
    }
    setBuffer(current => editComposer(current, input, key))
  })

  const sidebarLines = (width: number): StyledLine[] => sessionRows(state.sessions, state.activeId, width, now).flatMap(row => row.lines)

  const status = running ? `${glyph.spinner[Math.floor(now / 120) % glyph.spinner.length]} trabajando` : `${glyph.idle} listo`

  const mainBody = renderOverlayOrConversation({
    state,
    field,
    listCursor,
    // The main box pads one cell on each side, so its text is two cells narrower than its box.
    width: layoutRule.mainWidth - 2,
    height: bodyHeight,
    transcript,
    scroll,
    now,
    activeSession,
    panelCursor,
    pendingPreset,
    editingItem,
    effortIndex,
  })

  return (
    <Box flexDirection="column" width={columns} height={rows - 1}>
      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        <Text>
          <Text color={palette.brand} bold>{glyph.brand} JinCode</Text>
          {' '.repeat(Math.max(1, columns - 2 - cellWidth(`${glyph.brand} JinCode`) - cellWidth(status)))}
          <Text color={running ? palette.success : palette.muted}>{status}</Text>
        </Text>
        {headerTitleLines.map((line, index) => (
          <Text key={`t${index}`} bold>{line}</Text>
        ))}
        {modelLines.map((line, index) => (
          <Text key={`m${index}`} color={palette.accent}>{line}</Text>
        ))}
      </Box>

      <Box flexDirection="row" height={bodyHeight} flexShrink={0}>
        {layoutRule.mode === 'wide' ? (
          <Box flexDirection="column" width={layoutRule.sidebarWidth} height={bodyHeight} flexShrink={0} borderStyle="single" borderColor={palette.border} borderRight borderTop={false} borderBottom={false} borderLeft={false} paddingX={1} overflow="hidden">
            <Text color={palette.muted} bold>SESIONES</Text>
            {wrapText(hostLabel, Math.max(8, layoutRule.sidebarWidth - 4)).map((line, index) => (
              <Text key={`h${index}`} color={palette.faint}>{line}</Text>
            ))}
            {sidebarView(sidebarLines(layoutRule.sidebarWidth - 4), bodyHeight - 1 - wrapText(hostLabel, Math.max(8, layoutRule.sidebarWidth - 4)).length).map((line, index) => (
              <Text key={index} color={toneColor[line.tone] || undefined} bold={line.bold}>{line.text}</Text>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column" width={layoutRule.mainWidth} height={bodyHeight} flexShrink={0} paddingX={1} overflow="hidden">
          {mainBody}
        </Box>
      </Box>

      <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={running ? palette.borderActive : palette.border} paddingX={1}>
        {composerView(buffer, composerLines, layoutRule.mainWidth - 4)}
      </Box>
      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        {hintLines.map((line, index) => (
          <Text key={index} color={palette.faint}>{line}</Text>
        ))}
      </Box>
      {errorLines.length > 0 ? (
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          {errorLines.map((line, index) => (
            <Text key={index} color={palette.error}>{line}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

interface MainArgs {
  state: AppState
  field: Buffer
  listCursor: number
  width: number
  height: number
  transcript: StyledLine[]
  scroll: number
  now: number
  activeSession: AppState['sessions'][number] | undefined
  panelCursor: number
  pendingPreset: string | undefined
  editingItem: string | undefined
  effortIndex: number
}

function renderOverlayOrConversation(args: MainArgs): React.ReactElement {
  const { state } = args
  const noticeLines = state.notice !== undefined && state.overlay === 'none' ? wrapText(state.notice, args.width) : []
  const inner = { ...args, height: Math.max(1, args.height - noticeLines.length) }
  const body = (() => {
    switch (state.overlay) {
      case 'sessions': return sessionsOverlay(inner)
      case 'models': return modelsOverlay(inner)
      case 'keys': return keysOverlay(inner)
      case 'rename': return renameOverlay(inner)
      case 'search': return searchOverlay(inner)
      case 'help': return helpOverlay(inner.width)
      case 'panel': return <Panel state={state} width={inner.width} height={inner.height} cursor={inner.panelCursor} field={inner.field} editing={inner.editingItem} pendingPreset={inner.pendingPreset} />
      default: return conversation(inner)
    }
  })()
  return (
    <Box flexDirection="column" height={args.height} flexShrink={0} overflow="hidden">
      {noticeLines.map((line, index) => (
        <Text key={index} color={palette.success}>{line}</Text>
      ))}
      {body}
    </Box>
  )
}

function conversation({ transcript, height, scroll, width, state }: MainArgs): React.ReactElement {
  if (state.transcript.items.length === 0) {
    const hints = [
      'Escribe un mensaje abajo y pulsa Enter.',
      'Ctrl+O elige el modelo. Ctrl+G guarda la clave del proveedor.',
      'Ctrl+K cambia de sesión. Ctrl+N crea una nueva.',
      '? muestra todas las teclas.',
    ]
    const lines: StyledLine[] = [{ text: `${glyph.brand} JinCode`, tone: 'brand', bold: true }, { text: '', tone: 'text' }]
    for (const hint of hints) for (const line of wrapText(hint, width)) lines.push({ text: line, tone: 'muted' })
    return <Lines lines={lines} />
  }
  const maxScroll = Math.max(0, transcript.length - height)
  const offset = Math.min(scroll, maxScroll)
  const end = transcript.length - offset
  const start = Math.max(0, end - height)
  const visible = transcript.slice(start, end)
  return (
    <Box flexDirection="column">
      <Lines lines={visible} />
      {offset > 0 ? <Text color={palette.faint}>{rule(`↓ ${offset} líneas abajo · PgDn`, width)}</Text> : null}
    </Box>
  )
}

function sessionsOverlay({ state, listCursor, width, height, now }: MainArgs): React.ReactElement {
  const rows = sessionRows(state.sessions, state.activeId, width - 2, now)
  const lines: StyledLine[] = [{ text: 'Sesiones', tone: 'brand', bold: true }, { text: 'Enter abre · Esc cierra', tone: 'faint' }]
  rows.forEach((row, index) => {
    const cursor = index === listCursor
    row.lines.forEach((line, lineIndex) => {
      lines.push({ ...line, text: lineIndex === 0 && cursor ? `›${line.text.slice(1)}` : line.text, bold: cursor || line.bold })
    })
  })
  if (rows.length === 0) lines.push({ text: 'No hay sesiones. Ctrl+N crea una.', tone: 'muted' })
  return <Lines lines={lines.slice(0, height)} />
}

function modelsOverlay({ state, width, height, activeSession, effortIndex }: MainArgs): React.ReactElement {
  const lines: StyledLine[] = [
    { text: 'Modelos', tone: 'brand', bold: true },
    { text: 'Elige el modelo de la sesión · Tab cambia el razonamiento · Enter confirma · Esc cierra', tone: 'faint' },
  ]
  const current = activeSession?.model
  let previous = ''
  state.models.forEach((choice, index) => {
    if (choice.provider !== previous) {
      lines.push({ text: choice.providerName ?? choice.provider, tone: 'accent', bold: true })
      previous = choice.provider
    }
    const cursor = index === state.modelCursor
    const mark = `${current === `${choice.provider}/${choice.model}` ? '✓' : ' '}`
    const label = `${mark} ${cursor ? '›' : ' '} ${choice.name ?? choice.model}`
    for (const line of wrapText(label, width)) lines.push({ text: line, tone: cursor ? 'brand' : 'text', bold: cursor })
    if (cursor && choice.reasoningEfforts !== undefined && choice.reasoningEfforts.length > 0) {
      const efforts = choice.reasoningEfforts
      const chosen = efforts[effortIndex % efforts.length]
      const shown = efforts.map(effort => (effort === chosen ? `[${effort}]` : effort)).join(' ')
      for (const line of wrapText(`    razonamiento: ${shown} · Tab cambia`, width)) lines.push({ text: line, tone: 'muted' })
    }
  })
  if (state.models.length === 0) {
    for (const line of wrapText('No hay modelos disponibles. Guarde una clave con Ctrl+G y vuelva a abrir esta lista.', width)) lines.push({ text: line, tone: 'warning' })
  }
  return <Lines lines={lines.slice(0, height)} />
}

function keysOverlay({ state, field, width, height }: MainArgs): React.ReactElement {
  const lines: StyledLine[] = [
    { text: 'Claves de proveedor', tone: 'brand', bold: true },
    { text: 'Tab cambia de proveedor · Enter guarda · Ctrl+D elimina · Esc cierra', tone: 'faint' },
  ]
  state.providers.forEach((provider, index) => {
    const cursor = index === state.keyCursor
    const status = provider.configured ? '● clave guardada' : '○ sin clave'
    for (const line of wrapText(`${cursor ? '›' : ' '} ${provider.name} · ${status}`, width)) {
      lines.push({ text: line, tone: provider.configured ? 'success' : cursor ? 'brand' : 'muted', bold: cursor })
    }
  })
  const masked = maskSecret(textOf(field))
  lines.push({ text: '', tone: 'text' })
  for (const line of wrapText('Clave (no se muestra):', width)) lines.push({ text: line, tone: 'muted' })
  for (const line of wrapText(masked.length > 0 ? masked : '…escriba o pegue la clave', width)) {
    lines.push({ text: line, tone: masked.length > 0 ? 'text' : 'faint' })
  }
  return <Lines lines={lines.slice(0, height)} />
}

function renameOverlay({ field, width, height }: MainArgs): React.ReactElement {
  const lines: StyledLine[] = [
    { text: 'Renombrar sesión', tone: 'brand', bold: true },
    { text: 'Enter guarda · Esc cancela', tone: 'faint' },
  ]
  for (const line of wrapText(`${textOf(field)}▌`, width)) lines.push({ text: line, tone: 'text' })
  return <Lines lines={lines.slice(0, height)} />
}

function searchOverlay({ state, field, listCursor, width, height }: MainArgs): React.ReactElement {
  const lines: StyledLine[] = [
    { text: 'Buscar en sesiones', tone: 'brand', bold: true },
    { text: 'Enter busca; con resultados, Enter abre el seleccionado · Esc cierra', tone: 'faint' },
  ]
  for (const line of wrapText(`${textOf(field)}▌`, width)) lines.push({ text: line, tone: 'text' })
  if (state.searchNote !== undefined) for (const line of wrapText(state.searchNote, width)) lines.push({ text: line, tone: 'warning' })
  state.searchResults.forEach((result, index) => {
    const cursor = index === listCursor
    const title = state.sessions.find(item => item.sessionId === result.sessionId)?.title ?? result.sessionId
    lines.push({ text: `${cursor ? '›' : ' '} ${title}`, tone: cursor ? 'brand' : 'text', bold: cursor })
    for (const line of wrapText(`   ${result.snippet}`, width)) lines.push({ text: line, tone: 'muted' })
  })
  if (state.searchResults.length === 0 && textOf(field).length > 0 && state.searchNote === undefined) lines.push({ text: 'Sin resultados.', tone: 'muted' })
  return <Lines lines={lines.slice(0, height)} />
}

function helpOverlay(width: number): React.ReactElement {
  const entries: Array<[string, string]> = [
    ['Enter', 'enviar (durante un turno, dirige el turno)'],
    ['Alt+Enter · Ctrl+J', 'nueva línea en el mensaje'],
    ['Ctrl+N', 'nueva sesión'],
    ['Ctrl+K', 'lista de sesiones'],
    ['Ctrl+O', 'elegir modelo y razonamiento de la sesión'],
    ['Ctrl+T', 'panel: cola, permisos, ajustes, metas, programaciones, habilidades'],
    ['Ctrl+G', 'claves de los proveedores'],
    ['Ctrl+F', 'buscar en las sesiones'],
    ['Ctrl+R', 'renombrar la sesión'],
    ['Ctrl+B', 'bifurcar la sesión'],
    ['Esc · Ctrl+C', 'cancelar el turno en curso'],
    ['PgUp · PgDn', 'desplazar la conversación'],
    ['Ctrl+P · ?', 'esta ayuda'],
    ['Ctrl+Q', 'salir (la sesión sigue en el Host)'],
  ]
  const lines: StyledLine[] = [{ text: 'Teclas', tone: 'brand', bold: true }]
  for (const [keys, action] of entries) {
    const head = `${keys}`
    const tail = wrapText(action, Math.max(8, width - cellWidth(head) - 3))
    tail.forEach((line, index) => {
      lines.push({ text: index === 0 ? `${head.padEnd(Math.min(20, cellWidth(head) + 1))} ${line}` : `${' '.repeat(Math.min(20, cellWidth(head) + 1) + 1)}${line}`, tone: index === 0 ? 'text' : 'muted' })
    })
  }
  return <Lines lines={lines} />
}

function Lines({ lines }: { lines: readonly StyledLine[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color={toneColor[line.tone] || undefined} bold={line.bold} italic={line.italic}>
          {line.text.length === 0 ? ' ' : line.text}
        </Text>
      ))}
    </Box>
  )
}

function composerView(buffer: Buffer, lines: number, width: number): React.ReactElement {
  if (buffer.chars.length === 0) {
    return (
      <Text>
        <Text color={palette.brand}>{glyph.prompt}</Text>
        <Text inverse color={palette.brand}> </Text>
        <Text color={palette.faint}> Escribe un mensaje…</Text>
      </Text>
    )
  }
  const { lines: text, row, column } = layout(buffer)
  const start = Math.max(0, Math.min(row - lines + 1, text.length - lines))
  const visible = text.slice(Math.max(0, start), Math.max(0, start) + lines)
  return (
    <Box flexDirection="column">
      {visible.map((line, index) => {
        const absolute = start + index
        if (absolute !== row) return <Text key={index} color={undefined}>{wrapText(line.length === 0 ? ' ' : line, width)[0] ?? ' '}</Text>
        const chars = Array.from(line)
        const before = chars.slice(0, column).join('')
        const under = chars[column] ?? ' '
        const after = chars.slice(column + 1).join('')
        return (
          <Text key={index}>
            {glyph.prompt} {before}
            <Text inverse color={palette.brand}>{under}</Text>
            {after}
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * Fit the sidebar rows to the height. Rows that do not fit are counted in a
 * final line rather than cut mid-title.
 * @param lines - all sidebar lines.
 * @param height - rows available.
 * @returns the lines to draw.
 */
function sidebarView(lines: readonly StyledLine[], height: number): StyledLine[] {
  if (lines.length <= height) return [...lines]
  const kept = lines.slice(0, Math.max(0, height - 1))
  const hidden = lines.length - kept.length
  return [...kept, { text: `… ${hidden} más · Ctrl+K`, tone: 'faint' }]
}

/** Apply one key to the composer buffer. */
function editComposer(buffer: Buffer, input: string, key: KeyLike): Buffer {
  if (isErase(key, input)) return eraseBack(buffer, input)
  if (key.leftArrow) return left(buffer)
  if (key.rightArrow) return right(buffer)
  if (key.upArrow) return up(buffer)
  if (key.downArrow) return down(buffer)
  if (key.ctrl && input === 'a') return home(buffer)
  if (key.ctrl && input === 'e') return end(buffer)
  if (key.ctrl || key.meta || key.tab || key.escape) return buffer
  return insert(buffer, input)
}

/**
 * Rows left for the body after the fixed regions: the header rows, the footer
 * hints, the composer box and any error lines.
 * @param rows - terminal height.
 * @param used - rows each variable region needs.
 * @returns rows for the body, at least three.
 */
export function bodyHeightOf(rows: number, used: { composer: number; footer: number; error: number; header: number }): number {
  const composerBox = used.composer + 2
  return Math.max(3, rows - 1 - used.header - composerBox - used.footer - used.error)
}
