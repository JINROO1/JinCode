import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScreenBuffer, paletteHex, plainText } from '../src/app/terminal-screen.ts'

test('screen: output is drawn as text, colors and styles, grouped into runs', async () => {
  const screen = new ScreenBuffer(20, 3)
  await screen.write('ok \x1b[31mred\x1b[0m \x1b[1;4mbold\x1b[0m')
  const [first] = screen.lines(false)
  assert.equal(plainText(first!), 'ok red bold' + ' '.repeat(9))
  const red = first!.find(run => run.text === 'red')
  assert.equal(red?.style.fg, paletteHex(1), 'SGR 31 is the palette red')
  const bold = first!.find(run => run.text === 'bold')
  assert.equal(bold?.style.bold, true)
  assert.equal(bold?.style.underline, true)
  assert.equal(first![0]?.style.fg, undefined, 'the default color is undefined')
  screen.dispose()
})

test('screen: the cursor cell is inverted and moves with the output', async () => {
  const screen = new ScreenBuffer(10, 2)
  await screen.write('ab')
  const line = screen.lines()[0]!
  const cursor = line.flatMap(run => (run.style.inverse ? [run.text] : []))
  assert.deepEqual(cursor, [' '], 'the cell after the text carries the cursor')
  assert.deepEqual(screen.cursor(), { x: 2, y: 0 })
  screen.dispose()
})

test('screen: a snapshot replaces what was on the screen, and a resize changes the viewport', async () => {
  const screen = new ScreenBuffer(10, 2)
  await screen.write('antes')
  await screen.reset('$ listo')
  assert.equal(plainText(screen.lines(false)[0]!).trimEnd(), '$ listo')
  screen.resize(30, 5)
  assert.deepEqual(screen.size(), { cols: 30, rows: 5 })
  assert.equal(screen.lines(false).length, 5)
  screen.dispose()
})

test('screen: palette colors past the base 16 follow the xterm cube and ramp', () => {
  assert.equal(paletteHex(16), '#000000')
  assert.equal(paletteHex(231), '#ffffff')
  assert.equal(paletteHex(232), '#080808')
})
