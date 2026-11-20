/**
 * The full-screen view of one attached terminal: a header that says what it
 * is, the emulated screen, and a line of hints. Keys are read by App.
 */
import React from 'react'
import { Box, Text } from 'ink'
import type { AppState } from '../app/controller.ts'
import type { ScreenLine } from '../app/terminal-screen.ts'
import { stateText } from '../app/terminal-model.ts'
import { palette } from './theme.ts'
import { cellWidth, truncate } from './layout.ts'

/** Rows the header and the hint lines take, besides the screen. */
export const TERMINAL_CHROME_ROWS = 4

interface TerminalScreenProps {
  readonly state: AppState
  readonly lines: readonly ScreenLine[]
  readonly columns: number
  readonly rows: number
}

export function TerminalScreen({ state, lines, columns, rows }: TerminalScreenProps): React.ReactElement {
  const view = state.terminal
  const info = view?.info
  const title = info === undefined ? '…' : info.title.length > 0 ? info.title : info.shell.name
  // The Host names a new terminal after its shell; the shell is shown only when the title says something else.
  const shell = info === undefined || info.shell.name === title ? '' : ` · ${info.shell.name}`
  const badges = [
    info?.origin === 'agent' ? 'agente' : undefined,
    info?.sandboxMode === undefined ? undefined : `sandbox ${info.sandboxMode}`,
    info === undefined ? undefined : stateText(info) ?? (view?.writable === false ? 'solo lectura' : undefined),
  ].filter((item): item is string => item !== undefined)
  const phase = view?.phase === 'connecting' ? 'conectando…' : view?.phase === 'disconnected' ? 'desconectada' : undefined
  const head = truncate(`▣ ${title}${shell}${info === undefined ? '' : ` · ${info.cwd}`}${badges.length > 0 ? ` · ${badges.join(' · ')}` : ''}${phase === undefined ? '' : ` · ${phase}`}`, Math.max(10, columns - 2))
  const hint = view?.phase === 'disconnected'
    ? 'Enter reconecta · Ctrl+] vuelve al panel'
    : 'Ctrl+] vuelve al panel · las teclas van a la shell'
  const screenRows = Math.max(1, rows - TERMINAL_CHROME_ROWS)
  const visible = lines.slice(0, screenRows)
  return (
    <Box flexDirection="column" width={columns} height={rows - 1}>
      <Box paddingX={1} flexShrink={0}>
        <Text color={palette.brand} bold>{head}</Text>
      </Box>
      <Box flexDirection="column" height={screenRows} paddingX={1} flexShrink={0} overflow="hidden">
        {visible.map((line, index) => (
          <Text key={index}>
            {line.length === 0 ? ' ' : line.map((run, runIndex) => (
              <Text
                key={runIndex}
                color={run.style.fg}
                backgroundColor={run.style.bg}
                bold={run.style.bold}
                italic={run.style.italic}
                underline={run.style.underline}
                inverse={run.style.inverse}
                dimColor={run.style.dim}
              >
                {run.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        {view?.notice !== undefined ? <Text color={palette.warning}>{truncate(view.notice, Math.max(10, columns - 2))}</Text> : <Text> </Text>}
        <Text color={palette.faint}>{truncate(hint, Math.max(10, columns - 2))}</Text>
      </Box>
    </Box>
  )
}

/** @returns the cell width of a header line, for tests. */
export function headWidth(line: string): number {
  return cellWidth(line)
}
