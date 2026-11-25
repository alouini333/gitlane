import { marked } from 'marked'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentBlock, AgentMessage, Effort, PermissionMode, PermissionRequest, ToolDisplay } from '../../../shared/agent'
import {
  deleteChat,
  loadChats,
  loadModels,
  loadProviders,
  newChat,
  openChat,
  openProviders,
  respond,
  selectModel,
  sendMessage,
  setEffort,
  setMode,
  stopAgent,
  useAgent
} from '../agent'
import { showMenu, useStore } from '../store'
import { cls, relativeTime } from '../util'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

const md = (text: string) => marked.parse(text, { async: false, gfm: true, breaks: false }) as string

const MODES: { value: PermissionMode; label: string; detail: string }[] = [
  { value: 'ask', label: 'Ask first', detail: 'Ask before editing files or running commands' },
  { value: 'edits', label: 'Auto-edit', detail: 'Edit files freely, ask before running commands' },
  { value: 'all', label: 'Full auto', detail: 'Never ask. Only use this when you trust the task.' }
]
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// ------------------------------------------------------------------ tool rendering

function Patch({ patch }: { patch: string }) {
  return (
    <div className="agent-patch">
      {patch.split('\n').map((l, k) => (
        <div key={k} className={cls('ap-line', l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '')}>
          {l.startsWith('@@') ? l : l.slice(1) || ' '}
        </div>
      ))}
    </div>
  )
}

function DisplayBody({ display }: { display: ToolDisplay }) {
  if (display.kind === 'diff') return display.patch ? <Patch patch={display.patch} /> : <div className="tool-note">No changes.</div>
  if (display.kind === 'command')
    return (
      <div className="agent-cmd">
        <div className="agent-cmd-line">$ {display.command}</div>
        {display.output && <pre>{display.output}</pre>}
        {display.exitCode !== null && display.exitCode !== 0 && <div className="tool-note error-text">Exit code {display.exitCode}</div>}
        {display.timedOut && <div className="tool-note error-text">Timed out</div>}
      </div>
    )
  return <div className="tool-note">{display.summary}</div>
}

const TOOL_ICON: Record<string, string> = {
  read_file: 'file',
  list_files: 'folder',
  search: 'search',
  edit_file: 'edit',
  write_file: 'plus',
  run_command: 'terminal',
  git_status: 'branch',
  git_diff: 'diffIcon',
  git_log: 'branch'
}

function fallbackTitle(use: Extract<AgentBlock, { type: 'tool_use' }>) {
  const p = (k: string) => (typeof use.input[k] === 'string' ? (use.input[k] as string) : '')
  switch (use.name) {
    case 'read_file':
      return `Read ${p('path')}`
    case 'edit_file':
      return `Edit ${p('path')}`
    case 'write_file':
      return `Write ${p('path')}`
    case 'run_command':
      return `Run \`${p('command')}\``
    case 'search':
      return `Search “${p('pattern')}”`
    default:
      return use.name.replace(/_/g, ' ')
  }
}

function ToolCard({ use, result }: { use: Extract<AgentBlock, { type: 'tool_use' }>; result?: Extract<AgentBlock, { type: 'tool_result' }> }) {
  const state = useAgent((s) => s.tools[use.id])
  const display = result?.display
  const [open, setOpen] = useState(() => !!display && display.kind !== 'text' && !result?.isError)
  const title = result?.title ?? fallbackTitle(use)
  const status = !result ? (state === 'waiting' ? 'waiting' : 'running') : result.isError ? 'error' : 'ok'
  const counts = display?.kind === 'diff' ? (
    <span className="tool-counts">
      <span className="adds">+{display.additions}</span> <span className="dels">−{display.deletions}</span>
    </span>
  ) : display?.kind === 'text' ? (
    <span className="tool-summary">{display.summary}</span>
  ) : null
  const expandable = !!(display && display.kind !== 'text') || (result?.isError && result.content)
  return (
    <div className={cls('tool-card', `tool-${status}`)}>
      <div className="tool-head" onClick={() => expandable && setOpen((v) => !v)}>
        <span className="tool-icon">
          <Icon name={TOOL_ICON[use.name] ?? 'gear'} size={12} />
        </span>
        <span className="tool-title">{title}</span>
        {counts}
        <span className="spacer" />
        {status === 'running' && <span className="spinner" />}
        {status === 'waiting' && <span className="tool-tag">Waiting for you</span>}
        {status === 'ok' && <Icon name="check" size={12} className="ok-icon" />}
        {status === 'error' && <Icon name="close" size={12} className="err-icon" />}
        {expandable && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />}
      </div>
      {open && (
        <div className="tool-body">
          {display && <DisplayBody display={display} />}
          {result?.isError && (display?.kind !== 'command' || !display.output) && <div className="tool-note error-text">{result.content}</div>}
        </div>
      )}
    </div>
  )
}

