import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ATTACHMENT_BYTES, fileNameOf, imageMediaTypeOf, resolvePath, sizeProblem } from '../src/app/attachments.ts'

test('imageMediaTypeOf accepts the four prompt image types, any case', () => {
  assert.equal(imageMediaTypeOf('foto.PNG'), 'image/png')
  assert.equal(imageMediaTypeOf('a/b/c.jpeg'), 'image/jpeg')
  assert.equal(imageMediaTypeOf('x.jpg'), 'image/jpeg')
  assert.equal(imageMediaTypeOf('x.webp'), 'image/webp')
  assert.equal(imageMediaTypeOf('x.gif'), 'image/gif')
  assert.equal(imageMediaTypeOf('x.svg'), undefined)
  assert.equal(imageMediaTypeOf('sin-extension'), undefined)
})

test('resolvePath expands ~ and takes relative paths from the working directory', () => {
  assert.equal(resolvePath('~/doc.pdf', '/home/u', '/work'), '/home/u/doc.pdf')
  assert.equal(resolvePath('  ~  ', '/home/u', '/work'), '/home/u')
  assert.equal(resolvePath('notes/a.md', '/home/u', '/work'), '/work/notes/a.md')
  assert.equal(resolvePath('/etc/hosts', '/home/u', '/work'), '/etc/hosts')
})

test('fileNameOf returns the last segment', () => {
  assert.equal(fileNameOf('/a/b/c.txt'), 'c.txt')
})

test('sizeProblem rejects empty and oversized files', () => {
  assert.equal(sizeProblem(0), 'el archivo está vacío')
  assert.equal(sizeProblem(10), undefined)
  assert.equal(sizeProblem(MAX_ATTACHMENT_BYTES), undefined)
  assert.match(sizeProblem(MAX_ATTACHMENT_BYTES + 1) ?? '', /límite de 25 MB/)
})
