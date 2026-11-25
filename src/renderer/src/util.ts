import type { Status } from '../../shared/types'

export const cls = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

export const shortSha = (sha: string) => sha.slice(0, 7)

export const basename = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)

export const dirname = (p: string) => {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

export const repoName = (p: string) => basename(p.replace(/[\\/]+$/, '')) || p

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
export const formatDate = (seconds: number) => dateFormat.format(new Date(seconds * 1000))

const shortDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' })
export const formatShortDate = (seconds: number) => shortDateFormat.format(new Date(seconds * 1000))

export function relativeTime(seconds: number): string {
  const diff = Date.now() / 1000 - seconds
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Infinity, 'year']
  ]
  let value = diff
  for (const [size, unit] of units) {
    if (Math.abs(value) < size) {
      const n = Math.max(1, Math.round(value))
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`
    }
    value /= size
  }
  return ''
}

export function errorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^Error: /, '')
}

// Lane colors for the commit graph.
export const PALETTE = ['#15a0bf', '#0669f7', '#8e00c2', '#c517b6', '#d90171', '#cd0101', '#f25d2e', '#f2ca33', '#7bd938', '#2ece9d']
export const laneColor = (i: number) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]

export function hashColor(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return `hsl(${Math.abs(h) % 360} 55% 45%)`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export const hasChanges = (s: Status) => s.staged.length + s.unstaged.length + s.conflicted.length > 0

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
