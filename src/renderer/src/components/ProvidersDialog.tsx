import { useEffect, useState } from 'react'
import type { ProviderId, ProviderStatus } from '../../../shared/agent'
import { openUrl } from '../actions'
import { closeProviders, connectProvider, disconnectProvider, loadModels, loadProviders, signInOpenRouter, useAgent } from '../agent'
import { cls, errorMessage } from '../util'
import { Icon } from './Icon'

function SourceBadge({ p }: { p: ProviderStatus }) {
  if (!p.connected) return <span className="prov-badge off">Not connected</span>
  const text = p.source === 'env' ? `Key from $${p.envVar}` : p.source === 'local' ? 'Local' : 'Connected · key in Keychain'
  return <span className="prov-badge on">{text}</span>
}

function ProviderRow({ p }: { p: ProviderStatus }) {
  const models = useAgent((s) => s.models[p.id])
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(p.id === 'custom' ? (p.baseUrl ?? '') : '')
  const [label, setLabel] = useState(p.label ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (p.id === 'ollama') void loadModels('ollama')
  }, [p.id])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await connectProvider(p.id, { apiKey, baseUrl: baseUrl || undefined, label: label || undefined })
      setEditing(false)
      setApiKey('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const oauth = async () => {
    setBusy(true)
    setError(null)
    try {
      await signInOpenRouter()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const ollamaDown = p.id === 'ollama' && !!models?.error
  return (
    <div className={cls('prov-row', p.connected && !ollamaDown && 'connected')}>
      <div className="prov-main">
        <div className="prov-name">
          {p.name}
          {p.id === 'ollama' ? (
            ollamaDown ? (
              <span className="prov-badge off">Not running</span>
            ) : models?.list.length ? (
              <span className="prov-badge on">{models.list.length} local model{models.list.length === 1 ? '' : 's'}</span>
            ) : (
              <span className="prov-badge off">Checking…</span>
            )
          ) : (
            <SourceBadge p={p} />
          )}
        </div>
        <div className="prov-desc">{ollamaDown ? models?.error : p.description}</div>
      </div>
      <div className="prov-actions">
        {p.oauth && !p.connected && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={oauth}>
            {busy ? 'Waiting for browser…' : 'Sign in'}
          </button>
        )}
        {p.id === 'ollama' ? (
          <button className="btn btn-sm" onClick={() => loadModels('ollama', true)}>
            Re-check
          </button>
        ) : p.source === 'stored' ? (
          <button className="btn btn-sm btn-danger" onClick={() => disconnectProvider(p.id)}>
            Disconnect
          </button>
        ) : (
          !editing && (
            <button className="btn btn-sm" onClick={() => setEditing(true)}>
              {p.oauth ? 'Use API key' : p.connected ? 'Use another key' : 'Connect'}
            </button>
          )
        )}
      </div>
      {editing && (
        <form
          className="prov-form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          {p.id === 'custom' && (
            <>
              <input placeholder="Name (e.g. Groq)" value={label} onChange={(e) => setLabel(e.target.value)} />
              <input placeholder="Base URL, e.g. https://api.groq.com/openai/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
            </>
          )}
          <input
            type="password"
            autoFocus
            placeholder={p.id === 'custom' ? 'API key (if the endpoint needs one)' : 'API key'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            spellCheck={false}
          />
          <div className="prov-form-actions">
            {p.keyUrl && (
              <button type="button" className="link-btn small" onClick={() => openUrl(p.keyUrl!)}>
                Get a key <Icon name="external" size={10} />
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
              {busy ? 'Checking…' : 'Save'}
            </button>
          </div>
        </form>
      )}
      {error && <div className="prov-error error-text">{error}</div>}
    </div>
  )
}

export function ProvidersDialog() {
  const open = useAgent((s) => s.providersOpen)
  const providers = useAgent((s) => s.providers)
  useEffect(() => {
    if (open) void loadProviders()
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeProviders()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  if (!open) return null
  const order: ProviderId[] = ['anthropic', 'openai', 'gemini', 'openrouter', 'ollama', 'custom']
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeProviders()}>
      <div className="modal providers">
        <h2>Model providers</h2>
        <p className="modal-message">
          Connect one or more providers for the agent. Keys are checked with the provider, then stored encrypted in your macOS Keychain and only used from this Mac.
        </p>
        <div className="prov-list">
          {order
            .map((id) => providers?.find((p) => p.id === id))
            .filter((p): p is ProviderStatus => !!p)
            .map((p) => (
              <ProviderRow key={p.id} p={p} />
            ))}
          {!providers && <div className="muted">Loading…</div>}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={closeProviders}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
