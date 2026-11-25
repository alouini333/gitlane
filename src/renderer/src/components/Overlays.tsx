import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { closeDialog, closeMenu, closePicker, dismissToast, useStore, type PickerOption } from '../store'
import { cls, errorMessage } from '../util'
import { Icon } from './Icon'
import { MentionTextarea } from './MentionTextarea'

export function ContextMenu() {
  const menu = useStore((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4))
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu()
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', closeMenu)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', closeMenu)
    }
  }, [menu])

  if (!menu) return null
  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item, i) => {
        if (item.separator) {
          // Skip leading, trailing and doubled separators.
          const prev = menu.items[i - 1]
          if (i === 0 || i === menu.items.length - 1 || prev?.separator) return null
          return <div key={i} className="menu-sep" />
        }
        return (
          <button
            key={i}
            className={cls('menu-item', item.danger && 'danger')}
            disabled={item.disabled}
            onClick={() => {
              closeMenu()
              item.action?.()
            }}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

export function Dialog() {
  const dialog = useStore((s) => s.dialog)
  const [values, setValues] = useState<Record<string, string>>({})
  const [checked, setChecked] = useState(false)
  const firstInput = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null)

  useEffect(() => {
    if (!dialog) return
    setValues(Object.fromEntries((dialog.fields ?? []).map((f) => [f.key, f.initial ?? f.options?.[0] ?? ''])))
    setChecked(dialog.checkbox?.initial ?? false)
    setTimeout(() => {
      firstInput.current?.focus()
      if (firstInput.current && 'select' in firstInput.current && firstInput.current.tagName === 'INPUT') firstInput.current.select()
    }, 0)
  }, [dialog])

  if (!dialog) return null
  const submit = () => closeDialog({ values, checked })

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeDialog(null)}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            closeDialog(null)
          }
        }}
      >
        <h2>{dialog.title}</h2>
        {dialog.message && <p className="modal-message">{dialog.message}</p>}
        {(dialog.fields ?? []).map((field, i) => (
          <label key={field.key} className="modal-field">
            {field.label && <span>{field.label}</span>}
            {field.options ? (
              <select
                ref={i === 0 ? firstInput : undefined}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              >
                {field.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : field.multiline ? (
              <MentionTextarea
                autoFocus={i === 0}
                rows={4}
                placeholder={field.placeholder}
                value={values[field.key] ?? ''}
                onChange={(value) => setValues((v) => ({ ...v, [field.key]: value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
                }}
              />
            ) : (
              <input
                ref={i === 0 ? firstInput : undefined}
                placeholder={field.placeholder}
                value={values[field.key] ?? ''}
                spellCheck={false}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              />
            )}
          </label>
        ))}
        {dialog.checkbox && (
          <label className="modal-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {dialog.checkbox.label}
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => closeDialog(null)}>
            Cancel
          </button>
          <button
            type="submit"
            className={cls('btn', dialog.danger ? 'btn-danger' : 'btn-primary')}
            ref={dialog.fields?.length ? undefined : (el) => el?.focus()}
          >
            {dialog.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cls('toast', `toast-${t.kind}`)} onClick={() => dismissToast(t.id)}>
          {t.kind === 'error' && <Icon name="warning" />}
          <pre>{t.text}</pre>
        </div>
      ))}
    </div>
  )
}

/** Multi-select popover (reviewers, assignees, labels). Changes apply when it closes, like on GitHub. */
export function Picker() {
  const spec = useStore((s) => s.picker)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<PickerOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const known = useRef(new Map<string, PickerOption>())
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!spec) return
    setSelected(new Set(spec.selected))
    setQuery('')
    setOptions(null)
    setError(null)
    known.current = new Map()
  }, [spec])

  useEffect(() => {
    if (!spec) return
    let cancelled = false
    const timer = setTimeout(() => {
      spec
        .load(query)
        .then((opts) => {
          if (cancelled) return
          opts.forEach((o) => known.current.set(o.key, o))
          setOptions(opts)
        })
        .catch((e) => !cancelled && setError(errorMessage(e)))
    }, query ? 250 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [spec, query])

  const finish = () => {
    if (!spec) return
    const before = new Set(spec.selected)
    const added = [...selected].filter((k) => !before.has(k))
    const removed = [...before].filter((k) => !selected.has(k))
    closePicker()
    if (added.length || removed.length) spec.onApply(added, removed)
  }

  useEffect(() => {
    if (!spec) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) finish()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  })

  if (!spec) return null
  // Selected entries stay visible on top even when the search doesn't match them.
  const shown = new Map<string, PickerOption>()
  for (const key of selected) shown.set(key, known.current.get(key) ?? { key, label: key })
  for (const o of options ?? []) shown.set(o.key, o)
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className="picker" ref={box} style={{ left: Math.min(spec.x, window.innerWidth - 296), top: Math.min(spec.y, window.innerHeight - 380) }}>
      <div className="picker-title">{spec.title}</div>
      <input autoFocus placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      <div className="picker-list">
        {error && <div className="picker-note error-text">{error}</div>}
        {!options && !error && <div className="picker-note">Loading…</div>}
        {[...shown.values()].map((o) => (
          <button key={o.key} className={cls('picker-item', selected.has(o.key) && 'on')} onClick={() => toggle(o.key)}>
            <span className="picker-check">{selected.has(o.key) && <Icon name="check" size={12} />}</span>
            {o.avatarUrl && <img className="gh-avatar" src={`${o.avatarUrl}${o.avatarUrl.includes('?') ? '&' : '?'}s=40`} width={18} height={18} alt="" />}
            {o.color && <span className="picker-swatch" style={{ background: o.color }} />}
            <span className="picker-label">{o.label}</span>
            {o.detail && <span className="picker-detail">{o.detail}</span>}
          </button>
        ))}
        {options && shown.size === 0 && <div className="picker-note">No matches</div>}
      </div>
    </div>
  )
}
