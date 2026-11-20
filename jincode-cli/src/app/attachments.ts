/**
 * Attachments for the next prompt: which files are images, how large a file
 * may be, and how a typed path is read. Pure, so the rules are tested alone.
 */
import { basename, isAbsolute, join } from 'node:path'

/** Image types the prompt accepts directly. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** One prompt part that carries an attachment. */
export type PromptAttachment =
  | { readonly type: 'file'; readonly receiptId: string }
  | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }

/** An attachment waiting for the next prompt of one Session. */
export interface AttachmentDraft {
  /** Local identity, stable while the draft is listed. */
  readonly key: string
  readonly name: string
  readonly size: number
  readonly part: PromptAttachment
}

/** Largest file the terminal reads and sends. The Host applies its own limits on top. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * The image media type a file name declares, when the prompt accepts it.
 * @param name - a file name or path.
 * @returns the media type, or undefined for anything that is not an accepted image.
 */
export function imageMediaTypeOf(name: string): ImageMediaType | undefined {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  return IMAGE_TYPES[name.slice(dot).toLowerCase()]
}

/**
 * Resolve a typed path: `~` becomes the home directory, a relative path is
 * taken from the working directory of the terminal.
 * @param input - the path as typed, trimmed.
 * @param home - the home directory.
 * @param cwd - the directory relative paths start from.
 * @returns the absolute path.
 */
export function resolvePath(input: string, home: string, cwd: string): string {
  const trimmed = input.trim()
  const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? expanded : join(cwd, expanded)
}

/**
 * Name a file shows in the attachment list.
 * @param path - the file path.
 * @returns the last path segment.
 */
export function fileNameOf(path: string): string {
  return basename(path)
}

/**
 * Explain why a file cannot be attached, when it cannot.
 * @param size - the file size in bytes.
 * @returns the message, or undefined when the size is acceptable.
 */
export function sizeProblem(size: number): string | undefined {
  if (size === 0) return 'el archivo está vacío'
  if (size > MAX_ATTACHMENT_BYTES) return `el archivo supera el límite de ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`
  return undefined
}
