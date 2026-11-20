import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childPath, fileRowsOf, normalizeListing, normalizeMatches, normalizePage, parentPath, sizeLabel, sortEntries, type FilesView } from '../src/app/file-model.ts'

test('listings sort directories first, then files, then the rest; each group by name', () => {
  const listing = normalizeListing({
    path: '',
    entries: [
      { name: 'zeta.txt', type: 'file', size: 3 },
      { name: 'socket', type: 'other' },
      { name: 'src', type: 'directory' },
      { name: 'alfa.md', type: 'file', size: 1024 },
      { name: 'lib', type: 'directory' },
      { type: 'file' },
    ],
  })
  assert.deepEqual(listing.entries.map(entry => entry.name), ['lib', 'src', 'alfa.md', 'zeta.txt', 'socket'])
  assert.equal(listing.path, '')
  assert.deepEqual(normalizeListing(null), { path: '', entries: [] })
})

test('paths: children join with a slash, the parent of a top-level name is the root, and the root has no parent', () => {
  assert.equal(childPath('', 'src'), 'src')
  assert.equal(childPath('src/app', 'a.ts'), 'src/app/a.ts')
  assert.equal(parentPath('src/app/a.ts'), 'src/app')
  assert.equal(parentPath('src'), '')
  assert.equal(parentPath(''), '')
})

test('pages and matches read what the Host sends and drop what it does not name', () => {
  const page = normalizePage({ offset: 41, text: 'a\nb', lines: 2, eof: true }, 'x.md')
  assert.deepEqual(page, { path: 'x.md', offset: 41, lines: 2, eof: true, text: 'a\nb' })
  assert.deepEqual(normalizeMatches({ matches: [{ path: 'src/a.ts', type: 'file' }, { path: '', type: 'file' }, { path: 'src', type: 'directory' }], truncated: true }), {
    items: [{ path: 'src/a.ts', type: 'file' }, { path: 'src', type: 'directory' }],
    truncated: true,
  }, 'an empty path is dropped and a cut list says so')
  assert.deepEqual(normalizeMatches({}), { items: [], truncated: false })
})

test('the rows the cursor walks: a parent row outside the root, then the children; search hits replace the listing', () => {
  const base: FilesView = {
    sessionId: 's',
    path: '',
    entries: normalizeListing({ entries: [{ name: 'src', type: 'directory' }, { name: 'a.md', type: 'file', size: 2 }] }).entries,
    page: undefined,
    matches: undefined,
    includeHidden: false,
  }
  assert.deepEqual(fileRowsOf(base).map(row => row.kind), ['entry', 'entry'], 'the root has no parent row')
  const inside = { ...base, path: 'src', entries: [{ name: 'b.ts', type: 'file' as const, size: undefined }] }
  assert.deepEqual(fileRowsOf(inside)[0], { kind: 'up' })
  assert.deepEqual(fileRowsOf(inside)[1], { kind: 'entry', path: 'src/b.ts', type: 'file', name: 'b.ts', size: undefined })
  const searched = { ...base, matches: { query: 'b', items: [{ path: 'src/b.ts', type: 'file' as const }], truncated: false } }
  assert.deepEqual(fileRowsOf(searched), [{ kind: 'match', path: 'src/b.ts', type: 'file' }])
})

test('size labels use bytes, kilobytes and megabytes; an unknown size is empty', () => {
  assert.equal(sizeLabel(12), '12 B')
  assert.equal(sizeLabel(3481), '3.4 KB')
  assert.equal(sizeLabel(5 * 1024 * 1024), '5.0 MB')
  assert.equal(sizeLabel(undefined), '')
  assert.deepEqual(sortEntries([]), [])
})
