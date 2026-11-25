// Google Gemini (generativelanguage API) with function calling and thought summaries.
import type { AgentBlock, AgentMessage, ModelInfo } from '../../shared/agent'
import { httpError, nativeFor, readSSE, RetryableError, type Credential, type ProviderAdapter, type ToolSpec, type TurnRequest, type TurnResult } from './adapter'
import { aiFetch } from './http'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface Part {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

/**
 * Build `contents`. Model turns from this same model are replayed with their original parts
 * (thought signatures must come back unchanged for function calling to keep working).
 * Consecutive same-role turns are merged, as Gemini expects alternating roles.
 */
export function toGeminiContents(messages: AgentMessage[], model: string): Content[] {
  const replay = nativeFor(messages, 'gemini', model)
  const names = new Map<string, string>()
  const out: Content[] = []
  const push = (role: Content['role'], parts: Part[]) => {
    if (!parts.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else out.push({ role, parts })
  }
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const b of m.blocks) if (b.type === 'tool_use') names.set(b.id, b.name)
      if (replay && m.native?.provider === 'gemini') {
        push('model', m.native.content as Part[])
        continue
      }
      const parts: Part[] = []
      for (const b of m.blocks) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text })
        else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input } })
      }
      push('model', parts.length ? parts : [{ text: '(no output)' }])
    } else {
      const parts: Part[] = []
      for (const b of m.blocks) {
        if (b.type === 'text') parts.push({ text: b.text })
        else if (b.type === 'tool_result') {
          const name = names.get(b.toolUseId) ?? 'tool'
          const id = b.toolUseId.startsWith('gemini_') ? undefined : b.toolUseId
          parts.push({ functionResponse: { ...(id ? { id } : {}), name, response: b.isError ? { error: b.content } : { result: b.content } } })
        }
      }
      push('user', parts)
    }
  }
  return out
}

export const toGeminiTools = (tools: ToolSpec[]) => [
  { functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }
]

export const geminiAdapter: ProviderAdapter = {
  async listModels(cred: Credential): Promise<ModelInfo[]> {
    const res = await aiFetch(`${BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': cred.apiKey ?? '' } })
    if (!res.ok) throw await httpError(res, 'Gemini')
    const json = (await res.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] }
    return (json.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name) && !/embedding|image|tts|aqa/.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name, provider: 'gemini' as const }))
  },

  async turn(cred: Credential, req: TurnRequest): Promise<TurnResult> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages, req.model),
      tools: toGeminiTools(req.tools),
      generationConfig: { thinkingConfig: { includeThoughts: true } }
    }
    const res = await aiFetch(`${BASE}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cred.apiKey ?? '' },
      body: JSON.stringify(body),
      signal: req.signal
    })
    if (!res.ok) throw await httpError(res, 'Gemini')

    const parts: Part[] = []
    let finish: string | undefined
    let usage: TurnResult['usage']
    try {
      await readSSE(res, (data) => {
        let chunk: {
          candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }
          promptFeedback?: { blockReason?: string }
          error?: { message?: string }
        }
        try {
          chunk = JSON.parse(data)
        } catch {
          return
        }
        if (chunk.error) throw new Error(`Gemini: ${chunk.error.message ?? 'stream error'}`)
        if (chunk.promptFeedback?.blockReason) finish = 'SAFETY'
        const cand = chunk.candidates?.[0]
        for (const p of cand?.content?.parts ?? []) {
          parts.push(p)
          if (p.text) req.onDelta(p.thought ? 'thinking' : 'text', p.text)
        }
        if (cand?.finishReason) finish = cand.finishReason
        if (chunk.usageMetadata) {
          usage = {
            input: chunk.usageMetadata.promptTokenCount ?? 0,
            output: chunk.usageMetadata.candidatesTokenCount ?? 0,
            cacheRead: chunk.usageMetadata.cachedContentTokenCount ?? 0
          }
        }
      })
    } catch (err) {
      if (req.signal.aborted) throw err
      if (err instanceof Error && err.message.startsWith('Gemini:')) throw err
      throw new RetryableError(err instanceof Error ? err.message : String(err))
    }

    const blocks: AgentBlock[] = []
    let text = ''
    let thinking = ''
    let n = 0
    for (const p of parts) {
      if (p.text && p.thought) thinking += p.text
      else if (p.text) text += p.text
      if (p.functionCall) {
        blocks.push({
          type: 'tool_use',
          id: p.functionCall.id || `gemini_${Date.now()}_${n++}`,
          name: p.functionCall.name,
          input: p.functionCall.args ?? {}
        })
      }
    }
    if (text) blocks.unshift({ type: 'text', text })
    if (thinking) blocks.unshift({ type: 'thinking', text: thinking })
    const hasCalls = blocks.some((b) => b.type === 'tool_use')
    const stop =
      finish === 'MAX_TOKENS'
        ? 'max_tokens'
        : finish && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/.test(finish)
          ? 'refusal'
          : hasCalls
            ? 'tool_use'
            : finish && finish !== 'STOP'
              ? 'other'
              : 'end'
    return {
      blocks,
      native: parts,
      stop,
      usage,
      stopDetail: stop === 'refusal' ? `Gemini blocked the response (${finish}).` : stop === 'other' ? `Gemini stopped: ${finish}` : undefined
    }
  }
}