function Permission({ request }: { request: PermissionRequest }) {
  const [reason, setReason] = useState('')
  const [denying, setDenying] = useState(false)
  const kindLabel = request.kind === 'exec' ? 'commands' : 'file edits'
  return (
    <div className="permission">
      <div className="permission-head">
        <Icon name="warning" size={14} />
        <strong>{request.kind === 'exec' ? 'Run this command?' : 'Apply this change?'}</strong>
        <span className="muted">{request.title}</span>
      </div>
      {request.preview && (
        <div className="permission-preview">
          <DisplayBody display={request.preview} />
        </div>
      )}
      {denying ? (
        <div className="permission-deny">
          <input autoFocus placeholder="Tell the agent what to do instead (optional)" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && respond(request.id, 'deny', reason)} />
          <button className="btn btn-sm btn-danger" onClick={() => respond(request.id, 'deny', reason)}>
            Decline
          </button>
        </div>
      ) : (
        <div className="permission-actions">
          <button className="btn btn-sm btn-primary" onClick={() => respond(request.id, 'allow')} autoFocus>
            Allow
          </button>
          <button className="btn btn-sm" onClick={() => respond(request.id, 'allow-always')}>
            Allow all {kindLabel} in this chat
          </button>
          <span className="spacer" />
          <button className="btn btn-sm btn-danger" onClick={() => setDenying(true)}>
            Decline…
          </button>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ messages

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div className="agent-thinking">
      <button className="link-btn small" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={9} /> {live ? 'Thinking…' : 'Reasoning'}
      </button>
      {open && <div className="agent-thinking-text">{text}</div>}
    </div>
  )
}

function AssistantMessage({ message, results }: { message: AgentMessage; results: Map<string, Extract<AgentBlock, { type: 'tool_result' }>> }) {
  return (
    <div className="agent-msg assistant">
      {message.blocks.map((b, k) => {
        if (b.type === 'thinking') return <Thinking key={k} text={b.text} />
        if (b.type === 'text') return b.text.trim() ? <Markdown key={k} html={md(b.text)} className="agent-md" /> : null
        if (b.type === 'tool_use') return <ToolCard key={b.id} use={b} result={results.get(b.id)} />
        return null
      })}
      {message.notice && <div className="agent-notice">{message.notice}</div>}
      {message.servedBy && <div className="agent-meta">Answered by {message.servedBy} (fallback)</div>}
    </div>
  )
}

function Empty({ connected }: { connected: boolean }) {
  const suggestions = ['Explain how this repository is organized', 'Review my uncommitted changes for bugs', 'Write tests for the most recently changed file']
  if (!connected) {
    return (
      <div className="agent-empty">
        <Icon name="comment" size={28} />
        <h3>Connect a model to start</h3>
        <p>Use Claude, GPT, Gemini, models through OpenRouter, or local models with Ollama.</p>
        <button className="btn btn-primary" onClick={openProviders}>
          Connect a provider
        </button>
      </div>
    )
  }
  return (
    <div className="agent-empty">
      <Icon name="comment" size={28} />
      <h3>What should we work on?</h3>
      <p>The agent can read and search this repository, edit files and run commands. You approve edits and commands before they happen.</p>
      <div className="agent-suggestions">
        {suggestions.map((s) => (
          <button key={s} className="btn btn-sm" onClick={() => sendMessage(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ header & composer

function ModelPicker() {
  const { providers, models, provider, model } = useAgent()
  const connected = (providers ?? []).filter((p) => p.connected)
  useEffect(() => {
    for (const p of connected) void loadModels(p.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers])
  const value = provider && model ? `${provider}|${model}` : ''
  return (
    <select
      className="agent-select model-select"
      value={value}
      onChange={(e) => {
        if (e.target.value === '__providers') return openProviders()
        const [p, ...rest] = e.target.value.split('|')
        selectModel(p as never, rest.join('|'))
      }}
      title="Model"
    >
      {!value && <option value="">Choose a model…</option>}
      {connected.map((p) => {
        const m = models[p.id]
        const list = m?.list ?? []
        const hasCurrent = provider === p.id && model && !list.some((x) => x.id === model)
        return (
          <optgroup key={p.id} label={p.label ? `${p.name} · ${p.label}` : p.name}>
            {hasCurrent && <option value={`${p.id}|${model}`}>{model}</option>}
            {list.map((x) => (
              <option key={x.id} value={`${p.id}|${x.id}`}>
                {x.name !== x.id ? `${x.name}` : x.id}
              </option>
            ))}
            {m?.loading && !list.length && <option disabled>Loading models…</option>}
            {m?.error && <option disabled>{m.error.slice(0, 80)}</option>}
          </optgroup>
        )
      })}
      <option value="__providers">Manage providers…</option>
    </select>
  )
}

function ChatMenuButton() {
  const { chats, chat } = useAgent()
  return (
    <button
      className="agent-chat-title"
      title="Chat history"
      onClick={(e) =>
        showMenu(e, [
          { label: 'New chat', action: () => void newChat() },
          ...(chats.length ? [{ separator: true }] : []),
          ...chats.slice(0, 20).map((c) => ({ label: `${c.id === chat?.id ? '● ' : ''}${c.title} · ${relativeTime(c.updatedAt / 1000)}`, action: () => void openChat(c.id) })),
          ...(chat ? [{ separator: true }, { label: 'Delete this chat', danger: true, action: () => void deleteChat(chat.id) }] : [])
        ])
      }
    >
      <span className="agent-chat-name">{chat?.title ?? 'New chat'}</span>
      <Icon name="chevronDown" size={10} />
    </button>
  )
}

function Composer({ running }: { running: boolean }) {
  const [text, setText] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const submit = () => {
    if (!text.trim() || running) return
    void sendMessage(text)
    setText('')
  }
  useEffect(() => {
    area.current?.focus()
  }, [])
  return (
    <div className="agent-composer">
      <textarea
        ref={area}
        value={text}
        placeholder={running ? 'The agent is working…' : 'Ask the agent to change, explain or check something'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="agent-composer-bar">
        <span className="muted small">Enter to send · Shift+Enter for a new line</span>
        <span className="spacer" />
        {running ? (
          <button className="btn btn-sm btn-danger" onClick={() => void stopAgent()}>
            Stop
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" disabled={!text.trim()} onClick={submit}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ panel

export function AgentPanel() {
  const repo = useStore((s) => s.repoPath)
  const { providers, chat, provider, effort, defaultMode } = useAgent()
  const running = useAgent((s) => (chat ? !!s.running[chat.id] : false))
  const stream = useAgent((s) => (chat ? s.stream[chat.id] : undefined))
  const error = useAgent((s) => (chat ? s.errors[chat.id] : null))
  const allPermissions = useAgent((s) => s.permissions)
  const permissions = useMemo(() => allPermissions.filter((p) => p.chatId === chat?.id), [allPermissions, chat?.id])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (!providers) void loadProviders()
  }, [providers])
  useEffect(() => {
    if (repo) void loadChats(repo)
  }, [repo])

  // Follow new output unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  const results = useMemo(() => {
    const map = new Map<string, Extract<AgentBlock, { type: 'tool_result' }>>()
    for (const m of chat?.messages ?? []) for (const b of m.blocks) if (b.type === 'tool_result') map.set(b.toolUseId, b)
    return map
  }, [chat])

  const connected = (providers ?? []).some((p) => p.connected)
  const mode = chat?.mode ?? defaultMode
  const showEffort = provider === 'anthropic' || provider === 'openai'
  const messages = chat?.messages ?? []

  let content: ReactNode
  if (!messages.length) content = <Empty connected={connected} />
  else
    content = messages.map((m, k) =>
      m.role === 'assistant' ? (
        <AssistantMessage key={k} message={m} results={results} />
      ) : m.blocks.some((b) => b.type === 'text') ? (
        <div key={k} className="agent-msg user">
          {m.blocks.map((b, j) => (b.type === 'text' ? <Fragment key={j}>{b.text}</Fragment> : null))}
        </div>
      ) : null
    )

  return (
    <div className="panel agent-panel">
      <div className="agent-header">
        <ChatMenuButton />
        <span className="spacer" />
        <button className="icon-btn" title="New chat" onClick={() => void newChat()}>
          <Icon name="plus" size={14} />
        </button>
        <button className="icon-btn" title="Model providers" onClick={openProviders}>
          <Icon name="gear" size={14} />
        </button>
      </div>
      <div className="agent-toolbar">
        <ModelPicker />
        {showEffort && (
          <select className="agent-select" value={effort} onChange={(e) => setEffort(e.target.value as Effort)} title="Effort: how hard the model thinks">
            {EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x} effort
              </option>
            ))}
          </select>
        )}
        <select
          className={cls('agent-select', mode === 'all' && 'danger')}
          value={mode}
          onChange={(e) => void setMode(e.target.value as PermissionMode)}
          title={MODES.find((m) => m.value === mode)?.detail}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value} title={m.detail}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {chat && chat.allowed.length > 0 && mode !== 'all' && (
        <div className="agent-allowed">Allowed in this chat: {chat.allowed.map((k) => (k === 'edit' ? 'file edits' : 'commands')).join(', ')}</div>
      )}
      <div
        className="agent-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {content}
        {running && stream && (stream.text || stream.thinking) && (
          <div className="agent-msg assistant live">
            <Thinking text={stream.thinking} live={!stream.text} />
            {stream.text && <Markdown html={md(stream.text)} className="agent-md" />}
          </div>
        )}
        {running && !stream?.text && !permissions.length && (
          <div className="agent-working">
            <span className="spinner" /> Working…
          </div>
        )}
        {permissions.map((p) => (
          <Permission key={p.id} request={p} />
        ))}
        {error && (
          <div className="agent-error">
            <Icon name="warning" size={13} /> {error}
          </div>
        )}
      </div>
      <Composer running={running} />
    </div>
  )
}
