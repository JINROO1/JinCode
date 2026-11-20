/**
 * Wire calls of the terminals: discovery, create, rename, close, the roster
 * stream and the attachment. Streams share the one multiplexed socket.
 */
import { randomUUID } from 'node:crypto'
import { call, type RemoteConnection, type RemoteMux, type RemoteStream } from '../wire/remote.ts'
import {
  normalizeEnvironment, normalizeInfos, normalizeShells, type ShellView, type TerminalEnvironment, type TerminalInfo,
} from './terminal-model.ts'

export class TerminalClient {
  constructor(
    private readonly connection: RemoteConnection,
    private readonly mux: RemoteMux,
  ) {}

  /**
   * Discover the shells the Session's execution environment has.
   * @param sessionId - the Session.
   * @returns the shells.
   */
  async shells(sessionId: string): Promise<ShellView[]> {
    return normalizeShells(await call(this.connection, 'terminal/shells', { agentId: sessionId }))
  }

  /**
   * Read the Session's directory and the terminal limits.
   * @param sessionId - the Session.
   * @returns the limits, or undefined when the Host's answer is malformed.
   */
  async environment(sessionId: string): Promise<TerminalEnvironment | undefined> {
    return normalizeEnvironment(await call(this.connection, 'terminal/environment', { agentId: sessionId }))
  }

  /**
   * List the terminals the Session retains, including exited ones.
   * @param sessionId - the Session.
   * @returns the terminals.
   */
  async list(sessionId: string): Promise<TerminalInfo[]> {
    return normalizeInfos(await call(this.connection, 'terminal/list', { sessionId }))
  }

  /**
   * Start a user shell.
   * @param sessionId - the Session.
   * @param size - the window's size.
   * @param shellPath - a shell from `shells`; absent selects the execution default.
   * @returns the new terminal's identity.
   */
  async create(sessionId: string, size: { cols: number; rows: number }, shellPath?: string): Promise<string> {
    const id = randomUUID()
    await call(this.connection, 'terminal/create', {
      agentId: sessionId,
      request: { id, cols: size.cols, rows: size.rows, ...(shellPath === undefined ? {} : { shellPath }) },
    })
    return id
  }

  /**
   * Rename a terminal; the shell is unchanged.
   * @param sessionId - the Session.
   * @param id - the terminal.
   * @param title - the new title.
   */
  async rename(sessionId: string, id: string, title: string): Promise<void> {
    await call(this.connection, 'terminal/rename', { agentId: sessionId, id, title })
  }

  /**
   * Close a terminal and end its process. Repeated closes succeed.
   * @param sessionId - the Session.
   * @param id - the terminal.
   */
  async close(sessionId: string, id: string): Promise<void> {
    await call(this.connection, 'terminal/close', { agentId: sessionId, id })
  }

  /**
   * Stream the Session's retained terminals as whole sets.
   * @param sessionId - the Session.
   * @returns the stream; each item is a complete set.
   */
  watch(sessionId: string): RemoteStream<unknown> {
    return this.mux.open('terminal/watch', { sessionId })
  }

  /**
   * Hold a terminal for this window while it is shown. The first item confirms it.
   * @param sessionId - the Session.
   * @param id - the terminal.
   * @returns the stream; cancel it to release the hold.
   */
  retain(sessionId: string, id: string): RemoteStream<unknown> {
    return this.mux.open('terminal/retain', { sessionId, id })
  }

  /**
   * Attach input and output to one terminal. The first frame is a snapshot.
   * @param sessionId - the Session.
   * @param id - the terminal.
   * @returns the stream; send() writes commands, cancel() detaches.
   */
  attach(sessionId: string, id: string): RemoteStream<unknown> {
    return this.mux.open('terminal/attach', { agentId: sessionId, id })
  }
}
