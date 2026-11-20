/**
 * Workspace file browsing rules, kept apart from the screen so they can be tested.
 * Paths are relative to the Session's workspace root; the root is the empty string.
 * Directories list first, then files, then anything else, each group by name.
 */

/** One child of a listed directory. */
export interface FileEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size: number | undefined
}

/** One page of a text file. */
export interface FilePage {
  readonly path: string
  readonly offset: number
  readonly lines: number
  readonly eof: boolean
  readonly text: string
}

/** The hits of one search, and whether the Host cut the list short. */
export interface SearchResult {
  readonly items: FileMatch[]
  readonly truncated: boolean
}

/** One search hit: a path under the workspace root and what it is. */
export interface FileMatch {
  readonly path: string
  readonly type: 'file' | 'directory' | 'other'
}

/** Lines per page of a file preview. */
export const PAGE_LINES = 40

/**
 * Read a directory listing.
 * @param value - the `workspaceFiles/list` result.
 * @returns the children, sorted for display.
 */
export function normalizeListing(value: unknown): { path: string; entries: FileEntry[] } {
  const record = isRecord(value) ? value : {}
  const entries = Array.isArray(record['entries'])
    ? record['entries'].flatMap((item): FileEntry[] => {
        if (!isRecord(item) || typeof item['name'] !== 'string') return []
        const type = item['type'] === 'file' || item['type'] === 'directory' ? item['type'] : 'other'
        return [{ name: item['name'], type, size: typeof item['size'] === 'number' ? item['size'] : undefined }]
      })
    : []
  return { path: typeof record['path'] === 'string' ? record['path'] : '', entries: sortEntries(entries) }
}

/**
 * Read one page of a file.
 * @param value - the `workspaceFiles/read` result.
 * @param path - the path that was asked for, used when the Host omits it.
 * @returns the page.
 */
export function normalizePage(value: unknown, path: string): FilePage {
  const record = isRecord(value) ? value : {}
  return {
    path,
    offset: typeof record['offset'] === 'number' ? record['offset'] : 1,
    lines: typeof record['lines'] === 'number' ? record['lines'] : 0,
    eof: record['eof'] === true,
    text: typeof record['text'] === 'string' ? record['text'] : '',
  }
}

/**
 * Read the hits of a search.
 * @param value - the `workspaceFiles/search` result.
 * @returns the matches in the Host's order, and whether the list was cut.
 */
export function normalizeMatches(value: unknown): SearchResult {
  const record = isRecord(value) ? value : {}
  const items = Array.isArray(record['matches'])
    ? record['matches'].flatMap((item): FileMatch[] => {
        if (!isRecord(item) || typeof item['path'] !== 'string' || item['path'].length === 0) return []
        const type = item['type'] === 'file' || item['type'] === 'directory' ? item['type'] : 'other'
        return [{ path: item['path'], type }]
      })
    : []
  return { items, truncated: record['truncated'] === true }
}

/**
 * Sort entries for display: directories, then files, then the rest; each by name.
 * @param entries - the children.
 * @returns a new sorted list.
 */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  const rank = { directory: 0, file: 1, other: 2 } as const
  return [...entries].sort((a, b) => rank[a.type] - rank[b.type] || a.name.localeCompare(b.name))
}

/**
 * The path of a child of a directory.
 * @param directory - the directory path; the root is empty.
 * @param name - the child's name.
 * @returns the joined path.
 */
export function childPath(directory: string, name: string): string {
  return directory.length === 0 ? name : `${directory}/${name}`
}

/**
 * The directory above a path. The root's parent is the root.
 * @param path - a directory path.
 * @returns the parent path.
 */
export function parentPath(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/**
 * A short size label for a file row.
 * @param bytes - the size in bytes, when known.
 * @returns a label such as `12 B`, `3.4 KB`, or an empty string.
 */
export function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What the Files section shows: a listing, optionally with a search result or an open page. */
export interface FilesView {
  readonly sessionId: string
  readonly path: string
  readonly entries: readonly FileEntry[]
  readonly page: FilePage | undefined
  readonly matches: { readonly query: string; readonly items: readonly FileMatch[]; readonly truncated: boolean } | undefined
  /** Whether searches include hidden files. The listing always shows them. */
  readonly includeHidden: boolean
}

/** One row of the Files section. */
export type FileRow =
  | { readonly kind: 'up' }
  | { readonly kind: 'entry'; readonly path: string; readonly type: 'file' | 'directory' | 'other'; readonly name: string; readonly size: number | undefined }
  | { readonly kind: 'match'; readonly path: string; readonly type: 'file' | 'directory' | 'other' }

/**
 * The rows the cursor walks: the search hits when a search is shown, otherwise
 * the parent entry (outside the root) and the children of the directory.
 * @param view - the Files state.
 * @returns the rows in display order.
 */
export function fileRowsOf(view: FilesView): FileRow[] {
  if (view.matches !== undefined) return view.matches.items.map(item => ({ kind: 'match' as const, path: item.path, type: item.type }))
  const rows: FileRow[] = view.path.length > 0 ? [{ kind: 'up' }] : []
  for (const entry of view.entries) {
    rows.push({ kind: 'entry', path: childPath(view.path, entry.name), type: entry.type, name: entry.name, size: entry.size })
  }
  return rows
}
