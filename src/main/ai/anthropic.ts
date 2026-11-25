// Claude via the official Anthropic SDK: streaming, adaptive thinking, effort, prompt caching,
// eager tool-input streaming and server-side refusal fallbacks.
import Anthropic from '@anthropic-ai/sdk'
import type { AgentBlock, AgentMessage, ModelInfo } from '../../shared/agent'
import { RetryableError, nativeFor, portableId, type Credential, type ProviderAdapter, type ToolSpec, type TurnRequest, type TurnResult } from './adapter'

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming

/**
 * `claude setup-token` prints a Claude Code sign-in token (sk-ant-oat…) tied to a Claude subscription.
 * It isn't an API key, and the API answers it with an unhelpful 429, so explain instead.
 */
export function checkAnthropicKey(key: string | undefined) {
  if (key?.startsWith('sk-ant-oat')) {
    throw new Error(
      'This is a Claude Code sign-in token (from "claude setup-token"), not an API key. It only works in Claude Code. ' +
        'Create an API key at platform.claude.com/settings/keys (it starts with sk-ant-api) and paste that instead.'
    )
  }
}

const client = (cred: Credential) => {
  checkAnthropicKey(cred.apiKey)
  return new Anthropic({ apiKey: cred.apiKey, baseURL: cred.baseUrl || undefined, maxRetries: 2 })
}

/** Current model families take adaptive thinking + effort; older ones get neither. */
export function anthropicFeatures(model: string) {
  const modern = /claude-(fable|mythos|opus|sonnet|haiku)-(5|4-[6-9])/.test(model) && !/haiku-4/.test(model)
  // Server-side refusal fallbacks ("default" routing) are offered on these models.
  const fallbacks = /^claude-(fable-5-[12]|opus-5-5|opus-5|sonnet-5-5)$/.test(model)
  return { modern, fallbacks }
}

export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Beta.Messages.BetaTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { ...t.parameters },
    eager_input_streaming: true
  }))
}

/**
 * Convert the conversation. When every assistant turn came from this same model, replay its native
 * content verbatim (thinking and fallback blocks included) so the prefix stays byte-identical.
 * After a model switch, thinking blocks are left out entirely, which keeps the history valid.
 */
export function toAnthropicMessages(messages: AgentMessage[], model: string): Anthropic.Beta.Messages.BetaMessageParam[] {
  const replay = nativeFor(messages, 'anthropic', model)
  return messages.map((m): Anthropic.Beta.Messages.BetaMessageParam => {
    if (m.role === 'assistant') {
      if (m.native?.provider === 'anthropic') {
        const content = m.native.content as Anthropic.Beta.Messages.BetaContentBlockParam[]
        return {
          role: 'assistant',
          content: replay ? content : content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking' && b.type !== 'fallback')
        }
      }
      const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = []
      for (const b of m.blocks) {
        if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text })
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: portableId(b.id), name: b.name, input: b.input })
      }
      return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no output)' }] }
    }
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = m.blocks.flatMap((b): Anthropic.Beta.Messages.BetaContentBlockParam[] => {
      if (b.type === 'text') return [{ type: 'text', text: b.text }]
      if (b.type === 'tool_result')
        return [{ type: 'tool_result', tool_use_id: portableId(b.toolUseId), content: b.content || '(empty)', is_error: b.isError }]
      return []
    })
    return { role: 'user', content }
  })
}

export function buildAnthropicParams(req: TurnRequest): Params {
  const { modern, fallbacks } = anthropicFeatures(req.model)
  const params: Params = {
    model: req.model,
    max_tokens: 64000,
    // Explicit breakpoint on the frozen system prompt + automatic caching for the growing tail.
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    cache_control: { type: 'ephemeral' },
    tools: toAnthropicTools(req.tools),
    messages: toAnthropicMessages(req.messages, req.model)
  }
  if (modern) {
    params.thinking = { type: 'adaptive', display: 'summarized' }
    params.output_config = { effort: req.effort }
  }
  if (fallbacks) {
    params.betas = ['server-side-fallback-2026-07-01']
    params.fallbacks = 'default'
  }
  return params
}

export const anthropicAdapter: ProviderAdapter = {
  async listModels(cred: Credential): Promise<ModelInfo[]> {
    const models: ModelInfo[] = []
    for await (const m of client(cred).models.list({ limit: 100 })) {
      models.push({ id: m.id, name: m.display_name || m.id, provider: 'anthropic' })
    }
    return models
  },

  async turn(cred: Credential, req: TurnRequest): Promise<TurnResult> {
    const stream = client(cred).beta.messages.stream(buildAnthropicParams(req), { signal: req.signal })
    let message: Anthropic.Beta.Messages.BetaMessage
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') req.onDelta('text', event.delta.text)
          else if (event.delta.type === 'thinking_delta') req.onDelta('thinking', event.delta.thinking)
        }
      }
      message = await stream.finalMessage()
    } catch (err) {
      // API errors (auth, rate limit, bad request) and user aborts are final. Anything else is a
      // dropped connection or a streamed tool input that could not be parsed: re-issue the turn.
      if (err instanceof Anthropic.APIError || req.signal.aborted) throw err
      throw new RetryableError(err instanceof Error ? err.message : String(err))
    }

    const blocks: AgentBlock[] = []
    for (const b of message.content) {
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text })
      else if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking })
      else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> })
    }
    const stop =
      message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence'
        ? 'end'
        : message.stop_reason === 'tool_use'
          ? 'tool_use'
          : message.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : message.stop_reason === 'refusal'
              ? 'refusal'
              : message.stop_reason === 'pause_turn'
                ? 'pause'
                : 'other'
    const details = message.stop_details as { category?: string | null; explanation?: string | null } | null | undefined
    const usage = message.usage
    return {
      blocks,
      native: message.content,
      stop,
      stopDetail: stop === 'refusal' ? (details?.explanation ?? details?.category ?? 'The model declined this request.') : undefined,
      usage: {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0
      },
      servedBy: message.model !== req.model ? message.model : undefined
    }
  }
}
