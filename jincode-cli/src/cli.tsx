#!/usr/bin/env -S node --import tsx
/**
 * JinCode terminal client. It takes the access URL that the Host prints at
 * start-up (it carries the token), exchanges it for a session cookie, and
 * opens the full-screen interface over the Remote API.
 */
import React from 'react'
import { render } from 'ink'
import { App } from './ui/App.tsx'
import { AppController } from './app/controller.ts'
import { connect, parseAccessUrl, RemoteError } from './wire/remote.ts'

const VERSION = '0.1.0'

const USAGE = `JinCode ${VERSION} — cliente de terminal

Uso:
  jincode <url-de-acceso>
  JINCODE_URL=<url-de-acceso> jincode

La URL es la que imprime el servidor al arrancar (incluye el token).
En Termux: copie la línea «...: http://127.0.0.1:3080/?token=...» que imprime
\`bash termux/start.sh\` y páselo entre comillas:  bash termux/jincode.sh "http://...?token=..."

Opciones:
  -h, --help     muestra esta ayuda
  -v, --version  muestra la versión
`

/** Enter the alternate screen so the terminal's scrollback is left untouched. */
const ENTER_ALT = '\x1b[?1049h\x1b[2J\x1b[H'
const LEAVE_ALT = '\x1b[?1049l'

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (argv.includes('-v') || argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  const raw = argv.find(value => !value.startsWith('-')) ?? process.env['JINCODE_URL'] ?? ''
  const access = parseAccessUrl(raw)
  if (access === undefined) {
    process.stderr.write(`Falta la URL de acceso con el token.\n\n${USAGE}`)
    return 2
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('jincode necesita una terminal interactiva (TTY).\n')
    return 2
  }

  let connection
  try {
    connection = await connect(access.origin, access.token)
  } catch (error) {
    const message = error instanceof RemoteError && error.code === 'auth/rejected'
      ? 'El token fue rechazado. Copie la URL de acceso del servidor en marcha.'
      : `No se pudo conectar con ${access.origin}: ${error instanceof Error ? error.message : String(error)}`
    process.stderr.write(`${message}\n`)
    return 1
  }

  const controller = new AppController(connection)
  process.stdout.write(ENTER_ALT)
  const instance = render(<App controller={controller} hostLabel={access.origin} />, { exitOnCtrlC: false })
  void controller.start()
  try {
    await instance.waitUntilExit()
  } finally {
    controller.dispose()
    process.stdout.write(LEAVE_ALT)
  }
  return 0
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code
}, (error: unknown) => {
  process.stderr.write(`Error inesperado: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
