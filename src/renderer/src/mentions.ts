// @mention autocomplete: detecting the token being typed, and finding people to suggest.
import type { GhUser, PrDetail } from '../../shared/types'

export interface MentionUser {
  login: string
  name?: string
  avatarUrl?: string
  /** Takes part in the open pull request (shown first). */
  participant?: boolean
}

/**
 * The @mention being typed at `caret`, if any. Like github.com it triggers on "@" at the start or
 * after a non-word character, so "me@example.com" doesn't open suggestions.
 */
export function findMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(?:^|[^\w`@/])@([A-Za-z0-9][A-Za-z0-9-]{0,38}|)$/.exec(before)
  if (!m) return null
  return { start: caret - m[1].length - 1, query: m[1] }
}

/** Replace the mention token at `start..caret` with "@login ". Returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, login: string): { text: string; caret: number } {
  const inserted = `@${login} `
  const after = text.slice(caret).replace(/^[A-Za-z0-9-]*/, '') // finish a token the caret sits inside of
  return { text: text.slice(0, start) + inserted + after.replace(/^ /, ''), caret: start + inserted.length }
}

/** Everyone involved in a pull request, most relevant first. */
export function prParticipants(pr: PrDetail | null | undefined): MentionUser[] {
  if (!pr) return []
  const seen = new Map<string, MentionUser>()
  const add = (u: { login: string; avatarUrl?: string | null } | null | undefined) => {
    if (u?.login && !seen.has(u.login.toLowerCase())) {
      seen.set(u.login.toLowerCase(), { login: u.login, avatarUrl: u.avatarUrl ?? undefined, participant: true })
    }
  }
  add(pr.author)
  pr.reviewers.filter((r) => !r.isTeam).forEach((r) => add({ login: r.login, avatarUrl: r.avatarUrl }))
  pr.assignees.forEach(add)
  for (const item of pr.timeline) {
    if (item.type === 'comment') add(item.comment.author)
    else if (item.type === 'review' || item.type === 'event') add(item.type === 'review' ? item.author : item.actor)
  }
  pr.threads.forEach((t) => t.comments.forEach((c) => add(c.author)))
  pr.commits.forEach((c) => c.author && c.avatarUrl && add({ login: c.author, avatarUrl: c.avatarUrl }))
  seen.delete(pr.viewer.login.toLowerCase())
  return [...seen.values()]
}

/** Prefix matches first, then substring matches on login or name. */
export function matchUsers(users: MentionUser[], query: string): MentionUser[] {
  const q = query.toLowerCase()
  if (!q) return users
  const score = (u: MentionUser) => {
    const login = u.login.toLowerCase()
    const name = (u.name ?? '').toLowerCase()
    if (login.startsWith(q)) return 0
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1
    if (login.includes(q) || name.includes(q)) return 2
    return -1
  }
  return users
    .map((u) => [u, score(u)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => a[1] - b[1])
    .map(([u]) => u)
}

/** Participants first, then remote results; deduplicated, at most `limit`. */
export function mergeSuggestions(local: MentionUser[], remote: GhUser[], limit = 8): MentionUser[] {
  const out = new Map<string, MentionUser>()
  for (const u of local) out.set(u.login.toLowerCase(), u)
  for (const u of remote) {
    const key = u.login.toLowerCase()
    const existing = out.get(key)
    out.set(key, existing ? { ...existing, name: existing.name ?? u.name, avatarUrl: existing.avatarUrl ?? u.avatarUrl } : { ...u })
  }
  return [...out.values()].slice(0, limit)
}
