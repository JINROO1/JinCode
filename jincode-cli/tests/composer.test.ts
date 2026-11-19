import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backspace, bufferOf, clear, deleteForward, down, emptyBuffer, end, home, insert, layout, left, right, textOf, up } from '../src/ui/composer.ts'

test('insert adds text at the cursor and keeps newlines', () => {
  let buffer = insert(emptyBuffer(), 'hola')
  buffer = left(buffer)
  buffer = insert(buffer, ' mundo\r\nfin')
  assert.equal(textOf(buffer), 'hol mundo\nfina')
})

test('backspace and deleteForward respect the cursor and bounds', () => {
  const buffer = { chars: Array.from('abc'), cursor: 1 }
  assert.equal(textOf(backspace(buffer)), 'bc')
  assert.equal(textOf(deleteForward(buffer)), 'ac')
  assert.equal(backspace(emptyBuffer()).cursor, 0)
  assert.equal(textOf(deleteForward(bufferOf('x'))), 'x')
})

test('emoji and accents are single cursor steps', () => {
  let buffer = bufferOf('é🙂')
  assert.equal(buffer.cursor, 2)
  buffer = left(buffer)
  assert.equal(buffer.cursor, 1)
  buffer = backspace(buffer)
  assert.equal(textOf(buffer), '🙂')
})

test('left and right stop at the edges', () => {
  assert.equal(left(emptyBuffer()).cursor, 0)
  assert.equal(right(bufferOf('ab')).cursor, 2)
})

test('layout reports the row and column of the cursor across lines', () => {
  const buffer = { chars: Array.from('ab\ncd'), cursor: 4 }
  assert.deepEqual(layout(buffer), { lines: ['ab', 'cd'], row: 1, column: 1 })
  assert.deepEqual(layout(bufferOf('')), { lines: [''], row: 0, column: 0 })
})

test('up and down keep the column, clamped to the target line', () => {
  const text = Array.from('long line\nhi')
  // Row 0, column 7 moves down to row 1, which is only two cells wide: clamp to its end.
  const fromLong = { chars: text, cursor: 7 }
  assert.deepEqual(layout(down(fromLong)), { lines: ['long line', 'hi'], row: 1, column: 2 })
  // Row 1, column 2 moves up to row 0, column 2.
  const fromShort = { chars: text, cursor: 12 }
  assert.deepEqual(layout(up(fromShort)), { lines: ['long line', 'hi'], row: 0, column: 2 })
  // On the first row, up goes to the very start; on the last row, down goes to the end.
  assert.equal(up({ chars: Array.from('one'), cursor: 2 }).cursor, 0)
  assert.equal(down({ chars: Array.from('one'), cursor: 0 }).cursor, 3)
})

test('home and end move within the current line', () => {
  const buffer = { chars: Array.from('ab\ncdef'), cursor: 5 }
  assert.equal(home(buffer).cursor, 3)
  assert.equal(end(buffer).cursor, 7)
})

test('clear empties the buffer', () => {
  assert.equal(textOf(clear()), '')
})

test('control bytes are never inserted as text', () => {
  assert.equal(textOf(insert(emptyBuffer(), 'a\x7f\x7fb\x01c\x1b')), 'abc')
  assert.equal(textOf(insert(emptyBuffer(), 'linea\notra')), 'linea\notra')
})
