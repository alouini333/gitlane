// The agent loop: stream a turn, run requested tools (asking permission where needed), repeat.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentBlock,
  AgentEvent,
  AgentMessage,
  Chat,
  ChatSummary,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  SendOptions,
  ToolKind
} from '../../shared/agent'
import { runGit } from '../git/runner'
import { RetryableError, type TurnResult } from './adapter'
import type { ProviderRegistry } from './providers'
import { RepoTools, TOOLS, toolSpec, validateInput, type PreparedCall } from './tools'

const MAX_STEPS = 60

export interface AgentHost {
  send(event: AgentEvent): void
}

// ------------------------------------------------------------------ chat storage

const repoKey = (repo: string) => createHash('sha1').update(repo).digest('hex').slice(0, 16)

/** One JSON file per chat, grouped by repository. */
export class ChatStore {
  #cache = new Map<string, Chat>()

  constructor(private readonly dir: string) {}

  #file(id: string) {
    const [key] = id.split('_')
    return join(this.dir, key, `${id}.json`)
  }

  list(repo: string): ChatSummary[] {
    const dir = join(this.dir, repoKey(repo))
    if (!existsSync(dir)) return []
    const chats: ChatSummary[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const chat = this.get(f.slice(0, -5))
      if (chat) chats.push({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, provider: chat.provider, model: chat.model })
    }
    return chats.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Chat | null {
    const cached = this.#cache.get(id)
    if (cached) return cached
    try {
      const chat = JSON.parse(readFileSync(this.#file(id), 'utf8')) as Chat
      this.#cache.set(id, chat)
      return chat
    } catch {
      return null
    }
  }

  create(repo: string, system: string, mode: PermissionMode): Chat {
    const now = Date.now()
    const chat: Chat = {
      id: `${repoKey(repo)}_${randomUUID()}`,
      repo,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      provider: null,
      model: null,
      system,
      messages: [],
      mode,
      allowed: []
    }
    this.save(chat)
    return chat
  }

  save(chat: Chat) {
    chat.updatedAt = Date.now()
    this.#cache.set(chat.id, chat)
    const file = this.#file(chat.id)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(chat))
  }

  delete(id: string) {
    this.#cache.delete(id)
    rmSync(this.#file(id), { force: true })
  }
}

// ------------------------------------------------------------------ system prompt

/** Frozen per chat: the prompt prefix must stay identical for caching and preserved thinking. */
export async function systemPrompt(repo: string): Promise<string> {
  let branch = 'unknown'
  let changes = 0
  try {
    branch = (await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    changes = (await runGit(repo, ['--no-optional-locks', 'status', '--porcelain'])).split('\n').filter(Boolean).length
  } catch {
    /* empty repository */
  }
  const date = new Date().toISOString().slice(0, 10)
  return [
    'You are a coding agent working inside Gitlane, a desktop Git client, on the user’s repository.',
    `Repository: ${repo}`,
    `When this chat started (${date}), the checked-out branch was "${branch}" with ${changes} uncommitted file${changes === 1 ? '' : 's'}. Use git_status for the current state.`,
    `Platform: ${process.platform === 'darwin' ? 'macOS' : process.platform}. Commands run with the user's login shell in the repository root.`,
    '',
    'How to work:',
    '- Explore before changing: list_files and search to find code, read_file before editing it.',
    '- Make focused changes with edit_file; use write_file for new files. Paths are relative to the repository root.',
    '- Verify your work when it is cheap to do so (build, tests, linters) with run_command.',
    '- The user reviews and commits changes in Gitlane. Do not commit, push, rebase, reset or otherwise rewrite git history unless the user asks.',
    '- run_command has no interactive terminal: avoid commands that wait for input, and pass non-interactive flags.',
    '- If the user declines a tool call, respect that and adjust; ask when you need a decision only they can make.',
    '- Keep progress notes short. When you finish, summarize what you changed and anything left to do.'
  ].join('\n')
}

// ------------------------------------------------------------------ service

interface Pending {
  chatId: string
  resolve: (r: { decision: PermissionDecision; message?: string }) => void
}

export class AgentService {
  #runs = new Map<string, AbortController>()
  #pending = new Map<string, Pending>()

  constructor(
    readonly store: ChatStore,
    private readonly providers: ProviderRegistry
  ) {}

  isRunning(chatId: string) {
    return this.#runs.has(chatId)
  }

  async newChat(repo: string, mode: PermissionMode): Promise<Chat> {
    return this.store.create(repo, await systemPrompt(repo), mode)
  }

  setMode(chatId: string, mode: PermissionMode): Chat {
    const chat = this.#chat(chatId)
    chat.mode = mode
    this.store.save(chat)
    return chat
  }

  #chat(id: string): Chat {
    const chat = this.store.get(id)
    if (!chat) throw new Error('Chat not found.')
    return chat
  }

  async send(host: AgentHost, chatId: string, text: string, opts: SendOptions): Promise<void> {
    if (this.#runs.has(chatId)) throw new Error('The agent is already working in this chat.')
    const chat = this.#chat(chatId)
    const found = this.providers.credential(opts.provider)
    if (!found) throw new Error('Connect this provider first.')
    const controller = new AbortController()
    this.#runs.set(chatId, controller)
    host.send({ type: 'running', chatId, running: true })
    const emit = () => host.send({ type: 'chat', chat })
    try {
      repairDangling(chat)
      chat.messages.push({ role: 'user', blocks: [{ type: 'text', text }], createdAt: Date.now() })
      if (chat.title === 'New chat') chat.title = text.replace(/\s+/g, ' ').trim().slice(0, 70) || 'New chat'
      chat.provider = opts.provider
      chat.model = opts.model
      this.store.save(chat)
      emit()
      await this.#loop(host, chat, found.cred, opts, controller.signal, emit)
    } catch (e) {
      if (!controller.signal.aborted) host.send({ type: 'error', chatId, message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.#runs.delete(chatId)
      for (const [id, p] of this.#pending) if (p.chatId === chatId) this.respond(host, id, 'deny')
      if (repairDangling(chat, controller.signal.aborted ? 'Stopped by the user before this ran.' : undefined)) this.store.save(chat)
      host.send({ type: 'delta', chatId, kind: 'reset', text: '' })
      emit()
      host.send({ type: 'running', chatId, running: false })
    }
  }

  async #loop(
    host: AgentHost,
    chat: Chat,
    cred: import('./adapter').Credential,
    opts: SendOptions,
    signal: AbortSignal,
    emit: () => void
  ) {
    const adapter = this.providers.adapter(opts.provider)
    const tools = new RepoTools(chat.repo)
    for (let step = 0; step < MAX_STEPS; step++) {
      let result: TurnResult | undefined
      for (let attempt = 0; ; attempt++) {
        try {
          result = await adapter.turn(cred, {
            provider: opts.provider,
            model: opts.model,
            system: chat.system,
            messages: chat.messages,
            tools: TOOLS,
            effort: opts.effort,
            signal,
            onDelta: (kind, text) => host.send({ type: 'delta', chatId: chat.id, kind, text })
          })
          break
        } catch (e) {
          if (e instanceof RetryableError && attempt < 2 && !signal.aborted) {
            host.send({ type: 'delta', chatId: chat.id, kind: 'reset', text: '' })
            continue
          }
          throw e
        }
      }
      host.send({ type: 'delta', chatId: chat.id, kind: 'reset', text: '' })

      const message: AgentMessage = {
        role: 'assistant',
        blocks: result.blocks,
        native: result.native !== undefined ? { provider: opts.provider, model: opts.model, content: result.native } : undefined,
        provider: opts.provider,
        model: opts.model,
        servedBy: result.servedBy,
        usage: result.usage,
        createdAt: Date.now()
      }
      if (result.stop === 'refusal') message.notice = `The model declined to continue: ${result.stopDetail ?? 'no reason given'}.`
      const uses = result.blocks.filter((b): b is Extract<AgentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      if (result.stop === 'max_tokens' && !uses.length) message.notice = 'The response reached the output limit and was cut off.'
      if (result.stop === 'other' && result.stopDetail) message.notice = result.stopDetail
      chat.messages.push(message)
      this.store.save(chat)
      emit()

      // Never run tools from a refused turn: the tool input may be incomplete.
      if (result.stop === 'refusal') return
      if (result.stop === 'pause') continue
      if (!uses.length) return

      const results: AgentBlock[] = []
      for (const use of uses) {
        if (signal.aborted) break
        if (result.stop === 'max_tokens') {
          results.push({
            type: 'tool_result',
            toolUseId: use.id,
            isError: true,
            content: 'This tool call was cut off by the output limit, so it was not run. Retry with a smaller input (for example several smaller edit_file calls).'
          })
          continue
        }
        results.push(await this.#runTool(host, chat, tools, use, signal, emit))
      }
      if (results.length) {
        chat.messages.push({ role: 'user', blocks: results, createdAt: Date.now() })
        repairDangling(chat, 'Stopped by the user before this ran.')
        this.store.save(chat)
        emit()
      }
      if (signal.aborted) return
    }
    const last = chat.messages[chat.messages.length - 1]
    if (last) last.notice = `Stopped after ${MAX_STEPS} steps. Send a message to let the agent continue.`
  }

  async #runTool(
    host: AgentHost,
    chat: Chat,
    tools: RepoTools,
    use: Extract<AgentBlock, { type: 'tool_use' }>,
    signal: AbortSignal,
    emit: () => void
  ): Promise<AgentBlock> {
    const result = (content: string, isError: boolean, extra: Partial<Extract<AgentBlock, { type: 'tool_result' }>> = {}): AgentBlock => ({
      type: 'tool_result',
      toolUseId: use.id,
      content,
      isError,
      ...extra
    })
    const invalid = validateInput(toolSpec(use.name), use.input)
    if (invalid) return result(JSON.stringify({ INVALID_INPUT: invalid }), true, { title: use.name })
    const prepared = tools.prepare(use.name, use.input)
    if (prepared.error) return result(prepared.error, true, { title: prepared.title })

    if (this.#needsApproval(chat, prepared.kind)) {
      host.send({ type: 'tool', chatId: chat.id, toolUseId: use.id, state: 'waiting' })
      const answer = await this.#ask(host, chat, use, prepared, signal)
      if (answer.decision === 'deny') {
        const why = answer.message?.trim() ? ` They said: ${answer.message.trim()}` : ''
        return result(`The user declined this action.${why}`, true, { title: prepared.title, display: prepared.preview })
      }
      if (answer.decision === 'allow-always' && !chat.allowed.includes(prepared.kind)) {
        chat.allowed.push(prepared.kind)
        this.store.save(chat)
        emit()
      }
    }
    host.send({ type: 'tool', chatId: chat.id, toolUseId: use.id, state: 'running' })
    try {
      const outcome = await prepared.run(signal)
      return result(outcome.content, outcome.isError, { title: prepared.title, display: outcome.display ?? prepared.preview })
    } catch (e) {
      return result(e instanceof Error ? e.message : String(e), true, { title: prepared.title })
    } finally {
      host.send({ type: 'tool', chatId: chat.id, toolUseId: use.id, state: 'done' })
    }
  }

  #needsApproval(chat: Chat, kind: ToolKind): boolean {
    if (kind === 'read' || chat.mode === 'all' || chat.allowed.includes(kind)) return false
    return !(chat.mode === 'edits' && kind === 'edit')
  }

  #ask(host: AgentHost, chat: Chat, use: { id: string; name: string }, prepared: PreparedCall, signal: AbortSignal) {
    return new Promise<{ decision: PermissionDecision; message?: string }>((resolve) => {
      if (signal.aborted) return resolve({ decision: 'deny' })
      const request: PermissionRequest = {
        id: randomUUID(),
        chatId: chat.id,
        toolUseId: use.id,
        tool: use.name,
        kind: prepared.kind,
        title: prepared.title,
        preview: prepared.preview
      }
      this.#pending.set(request.id, { chatId: chat.id, resolve })
      signal.addEventListener('abort', () => this.respond(host, request.id, 'deny'), { once: true })
      host.send({ type: 'permission', request })
    })
  }

  respond(host: AgentHost, requestId: string, decision: PermissionDecision, message?: string) {
    const pending = this.#pending.get(requestId)
    if (!pending) return
    this.#pending.delete(requestId)
    host.send({ type: 'permission-resolved', chatId: pending.chatId, id: requestId })
    pending.resolve({ decision, message })
  }

  stop(chatId: string) {
    this.#runs.get(chatId)?.abort()
  }
}

/**
 * Every tool_use needs a matching tool_result before the next request. If a turn was interrupted,
 * answer the unanswered calls with an error so the chat can continue. Returns true if it changed anything.
 */
export function repairDangling(chat: Chat, reason = 'Interrupted before this ran.'): boolean {
  let changed = false
  for (let k = 0; k < chat.messages.length; k++) {
    const m = chat.messages[k]
    if (m.role !== 'assistant') continue
    const ids = m.blocks.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id)
    if (!ids.length) continue
    const next = chat.messages[k + 1]
    const answered = new Set(
      next?.role === 'user' ? next.blocks.filter((b) => b.type === 'tool_result').map((b) => (b as { toolUseId: string }).toolUseId) : []
    )
    const missing = ids.filter((id) => !answered.has(id))
    if (!missing.length) continue
    const blocks: Extract<AgentBlock, { type: 'tool_result' }>[] = missing.map((id) => ({ type: 'tool_result', toolUseId: id, content: reason, isError: true }))
    if (next?.role === 'user' && next.blocks.every((b) => b.type === 'tool_result')) next.blocks.push(...blocks)
    else chat.messages.splice(k + 1, 0, { role: 'user', blocks, createdAt: Date.now() })
    changed = true
  }
  return changed
}
