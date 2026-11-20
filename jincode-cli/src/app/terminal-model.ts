/**
 * Pure model of the user's terminals: the Host's shapes, the attachment frames,
 * the input budget that keeps keystrokes from overrunning the Host, and the
 * bytes a key press sends. The controller and the screen use it; it does no I/O.
 */

/** A shell the Host can start, from `terminal/shells`. */
export interface ShellView {
  readonly path: string
  readonly args: readonly string[]
  readonly name: string
}

/** One retained terminal, from `terminal/list` and the `terminal/watch` sets. */
export interface TerminalInfo {
  readonly id: string
  readonly title: string
  readonly shell: ShellView
  /** Initial working directory; a `cd` in the shell does not update it. */
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: 'running' | 'failed' | 'exited'
  readonly exitCode: number | undefined
  readonly error: string | undefined
  readonly origin: 'user' | 'agent'
  readonly control: 'user' | 'agent'
  /** Sandbox an agent terminal started under; user terminals omit it. */
  readonly sandboxMode: string | undefined
}

/** Limits of the Session's terminals, from `terminal/environment`. */
export interface TerminalEnvironment {
  readonly cwd: string
  readonly maxInputBytes: number
  readonly maxBufferedBytes: number
  readonly maxCols: number
  readonly maxRows: number
  readonly scrollback: number
}

/** The carrier's inbox for input: frames up to `maxBytes` may wait for the Host at once. */
export interface InputWindow {
  readonly maxBytes: number
  readonly frameOverheadBytes: number
}

/** One input command the client sends on an attachment. */
export type TerminalCommand =
  | { readonly type: 'write'; readonly sequence: number; readonly data: string; readonly typed?: boolean }
  | { readonly type: 'resize'; readonly sequence: number; readonly cols: number; readonly rows: number }

/** One frame the Host sends on an attachment. Unknown types are skipped. */
export type TerminalFrame =
  | { readonly type: 'snapshot'; readonly sequence: number; readonly screen: string; readonly info: TerminalInfo; readonly writable: boolean; readonly inputWindow: InputWindow | undefined }
  | { readonly type: 'output'; readonly sequence: number; readonly data: string }
  | { readonly type: 'state'; readonly info: TerminalInfo; readonly writable: boolean }
  | { readonly type: 'ack'; readonly sequence: number; readonly refusal: 'read-only' | 'not-running' | undefined }

/** Why a terminal action failed, in words the panel can show. */
export type TerminalIssue = 'inputFull' | 'invalidOutput' | 'readOnly' | 'notRunning'

const ISSUE_TEXT: Record<TerminalIssue, string> = {
  inputFull: 'El búfer de entrada está lleno. Espera un momento y vuelve a escribir.',
  invalidOutput: 'La salida de la terminal llegó desordenada. Vuelve a conectar para recuperarla.',
  readOnly: 'Esta vista es de solo lectura.',
  notRunning: 'La terminal ya no está en ejecución.',
}

/**
 * What a terminal's state says in words: its process ended, failed, or is running.
 * @param info - the terminal.
 * @returns the text, or undefined while the process runs.
 */
export function stateText(info: Pick<TerminalInfo, 'state' | 'exitCode' | 'error'>): string | undefined {
  if (info.state === 'exited') return `terminó (código ${info.exitCode ?? '?'})`
  if (info.state === 'failed') return `error: ${info.error ?? 'desconocido'}`
  return undefined
}

/**
 * The words for a terminal issue.
 * @param issue - the failure.
 * @returns the Spanish text.
 */
export function issueText(issue: TerminalIssue): string {
  return ISSUE_TEXT[issue]
}

