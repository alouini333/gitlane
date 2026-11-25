// Renderer state for the coding agent: providers, models, chats, streaming and permission prompts.
import { create } from 'zustand'
import type {
  AgentApi,
  AgentEvent,
  Chat,
  ChatSummary,
  Effort,
  ModelInfo,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ProviderId,
  ProviderStatus
} from '../../shared/agent'
import type { ApiResult } from '../../shared/types'
import { toast, useStore } from './store'
import { errorMessage } from './util'

function unwrap<T>(r: ApiResult<unknown>): T {
  if (r.ok) return r.value as T
  throw new Error(r.error)
}

export const agentApi = new Proxy({} as AgentApi, {
  get:
    (_t, method: string) =>
    async (...args: unknown[]) =>
      unwrap(await window.bridge.agent(method, args))
})

interface ModelList {
  loading: boolean
  list: ModelInfo[]
  error: string | null
}

interface AgentState {
  tab: 'details' | 'agent'
  providers: ProviderStatus[] | null
  models: Partial<Record<ProviderId, ModelList>>
  provider: ProviderId | null
  model: string | null
  effort: Effort
  defaultMode: PermissionMode
  chats: ChatSummary[]
  chat: Chat | null
  running: Record<string, boolean>
  stream: Record<string, { text: string; thinking: string }>
  tools: Record<string, 'running' | 'waiting' | 'done'>
  permissions: PermissionRequest[]
  errors: Record<string, string | null>
  providersOpen: boolean
}

function saved<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`gitlane.agent.${key}`)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(`gitlane.agent.${key}`, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

export const useAgent = create<AgentState>(() => ({
  tab: saved<'details' | 'agent'>('tab', 'details'),
  providers: null,
  models: {},
  provider: saved<ProviderId | null>('provider', null),
  model: saved<string | null>('model', null),
  effort: saved<Effort>('effort', 'high'),
  defaultMode: saved<PermissionMode>('mode', 'ask'),
  chats: [],
  chat: null,
  running: {},
  stream: {},
  tools: {},
  permissions: [],
  errors: {},
  providersOpen: false
}))
const set = useAgent.setState
const get = useAgent.getState

// ------------------------------------------------------------------ events

let listening = false
export function listenToAgent() {
  if (listening) return
  listening = true
  window.bridge.onAgentEvent(handleEvent)
}

function handleEvent(e: AgentEvent) {
  switch (e.type) {
    case 'chat': {
      const chat = e.chat
      set((s) => ({
        chat: s.chat?.id === chat.id ? chat : s.chat,
        chats: s.chats.some((c) => c.id === chat.id)
          ? s.chats.map((c) => (c.id === chat.id ? summary(chat) : c)).sort((a, b) => b.updatedAt - a.updatedAt)
          : chat.repo === useStore.getState().repoPath
            ? [summary(chat), ...s.chats]
            : s.chats
      }))
      break
    }
    case 'delta':
      set((s) => {
        const cur = s.stream[e.chatId] ?? { text: '', thinking: '' }
        const next = e.kind === 'reset' ? { text: '', thinking: '' } : e.kind === 'text' ? { ...cur, text: cur.text + e.text } : { ...cur, thinking: cur.thinking + e.text }
        return { stream: { ...s.stream, [e.chatId]: next } }
      })
      break
    case 'running':
      set((s) => ({ running: { ...s.running, [e.chatId]: e.running }, ...(e.running ? { errors: { ...s.errors, [e.chatId]: null } } : {}) }))
      break
    case 'tool':
      set((s) => ({ tools: { ...s.tools, [e.toolUseId]: e.state } }))
      break
    case 'permission':
      set((s) => ({ permissions: [...s.permissions, e.request] }))
      break
    case 'permission-resolved':
      set((s) => ({ permissions: s.permissions.filter((p) => p.id !== e.id) }))
      break
    case 'error':
      set((s) => ({ errors: { ...s.errors, [e.chatId]: e.message } }))
      break
  }
}

const summary = (c: Chat): ChatSummary => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, provider: c.provider, model: c.model })

// ------------------------------------------------------------------ providers & models

const PREFERENCE: ProviderId[] = ['anthropic', 'openrouter', 'openai', 'gemini', 'custom', 'ollama']

export async function loadProviders() {
  try {
    const providers = await agentApi.providers()
    set({ providers })
    await ensureModel()
  } catch (e) {
    toast('error', errorMessage(e))
  }
}

export async function loadModels(provider: ProviderId, force = false): Promise<ModelInfo[]> {
  const cur = get().models[provider]
  if (cur && !force && (cur.loading || cur.list.length)) return cur.list
  set((s) => ({ models: { ...s.models, [provider]: { loading: true, list: cur?.list ?? [], error: null } } }))
  try {
    const list = await agentApi.models(provider)
    set((s) => ({ models: { ...s.models, [provider]: { loading: false, list, error: null } } }))
    return list
  } catch (e) {
    const error = provider === 'ollama' ? 'Ollama is not running. Start it with “ollama serve” (or open the Ollama app).' : errorMessage(e)
    set((s) => ({ models: { ...s.models, [provider]: { loading: false, list: [], error } } }))
    return []
  }
}

