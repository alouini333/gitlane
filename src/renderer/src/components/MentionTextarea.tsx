import { useEffect, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import type { GhUser } from '../../../shared/types'
import { repoApi } from '../api'
import { findMention, insertMention, matchUsers, mergeSuggestions, prParticipants, type MentionUser } from '../mentions'
import { useStore } from '../store'
import { cls } from '../util'
import { GhAvatar } from './Markdown'

// Styles that affect where text wraps, copied onto a hidden mirror to find the caret's pixel position.
const MIRRORED = [
  'box-sizing', 'width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-family', 'font-size', 'font-weight',
  'font-style', 'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent', 'tab-size'
]

function caretPosition(el: HTMLTextAreaElement, index: number) {
  const style = getComputedStyle(el)
  const mirror = document.createElement('div')
  for (const prop of MIRRORED) mirror.style.setProperty(prop, style.getPropertyValue(prop))
  Object.assign(mirror.style, { position: 'absolute', top: '0', left: '-9999px', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' })
  mirror.textContent = el.value.slice(0, index)
  const marker = document.createElement('span')
  marker.textContent = '​'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop - el.scrollTop
  const left = marker.offsetLeft - el.scrollLeft
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4
  document.body.removeChild(mirror)
  const rect = el.getBoundingClientRect()
  return { x: rect.left + Math.min(left, el.clientWidth - 8), top: rect.top + top, bottom: rect.top + top + lineHeight }
}

// Remote lookups are cached per repository and query for the session.
const remoteCache = new Map<string, Promise<GhUser[]>>()
function lookup(path: string, query: string): Promise<GhUser[]> {
  const key = `${path}\n${query.toLowerCase()}`
  let hit = remoteCache.get(key)
  if (!hit) {
    hit = repoApi(path).mentionableUsers(query).catch(() => [])
    remoteCache.set(key, hit)
  }
  return hit
}

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string
  onChange: (value: string) => void
}

interface Mention {
  start: number
  query: string
  x: number
  top: number
  bottom: number
}

/** Textarea with GitHub-style @mention suggestions. */
export function MentionTextarea({ value, onChange, onKeyDown, onBlur, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const repoPath = useStore((s) => s.repoPath)
  const enabled = useStore((s) => !!s.github?.info?.authenticated)
  const pr = useStore((s) => (s.prView ? s.prDetails[s.prView.number]?.data : null))
  const [mention, setMention] = useState<Mention | null>(null)
  const [items, setItems] = useState<MentionUser[]>([])
  const [searching, setSearching] = useState(false)
  const [active, setActive] = useState(0)

  const detect = () => {
    const el = ref.current
    if (!el || !enabled || el.selectionStart !== el.selectionEnd) return setMention(null)
    const found = findMention(el.value, el.selectionStart)
    if (!found) return setMention(null)
    const pos = caretPosition(el, found.start)
    setMention((prev) => (prev && prev.start === found.start && prev.query === found.query ? prev : { ...found, ...pos }))
  }

  const query = mention?.query
  useEffect(() => {
    if (query === undefined || !repoPath) return
    const local = matchUsers(prParticipants(pr), query)
    setItems(local.slice(0, 8))
    setActive(0)
    if (!query && local.length >= 5) return // participants are enough for a bare "@"
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      lookup(repoPath, query).then((remote) => {
        if (cancelled) return
        setItems(mergeSuggestions(local, remote))
        setSearching(false)
      })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, repoPath, pr])

  const choose = (user: MentionUser) => {
    const el = ref.current
    if (!el || !mention) return
    const next = insertMention(el.value, mention.start, el.selectionStart, user.login)
    onChange(next.text)
    setMention(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        choose(items[active])
        return
      }
    }
    if (mention && e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setMention(null)
      return
    }
    onKeyDown?.(e)
  }

  const showEmpty = mention && !searching && items.length === 0 && mention.query.length > 0
  const below = mention ? mention.bottom + 260 < window.innerHeight : true

  return (
    <>
      <textarea
        {...rest}
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          detect()
        }}
        onKeyDown={handleKey}
        onKeyUp={(e) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) detect()
        }}
        onClick={detect}
        onBlur={(e) => {
          setMention(null)
          onBlur?.(e)
        }}
      />
      {mention &&
        (items.length > 0 || showEmpty) &&
        createPortal(
          <div
            className="mention-popup"
            style={{
              left: Math.max(8, Math.min(mention.x, window.innerWidth - 300)),
              ...(below ? { top: mention.bottom + 4 } : { bottom: window.innerHeight - mention.top + 4 })
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.map((u, i) => (
              <div
                key={u.login}
                className={cls('mention-item', i === active && 'on')}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(u)}
              >
                <GhAvatar user={u} size={18} />
                <span className="mention-login">{u.login}</span>
                {u.name && <span className="mention-name">{u.name}</span>}
                {u.participant && <span className="mention-tag">in this PR</span>}
              </div>
            ))}
            {showEmpty && <div className="mention-empty">No one named “{mention.query}” can be mentioned here</div>}
            {searching && items.length > 0 && <div className="mention-footer">Searching…</div>}
            {!searching && items.length > 0 && <div className="mention-footer">↑↓ choose · ↵ or Tab insert · Esc dismiss</div>}
          </div>,
          document.body
        )}
    </>
  )
}