/** Thrown by the input queue; the controller shows its text. */
export class TerminalError extends Error {
  constructor(readonly issue: TerminalIssue) {
    super(ISSUE_TEXT[issue])
    this.name = 'TerminalError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Read one shell.
 * @param value - an entry of `terminal/shells`.
 * @returns the shell, or undefined when the entry is malformed.
 */
export function normalizeShell(value: unknown): ShellView | undefined {
  if (!isRecord(value) || typeof value['path'] !== 'string' || typeof value['name'] !== 'string') return undefined
  const args = Array.isArray(value['args']) ? value['args'].filter((arg): arg is string => typeof arg === 'string') : []
  return { path: value['path'], name: value['name'], args }
}

/**
 * Read the shells the Host can start.
 * @param value - the `terminal/shells` result.
 * @returns the usable shells, in the Host's order.
 */
export function normalizeShells(value: unknown): ShellView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const shell = normalizeShell(item)
    return shell === undefined ? [] : [shell]
  })
}

/**
 * Read one terminal.
 * @param value - a `terminal/list` entry or a watch set member.
 * @returns the terminal, or undefined when a required field is missing.
 */
export function normalizeInfo(value: unknown): TerminalInfo | undefined {
  if (!isRecord(value)) return undefined
  const shell = normalizeShell(value['shell'])
  const state = value['state']
  const origin = value['origin']
  const control = value['control']
  if (typeof value['id'] !== 'string' || shell === undefined || typeof value['cwd'] !== 'string') return undefined
  if (state !== 'running' && state !== 'failed' && state !== 'exited') return undefined
  if (origin !== 'user' && origin !== 'agent') return undefined
  if (control !== 'user' && control !== 'agent') return undefined
  if (!isFiniteNumber(value['cols']) || !isFiniteNumber(value['rows'])) return undefined
  return {
    id: value['id'],
    title: typeof value['title'] === 'string' ? value['title'] : '',
    shell,
    cwd: value['cwd'],
    cols: value['cols'],
    rows: value['rows'],
    state,
    exitCode: isFiniteNumber(value['exitCode']) ? value['exitCode'] : undefined,
    error: typeof value['error'] === 'string' ? value['error'] : undefined,
    origin,
    control,
    sandboxMode: typeof value['sandboxMode'] === 'string' ? value['sandboxMode'] : undefined,
  }
}

/**
 * Read a list of terminals; malformed entries are dropped.
 * @param value - a `terminal/list` result or a watch set.
 * @returns the terminals in the Host's order.
 */
export function normalizeInfos(value: unknown): TerminalInfo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const info = normalizeInfo(item)
    return info === undefined ? [] : [info]
  })
}

/**
 * Read the limits of the Session's terminals.
 * @param value - the `terminal/environment` result.
 * @returns the limits, or undefined when a limit is missing.
 */
export function normalizeEnvironment(value: unknown): TerminalEnvironment | undefined {
  if (!isRecord(value) || typeof value['cwd'] !== 'string') return undefined
  const numbers = ['maxInputBytes', 'maxBufferedBytes', 'maxCols', 'maxRows', 'scrollback'] as const
  if (!numbers.every(key => isFiniteNumber(value[key]))) return undefined
  return {
    cwd: value['cwd'],
    maxInputBytes: value['maxInputBytes'] as number,
    maxBufferedBytes: value['maxBufferedBytes'] as number,
    maxCols: value['maxCols'] as number,
    maxRows: value['maxRows'] as number,
    scrollback: value['scrollback'] as number,
  }
}

/**
 * Read one attachment frame.
 * @param value - one item of the `terminal/attach` stream.
 * @returns the frame, or undefined for an unknown type; a known type with a bad shape throws.
 */
