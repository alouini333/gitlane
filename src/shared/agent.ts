// Types for the built-in coding agent, shared by the main process and the renderer.

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'ollama' | 'custom'

export interface ProviderStatus {
  id: ProviderId
  name: string
  description: string
  connected: boolean
  /** Where the credential comes from. */
  source: 'stored' | 'env' | 'local' | null
  /** Env var the key was read from, when source is 'env'. */
  envVar?: string
  baseUrl?: string
  /** Display name for the custom OpenAI-compatible endpoint. */
  label?: string
  keyUrl?: string
  needsKey: boolean
  needsBaseUrl: boolean
  /** Offers a browser sign-in button (OpenRouter). */
  oauth: boolean
}

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
}

export type PermissionMode = 'ask' | 'edits' | 'all'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ToolKind = 'read' | 'edit' | 'exec'

export type ToolDisplay =
  | { kind: 'diff'; path: string; patch: string; additions: number; deletions: number; created: boolean }
  | { kind: 'command'; command: string; output: string; exitCode: number | null; timedOut?: boolean }
  | { kind: 'text'; summary: string }

export type AgentBlock =
  | { type: 'text'; text: string }
  /** Reasoning summary, shown to the user only. */
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; title?: string; display?: ToolDisplay }

export interface AgentUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  blocks: AgentBlock[]
  /** Provider-native content, replayed verbatim to the same provider (thinking/signatures). */
  native?: { provider: ProviderId; model: string; content: unknown }
  provider?: ProviderId
  model?: string
  /** Model that actually answered, when a fallback took over. */
  servedBy?: string
  usage?: AgentUsage
  /** Notice shown under the message (refusal, truncation, interruption). */
  notice?: string
  createdAt: number
}

export interface ChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  provider: ProviderId | null
  model: string | null
}

export interface Chat extends ChatSummary {
  repo: string
  /** Frozen at creation so the prompt prefix never changes (prompt caching, preserved thinking). */
  system: string
  messages: AgentMessage[]
  mode: PermissionMode
  /** Tool kinds the user allowed for the rest of this chat. */
  allowed: ToolKind[]
}

export interface PermissionRequest {
  id: string
  chatId: string
  toolUseId: string
  tool: string
  kind: ToolKind
  title: string
  preview?: ToolDisplay
}

export type PermissionDecision = 'allow' | 'allow-always' | 'deny'

export interface SendOptions {
  provider: ProviderId
  model: string
  effort: Effort
}

export type AgentEvent =
  | { type: 'chat'; chat: Chat }
  /** Streaming output of the current turn; 'reset' discards it (the turn is being re-issued). */
  | { type: 'delta'; chatId: string; kind: 'text' | 'thinking' | 'reset'; text: string }
  | { type: 'running'; chatId: string; running: boolean }
  | { type: 'tool'; chatId: string; toolUseId: string; state: 'running' | 'waiting' | 'done' }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permission-resolved'; chatId: string; id: string }
  | { type: 'error'; chatId: string; message: string }

/** Agent calls exposed to the renderer (window.bridge.agent). */
export interface AgentApi {
  providers(): Promise<ProviderStatus[]>
  connect(id: ProviderId, cred: { apiKey?: string; baseUrl?: string; label?: string }): Promise<ProviderStatus[]>
  disconnect(id: ProviderId): Promise<ProviderStatus[]>
  signInOpenRouter(): Promise<ProviderStatus[]>
  models(id: ProviderId): Promise<ModelInfo[]>
  chats(repo: string): Promise<ChatSummary[]>
  chat(id: string): Promise<Chat | null>
  newChat(repo: string, mode: PermissionMode): Promise<Chat>
  deleteChat(id: string): Promise<void>
  setMode(chatId: string, mode: PermissionMode): Promise<Chat>
  send(chatId: string, text: string, options: SendOptions): Promise<void>
  stop(chatId: string): Promise<void>
  respond(requestId: string, decision: PermissionDecision, message?: string): Promise<void>
}
