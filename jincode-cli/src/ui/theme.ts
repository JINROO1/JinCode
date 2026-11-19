/**
 * The JinCode palette: truecolor values chosen for dark and light terminals alike.
 * Body text keeps the terminal's own foreground; only accents are painted.
 */
export const palette = {
  brand: '#8AB4FF',
  brandStrong: '#5B8CFF',
  accent: '#C4A7FF',
  success: '#6FE3A8',
  warning: '#FFC66B',
  error: '#FF7D8F',
  muted: '#7A8190',
  faint: '#4B5263',
  user: '#9ED8FF',
  border: '#3A4152',
  borderActive: '#5B8CFF',
} as const

/** Glyphs used across the interface; each is a single terminal cell wide. */
export const glyph = {
  brand: '◆',
  prompt: '›',
  running: '◌',
  done: '✓',
  failed: '✕',
  live: '●',
  idle: '○',
  tool: '⚙',
  warning: '⚠',
  rule: '─',
  cursor: '▌',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
} as const