export function parseTerminalFrame(value: unknown): TerminalFrame | undefined {
  if (!isRecord(value)) throw new TerminalError('invalidOutput')
  const type = value['type']
  if (type === 'snapshot') {
    const info = normalizeInfo(value['info'])
    if (!isFiniteNumber(value['sequence']) || typeof value['screen'] !== 'string' || info === undefined || typeof value['writable'] !== 'boolean') throw new TerminalError('invalidOutput')
    const window = isRecord(value['inputWindow']) ? value['inputWindow'] : undefined
    const inputWindow = window !== undefined && isFiniteNumber(window['maxBytes']) && isFiniteNumber(window['frameOverheadBytes'])
      ? { maxBytes: window['maxBytes'], frameOverheadBytes: window['frameOverheadBytes'] }
      : undefined
    return { type, sequence: value['sequence'], screen: value['screen'], info, writable: value['writable'], inputWindow }
  }
  if (type === 'output') {
    if (!isFiniteNumber(value['sequence']) || typeof value['data'] !== 'string') throw new TerminalError('invalidOutput')
    return { type, sequence: value['sequence'], data: value['data'] }
  }
  if (type === 'state') {
    const info = normalizeInfo(value['info'])
    if (info === undefined || typeof value['writable'] !== 'boolean') throw new TerminalError('invalidOutput')
    return { type, info, writable: value['writable'] }
  }
  if (type === 'ack') {
    if (!isFiniteNumber(value['sequence'])) throw new TerminalError('invalidOutput')
    const refusal = value['refusal'] === 'read-only' || value['refusal'] === 'not-running' ? value['refusal'] : undefined
    return { type, sequence: value['sequence'], refusal }
  }
  return undefined
}

/** Bytes of one command as the carrier frames it: a compact JSON item plus the envelope. */
export function frameBytesOf(command: TerminalCommand, window: InputWindow): number {
  return window.frameOverheadBytes + Buffer.byteLength(JSON.stringify(command), 'utf8')
}

/** Keeps input inside the Host's budgets: a window of frames in flight, a cap on bytes waiting, acknowledgements in order. */
export class TerminalInputQueue {
  private sequence = 0
  private acknowledged = 0
  private readonly inFlight = new Map<number, { readonly rawBytes: number; readonly frameBytes: number }>()
  private inFlightFrames = 0
  private queued: Array<{ readonly command: TerminalCommand; readonly rawBytes: number; readonly frameBytes: number }> = []
  private queuedFrames = 0
  private rawBytes = 0

  /**
   * @param limits - the Session's input limits.
   * @param window - the carrier's inbox for this attachment; undefined when it has no limit.
   * @param emit - sends one command on the attachment.
   */
  constructor(
    private readonly limits: Pick<TerminalEnvironment, 'maxInputBytes' | 'maxBufferedBytes'>,
    private window: InputWindow | undefined,
    private readonly emit: (command: TerminalCommand) => void,
  ) {}

  /**
   * Queue keystrokes or pasted text.
   * @param data - the bytes to type.
   * @param typed - whether the person typed them, as opposed to a terminal reply.
   * @throws {TerminalError} inputFull when the raw or the framed budget would be exceeded.
   */
  write(data: string, typed = true): void {
    const rawBytes = Buffer.byteLength(data, 'utf8')
    if (this.rawBytes + rawBytes > this.limits.maxInputBytes) throw new TerminalError('inputFull')
    this.submit({ type: 'write', sequence: this.sequence + 1, data, ...(typed ? { typed: true } : {}) }, rawBytes)
  }

  /**
   * Queue a resize of the Host terminal.
   * @param cols - columns.
   * @param rows - rows.
   */
  resize(cols: number, rows: number): void {
    this.submit({ type: 'resize', sequence: this.sequence + 1, cols, rows }, 0)
  }

  /**
   * Account for one acknowledgement. Acknowledgements arrive in order.
   * @param sequence - the acknowledged command.
   * @param refusal - why the Host did not apply it, if it did not.
   * @returns the refusal, if any.
   * @throws {TerminalError} invalidOutput when the acknowledgement is out of order.
   */
  ack(sequence: number, refusal: 'read-only' | 'not-running' | undefined): 'read-only' | 'not-running' | undefined {
    if (sequence !== this.acknowledged + 1) throw new TerminalError('invalidOutput')
    const pending = this.inFlight.get(sequence)
    this.acknowledged = sequence
    if (pending !== undefined) {
      this.inFlight.delete(sequence)
      this.inFlightFrames -= pending.frameBytes
      this.rawBytes -= pending.rawBytes
    }
    this.flush()
    return refusal
  }

