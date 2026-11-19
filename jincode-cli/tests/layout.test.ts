import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellWidth, fitHints, packHints, pickLayout, truncate, wrapText, WIDE_BREAKPOINT } from '../src/ui/layout.ts'

test('pickLayout keeps the sidebar beside the conversation only from the breakpoint', () => {
  assert.equal(pickLayout(WIDE_BREAKPOINT - 1).mode, 'compact')
  assert.equal(pickLayout(WIDE_BREAKPOINT - 1).sidebarWidth, 0)
  const wide = pickLayout(120)
  assert.equal(wide.mode, 'wide')
  assert.ok(wide.sidebarWidth >= 26 && wide.sidebarWidth <= 34)
  assert.equal(wide.sidebarWidth + 1 + wide.mainWidth, 120)
})

test('pickLayout gives a phone-width screen the whole width', () => {
  const phone = pickLayout(44)
  assert.deepEqual(phone, { mode: 'compact', sidebarWidth: 0, mainWidth: 44 })
})

test('cellWidth counts wide characters as two cells and combining marks as none', () => {
  assert.equal(cellWidth('abc'), 3)
  assert.equal(cellWidth('你好'), 4)
  assert.equal(cellWidth('é'), 1)
  assert.equal(cellWidth('e\u0301'), 1)
})

test('wrapText never exceeds the width and keeps every word', () => {
  const text = 'el agente revisa el repositorio y propone un cambio en la configuración del modelo'
  for (const width of [8, 15, 24, 40]) {
    const lines = wrapText(text, width)
    for (const line of lines) assert.ok(cellWidth(line) <= width, `"${line}" wider than ${width}`)
    // Words longer than the width are broken across lines, so compare without spaces.
    assert.equal(lines.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''))
  }
})

test('wrapText breaks a word longer than the width instead of clipping it', () => {
  const lines = wrapText('supercalifragilisticoespialidoso', 10)
  assert.ok(lines.length >= 3)
  assert.equal(lines.join(''), 'supercalifragilisticoespialidoso')
  for (const line of lines) assert.ok(cellWidth(line) <= 10)
})

test('wrapText measures CJK text by cells', () => {
  const lines = wrapText('你好世界你好世界', 4)
  for (const line of lines) assert.ok(cellWidth(line) <= 4)
  assert.equal(lines.join(''), '你好世界你好世界')
})

test('wrapText keeps existing newlines', () => {
  assert.deepEqual(wrapText('uno\ndos', 20), ['uno', 'dos'])
  assert.deepEqual(wrapText('', 5), [''])
})

test('fitHints keeps whole hints and marks the omitted ones, never exceeding the width', () => {
  const hints = ['Enter enviar', 'Ctrl+N nueva sesión', 'Ctrl+K sesiones', 'Ctrl+M modelo', 'Ctrl+Q salir']
  for (const width of [12, 30, 60, 200]) {
    const line = fitHints(hints, width)
    assert.ok(cellWidth(line) <= width, `"${line}" wider than ${width}`)
    for (const piece of line.split('  ').filter(p => p !== '…')) {
      assert.ok(hints.some(hint => hint === piece), `"${piece}" is a clipped hint`)
    }
  }
  assert.equal(fitHints(hints, 200), hints.join('  '))
  assert.ok(fitHints(hints, 30).endsWith('…'))
})

test('truncate shortens with an ellipsis only when needed', () => {
  assert.equal(truncate('corto', 10), 'corto')
  const cut = truncate('una frase bastante larga', 10)
  assert.ok(cellWidth(cut) <= 10)
  assert.ok(cut.endsWith('…'))
})

test('packHints never splits a hint and never exceeds the width', () => {
  const hints = ['Enter enviar', 'Alt+Enter nueva línea', 'Ctrl+K sesiones', 'Ctrl+M modelo', 'Ctrl+G claves', 'Ctrl+F buscar', 'Ctrl+Q salir']
  for (const width of [24, 44, 60, 98]) {
    const lines = packHints(hints, width)
    for (const line of lines) assert.ok(cellWidth(line) <= width, `"${line}" wider than ${width}`)
    const parts = lines.join('  ·  ').split('  ·  ')
    assert.deepEqual(parts, hints, `every hint must appear whole at width ${width}`)
  }
  assert.equal(packHints(hints, 400).length, 1)
})
