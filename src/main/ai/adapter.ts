// Provider-neutral interface every model provider implements.
import type { AgentBlock, AgentMessage, AgentUsage, Effort, ModelInfo, ProviderId, ToolKind } from '../../shared/agent'

export interface Credential {
  apiKey?: string
  baseUrl?: string
  label?: string
}

/** JSON Schema subset understood by every provider (object of simple typed properties). */
export interface ToolSchema {
  type: 'object'
  properties: Record<string, { type: 'string' | 'integer' | 'boolean'; description: string }>
  required: string[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: ToolSchema
  kind: ToolKind
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other'

export interface TurnRequest {
  provider: ProviderId
  model: string
  system: string
  messages: AgentMessage[]
  tools: ToolSpec[]
  effort: Effort
  signal: AbortSignal
  onDelta: (kind: 'text' | 'thinking', text: string) => void
}

export interface TurnResult {
  blocks: AgentBlock[]
  native?: unknown
  stop: StopReason
  /** Extra explanation for refusal/other stops. */
  stopDetail?: string
  usage?: AgentUsage
  servedBy?: string
}

export interface ProviderAdapter {
  listModels(cred: Credential): Promise<ModelInfo[]>
  turn(cred: Credential, req: TurnRequest): Promise<TurnResult>
}

/** A transient failure (dropped connection, unparseable streamed tool input): the turn can be re-issued. */
export class RetryableError extends Error {}

/** Tool-call ids must be portable across providers (Anthropic only accepts [A-Za-z0-9_-]). */
export const portableId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'call'

/** Same-provider, same-model history: replay native content; otherwise convert from blocks. */
export function nativeFor(messages: AgentMessage[], provider: ProviderId, model: string): boolean {
  return messages.every((m) => m.role === 'user' || (m.native?.provider === provider && m.native.model === model))
}

/** Read a fetch Response body as Server-Sent Events, calling onData for each `data:` payload. */
export async function readSSE(res: Response, onData: (data: string, event?: string) => void): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []
  const dispatch = () => {
    if (data.length) onData(data.join('\n'), event)
    data = []
    event = undefined
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (line === '') dispatch()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('event:')) event = line.slice(6).trim()
    }
  }
  if (buffer.trim().startsWith('data:')) data.push(buffer.trim().slice(5).replace(/^ /, ''))
  dispatch()
}

/** Turn a non-OK HTTP response into a readable error. */
export async function httpError(res: Response, provider: string): Promise<Error> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
      detail = (typeof json.error === 'string' ? json.error : json.error?.message) ?? json.message ?? text
    } catch {
      detail = text
    }
  } catch {
    /* no body */
  }
  if (res.status === 401 || res.status === 403) return new Error(`${provider} rejected the API key (${res.status}). ${detail}`.trim())
  if (res.status === 429) return new Error(`${provider} rate limit reached. ${detail}`.trim())
  return new Error(`${provider} error ${res.status}: ${detail || res.statusText}`.trim())
}
