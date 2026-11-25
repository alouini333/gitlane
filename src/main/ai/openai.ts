// OpenAI-compatible Chat Completions: OpenAI, OpenRouter, Ollama and any compatible endpoint.
import type { AgentBlock, AgentMessage, ModelInfo, ProviderId } from '../../shared/agent'
import { httpError, readSSE, RetryableError, type Credential, type ProviderAdapter, type ToolSpec, type TurnRequest, type TurnResult } from './adapter'
import { aiFetch } from './http'

const NAMES: Record<string, string> = { openai: 'OpenAI', openrouter: 'OpenRouter', ollama: 'Ollama', custom: 'The endpoint' }

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export function toOpenAIMessages(system: string, messages: AgentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
      const calls = m.blocks
        .filter((b): b is Extract<AgentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }))
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
    } else {
      for (const b of m.blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.isError ? `Error: ${b.content}` : b.content || '(empty)' })
        else if (b.type === 'text') out.push({ role: 'user', content: b.text })
      }
    }
  }
  return out
}

export const toOpenAITools = (tools: ToolSpec[]) =>
  tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }))

function headers(provider: ProviderId, cred: Credential): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cred.apiKey) h.Authorization = `Bearer ${cred.apiKey}`
  if (provider === 'openrouter') h['X-Title'] = 'Gitlane'
  return h
}

const base = (cred: Credential) => (cred.baseUrl ?? '').replace(/\/+$/, '')

// Model ids of OpenAI's own catalogue that can't drive a tool-using chat.
const NOT_CHAT = /embedding|whisper|tts|dall-e|image|moderation|audio|realtime|transcribe|search|computer-use|davinci|babbage/i

export function openAIAdapter(provider: ProviderId): ProviderAdapter {
  const name = NAMES[provider] ?? 'The endpoint'
  return {
    async listModels(cred: Credential): Promise<ModelInfo[]> {
      const res = await aiFetch(`${base(cred)}/models`, { headers: headers(provider, cred) })
      if (!res.ok) throw await httpError(res, name)
      const json = (await res.json()) as { data?: { id: string; name?: string; supported_parameters?: string[] }[] }
      return (json.data ?? [])
        .filter((m) => (provider === 'openai' ? !NOT_CHAT.test(m.id) : true))
        // OpenRouter lists capabilities; keep models that can call tools.
        .filter((m) => !m.supported_parameters || m.supported_parameters.includes('tools'))
        .map((m) => ({ id: m.id, name: m.name || m.id, provider }))
        .sort((a, b) => a.id.localeCompare(b.id))
    },

    async turn(cred: Credential, req: TurnRequest): Promise<TurnResult> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toOpenAIMessages(req.system, req.messages),
        tools: toOpenAITools(req.tools),
        stream: true
      }
      if (provider === 'openai' || provider === 'openrouter') body.stream_options = { include_usage: true }
      if (provider === 'openai' && /^(o\d|gpt-5)/.test(req.model)) body.reasoning_effort = req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort

      const res = await aiFetch(`${base(cred)}/chat/completions`, {
        method: 'POST',
        headers: headers(provider, cred),
        body: JSON.stringify(body),
        signal: req.signal
      })
      if (!res.ok) throw await httpError(res, name)

      let text = ''
      let finish: string | null = null
      let usage: TurnResult['usage']
      const calls = new Map<number, { id: string; name: string; args: string }>()
      try {
        await readSSE(res, (data) => {
          if (data === '[DONE]') return
          let chunk: {
            choices?: {
              delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }
              finish_reason?: string | null
            }[]
            usage?: { prompt_tokens?: number; completion_tokens?: number }
            error?: { message?: string }
          }
          try {
            chunk = JSON.parse(data)
          } catch {
            return
          }
          if (chunk.error) throw new Error(`${name}: ${chunk.error.message ?? 'stream error'}`)
          if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 }
          const choice = chunk.choices?.[0]
          if (!choice) return
          const delta = choice.delta ?? {}
          const reasoning = delta.reasoning ?? delta.reasoning_content
          if (reasoning) req.onDelta('thinking', reasoning)
          if (delta.content) {
            text += delta.content
            req.onDelta('text', delta.content)
          }
          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? calls.size
            const entry = calls.get(index) ?? { id: '', name: '', args: '' }
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.name += tc.function.name
            if (tc.function?.arguments) entry.args += tc.function.arguments
            calls.set(index, entry)
          }
          if (choice.finish_reason) finish = choice.finish_reason
        })
      } catch (err) {
        if (req.signal.aborted) throw err
        if (err instanceof Error && err.message.startsWith(`${name}:`)) throw err
        throw new RetryableError(err instanceof Error ? err.message : String(err))
      }

      const blocks: AgentBlock[] = []
      if (text) blocks.push({ type: 'text', text })
      let n = 0
      for (const call of calls.values()) {
        let input: Record<string, unknown>
        try {
          input = call.args.trim() ? (JSON.parse(call.args) as Record<string, unknown>) : {}
        } catch {
          input = { __invalid_json__: call.args }
        }
        blocks.push({ type: 'tool_use', id: call.id || `call_${Date.now()}_${n++}`, name: call.name, input })
      }
      const stop =
        calls.size > 0 && finish !== 'length'
          ? 'tool_use'
          : finish === 'length'
            ? 'max_tokens'
            : finish === 'content_filter'
              ? 'refusal'
              : 'end'
      return { blocks, stop, usage, stopDetail: stop === 'refusal' ? 'The provider filtered this response.' : undefined }
    }
  }
}