  /**
   * Use a new window after the attachment reconnects or the Host sends a new snapshot.
   * @param window - the inbox of the new attachment.
   */
  reset(window: InputWindow | undefined): void {
    this.window = window
    this.sequence = 0
    this.acknowledged = 0
    this.inFlight.clear()
    this.inFlightFrames = 0
    this.queued = []
    this.queuedFrames = 0
    this.rawBytes = 0
  }

  /** @returns the bytes accepted and not yet acknowledged, for the panel and the tests. */
  pendingRawBytes(): number {
    return this.rawBytes
  }

  private submit(command: TerminalCommand & { readonly sequence: number }, rawBytes: number): void {
    const frameBytes = this.window === undefined ? 0 : frameBytesOf(command, this.window)
    if (this.window !== undefined && this.queuedFrames + frameBytes > this.limits.maxBufferedBytes) throw new TerminalError('inputFull')
    this.sequence = command.sequence
    this.rawBytes += rawBytes
    if (this.canSend(frameBytes) && this.queued.length === 0) this.transmit(command, rawBytes, frameBytes)
    else {
      this.queued.push({ command, rawBytes, frameBytes })
      this.queuedFrames += frameBytes
    }
  }

  private canSend(frameBytes: number): boolean {
    return this.window === undefined || this.inFlightFrames + frameBytes <= this.window.maxBytes
  }

  private transmit(command: TerminalCommand, rawBytes: number, frameBytes: number): void {
    this.inFlight.set(command.sequence, { rawBytes, frameBytes })
    this.inFlightFrames += frameBytes
    this.emit(command)
  }

  private flush(): void {
    while (this.queued.length > 0) {
      const next = this.queued[0]!
      if (!this.canSend(next.frameBytes)) return
      this.queued.shift()
      this.queuedFrames -= next.frameBytes
      this.transmit(next.command, next.rawBytes, next.frameBytes)
    }
  }
}

/** The keys a terminal screen receives, as Ink reports them. */
export interface TerminalKey {
  readonly return?: boolean
  readonly escape?: boolean
  readonly tab?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly leftArrow?: boolean
  readonly rightArrow?: boolean
  readonly pageUp?: boolean
  readonly pageDown?: boolean
  readonly home?: boolean
  readonly end?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
}

/**
 * The bytes a key press sends to the shell, in the xterm encoding.
 * @param input - the text Ink reports for the key.
 * @param key - the key flags Ink reports.
 * @param applicationCursor - whether the program asked for application cursor keys.
 * @returns the bytes, or undefined when the key sends nothing.
 */
export function keyBytes(input: string, key: TerminalKey, applicationCursor = false): string | undefined {
  const arrow = (letter: string): string => (applicationCursor ? `\x1bO${letter}` : `\x1b[${letter}`)
  if (key.return) return '\r'
  if (key.backspace) return '\x7f'
  if (key.delete) return '\x1b[3~'
  if (key.tab) return key.shift === true ? '\x1b[Z' : '\t'
  if (key.escape) return '\x1b'
  if (key.upArrow) return arrow('A')
  if (key.downArrow) return arrow('B')
  if (key.rightArrow) return arrow('C')
  if (key.leftArrow) return arrow('D')
  if (key.pageUp) return '\x1b[5~'
  if (key.pageDown) return '\x1b[6~'
  if (key.home) return applicationCursor ? '\x1bOH' : '\x1b[H'
  if (key.end) return applicationCursor ? '\x1bOF' : '\x1b[F'
  if (input.length === 0) return undefined
  if (key.ctrl === true) {
    const code = input.charCodeAt(0)
    // Ctrl+letter and the few punctuation keys that map onto C0 controls.
    if (input.length === 1 && code >= 0x40 && code <= 0x7f) return String.fromCharCode(code & 0x1f)
    if (input === ' ') return '\x00'
    return undefined
  }
  // Ink already reports Alt+x as ESC x; a bare letter with the meta flag gets the ESC prefix here.
  if (key.meta === true) return input.startsWith('\x1b') ? input : `\x1b${input}`
  return input
}
