import DOMPurify from 'dompurify'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { repoApi } from '../api'
import { openUrl } from '../actions'
import { useStore } from '../store'
import { cls, errorMessage, hashColor, initials } from '../util'
import { MentionTextarea } from './MentionTextarea'

/** HTML rendered by GitHub (bodyHTML / markdown API), sanitized before display. */
export function Markdown({ html, className }: { html: string; className?: string }) {
  const clean = useMemo(
    () => DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'button', 'iframe'], FORBID_ATTR: ['style'] }),
    [html]
  )
  const onClick = (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//.test(href)) openUrl(href)
  }
  return <div className={cls('markdown', className)} onClick={onClick} dangerouslySetInnerHTML={{ __html: clean }} />
}

export function GhAvatar({ user, size = 20 }: { user: { login: string; avatarUrl?: string | null } | null; size?: number }) {
  const [failed, setFailed] = useState(false)
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) }
  if (!user) return <span className="gh-avatar ghost" style={style} />
  if (!user.avatarUrl || failed) {
    return (
      <span className="gh-avatar" style={{ ...style, background: hashColor(user.login) }} title={user.login}>
        {initials(user.login)}
      </span>
    )
  }
  const src = `${user.avatarUrl}${user.avatarUrl.includes('?') ? '&' : '?'}s=${size * 2}`
  return <img className="gh-avatar" src={src} width={size} height={size} alt="" title={user.login} onError={() => setFailed(true)} />
}

interface EditorProps {
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  placeholder?: string
  autoFocus?: boolean
  minHeight?: number
}

/** Markdown textarea with a GitHub-rendered preview tab. Cmd/Ctrl+Enter submits. */
export function MarkdownEditor({ value, onChange, onSubmit, placeholder, autoFocus, minHeight = 90 }: EditorProps) {
  const repoPath = useStore((s) => s.repoPath)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [preview, setPreview] = useState<{ text: string; html: string | null; error?: string } | null>(null)

  useEffect(() => {
    if (tab !== 'preview' || !repoPath || preview?.text === value) return
    let cancelled = false
    setPreview({ text: value, html: null })
    repoApi(repoPath)
      .renderMarkdown(value)
      .then((html) => !cancelled && setPreview({ text: value, html }))
      .catch((e) => !cancelled && setPreview({ text: value, html: null, error: errorMessage(e) }))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, value, repoPath])

  return (
    <div className="md-editor">
      <div className="md-tabs">
        <button type="button" className={cls(tab === 'write' && 'on')} onClick={() => setTab('write')}>
          Write
        </button>
        <button type="button" className={cls(tab === 'preview' && 'on')} onClick={() => setTab('preview')}>
          Preview
        </button>
        <span className="md-hint">Markdown · @ to mention · ⌘↵ to submit</span>
      </div>
      {tab === 'write' ? (
        <MentionTextarea
          autoFocus={autoFocus}
          value={value}
          placeholder={placeholder}
          style={{ minHeight }}
          onChange={onChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && value.trim()) {
              e.preventDefault()
              onSubmit?.()
            }
          }}
        />
      ) : (
        <div className="md-preview" style={{ minHeight }}>
          {!value.trim() ? (
            <span className="muted">Nothing to preview</span>
          ) : preview?.error ? (
            <span className="error-text">{preview.error}</span>
          ) : preview?.html != null ? (
            <Markdown html={preview.html} />
          ) : (
            <span className="muted">Rendering…</span>
          )}
        </div>
      )}
    </div>
  )
}