/** Highest version number found in an id, for picking the newest model of a family. */
const version = (id: string) => Number(/(\d+(?:[.-]\d+)?)/.exec(id.replace(/^\D+/, ''))?.[1]?.replace('-', '.') ?? 0)

export function defaultModel(provider: ProviderId, models: ModelInfo[]): string | null {
  const ids = models.map((m) => m.id)
  if (!ids.length) return null
  const pick = (re: RegExp) =>
    ids
      .filter((id) => re.test(id))
      .sort((a, b) => version(b) - version(a))[0]
  switch (provider) {
    case 'anthropic':
      return ids.includes('claude-opus-5-5') ? 'claude-opus-5-5' : (pick(/opus/) ?? ids[0])
    case 'openrouter':
      return pick(/anthropic\/claude.*opus/) ?? pick(/claude/) ?? ids[0]
    case 'openai':
      return pick(/^gpt-\d+(\.\d+)?$/) ?? pick(/^gpt-/) ?? ids[0]
    case 'gemini':
      return pick(/^gemini-[\d.]+-pro(-latest)?$/) ?? pick(/pro/) ?? ids[0]
    default:
      return ids[0]
  }
}

/** Make sure a usable provider+model is selected, preferring the user's last choice. */
async function ensureModel() {
  const { providers, provider, model } = get()
  if (!providers) return
  const connected = providers.filter((p) => p.connected)
  if (provider && model && connected.some((p) => p.id === provider)) {
    void loadModels(provider)
    return
  }
  for (const id of PREFERENCE) {
    if (!connected.some((p) => p.id === id)) continue
    const list = await loadModels(id)
    const choice = defaultModel(id, list)
    if (choice) {
      selectModel(id, choice)
      return
    }
  }
  set({ provider: null, model: null })
}

export function selectModel(provider: ProviderId, model: string) {
  set({ provider, model })
  persist('provider', provider)
  persist('model', model)
}

export function setEffort(effort: Effort) {
  set({ effort })
  persist('effort', effort)
}

export function setTab(tab: 'details' | 'agent') {
  set({ tab })
  persist('tab', tab)
}

export const openProviders = () => set({ providersOpen: true })
export const closeProviders = () => set({ providersOpen: false })

async function refreshAfterConnect(providers: ProviderStatus[], id: ProviderId) {
  set((s) => ({ providers, models: { ...s.models, [id]: undefined } }))
  const list = await loadModels(id, true)
  const choice = defaultModel(id, list)
  if (choice && (!get().provider || !providers.find((p) => p.id === get().provider)?.connected)) selectModel(id, choice)
}

export async function connectProvider(id: ProviderId, cred: { apiKey?: string; baseUrl?: string; label?: string }) {
  const providers = await agentApi.connect(id, cred)
  await refreshAfterConnect(providers, id)
  toast('success', 'Provider connected')
}

export async function signInOpenRouter() {
  const providers = await agentApi.signInOpenRouter()
  await refreshAfterConnect(providers, 'openrouter')
  toast('success', 'Signed in with OpenRouter')
}

export async function disconnectProvider(id: ProviderId) {
  const providers = await agentApi.disconnect(id)
  set((s) => ({ providers, models: { ...s.models, [id]: undefined } }))
  if (get().provider === id) {
    set({ provider: null, model: null })
    await ensureModel()
  }
}

// ------------------------------------------------------------------ chats

export async function loadChats(repo: string) {
  try {
    const chats = await agentApi.chats(repo)
    const current = get().chat
    set({ chats, chat: current && current.repo === repo ? current : null })
    if (!get().chat && chats[0]) await openChat(chats[0].id)
  } catch (e) {
    toast('error', errorMessage(e))
  }
}

export async function openChat(id: string) {
  const chat = await agentApi.chat(id)
  set({ chat })
}

export async function newChat() {
  const repo = useStore.getState().repoPath
  if (!repo) return
  const chat = await agentApi.newChat(repo, get().defaultMode)
  set((s) => ({ chat, chats: [summary(chat), ...s.chats] }))
}

export async function deleteChat(id: string) {
  await agentApi.deleteChat(id)
  set((s) => ({ chats: s.chats.filter((c) => c.id !== id), chat: s.chat?.id === id ? null : s.chat }))
}

export async function setMode(mode: PermissionMode) {
  set({ defaultMode: mode })
  persist('mode', mode)
  const chat = get().chat
  if (chat) set({ chat: await agentApi.setMode(chat.id, mode) })
}

export async function sendMessage(text: string) {
  const { provider, model, effort } = get()
  if (!text.trim()) return
  if (!provider || !model) {
    openProviders()
    return
  }
  if (!get().chat) await newChat()
  const chat = get().chat
  if (!chat) return
  try {
    await agentApi.send(chat.id, text.trim(), { provider, model, effort })
  } catch (e) {
    set((s) => ({ errors: { ...s.errors, [chat.id]: errorMessage(e) } }))
  }
}

export async function stopAgent() {
  const chat = get().chat
  if (chat) await agentApi.stop(chat.id)
}

export async function respond(id: string, decision: PermissionDecision, message?: string) {
  await agentApi.respond(id, decision, message)
}
