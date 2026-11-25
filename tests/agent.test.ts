import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentMessage, Chat, PermissionRequest } from '../src/shared/agent'
import type { ProviderAdapter, TurnRequest, TurnResult } from '../src/main/ai/adapter'
import { readSSE } from '../src/main/ai/adapter'
import { AgentService, ChatStore, repairDangling } from '../src/main/ai/agent'
import { buildAnthropicParams, toAnthropicMessages } from '../src/main/ai/anthropic'
import { lineDiff } from '../src/main/ai/diff'
import { geminiAdapter, toGeminiContents } from '../src/main/ai/gemini'
import { setAiFetch } from '../src/main/ai/http'
import { openAIAdapter, toOpenAIMessages } from '../src/main/ai/openai'
import { CredentialStore, ProviderRegistry, type Cipher } from '../src/main/ai/providers'
import { RepoTools, TOOLS } from '../src/main/ai/tools'
import { runGit } from '../src/main/git/runner'

let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gitlane-agent-'))
  await runGit(dir, ['init', '-q'])
  writeFileSync(join(dir, 'app.ts'), 'const a = 1\nconst b = 2\nexport { a, b }\n')
  writeFileSync(join(dir, 'README.md'), '# Demo\nhello world\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200 })

describe('lineDiff', () => {
  it('produces hunks with counts', () => {
    const d = lineDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n')
    expect(d.additions).toBe(2)
    expect(d.deletions).toBe(1)
    expect(d.patch.split('\n')).toEqual(['@@ -1,5 +1,6 @@', ' a', '-b', '+B', ' c', ' d', '+e', ' '])
    expect(lineDiff('', 'x\ny').patch).toBe('@@ -0,0 +1,2 @@\n+x\n+y')
  })
})

describe('RepoTools', () => {
  it('reads, searches, lists and edits inside the repository', async () => {
    const tools = new RepoTools(dir)
    const ctrl = new AbortController()
    const read = await tools.prepare('read_file', { path: 'app.ts' }).run(ctrl.signal)
    expect(read.content).toContain('     1\tconst a = 1')
    const found = await tools.prepare('search', { pattern: 'const b' }).run(ctrl.signal)
    expect(found.content).toBe('app.ts:2:const b = 2')
    const listed = await tools.prepare('list_files', {}).run(ctrl.signal)
    expect(listed.content.split('\n')).toEqual(['README.md', 'app.ts'])

    const edit = tools.prepare('edit_file', { path: 'app.ts', old_string: 'const b = 2', new_string: 'const b = 3' })
    expect(edit.kind).toBe('edit')
    expect(edit.preview).toMatchObject({ kind: 'diff', additions: 1, deletions: 1 })
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('const b = 2') // nothing written until run
    await edit.run(ctrl.signal)
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('const b = 3')

    const created = await tools.prepare('write_file', { path: 'src/new.ts', content: 'x\n' }).run(ctrl.signal)
    expect(created.display).toMatchObject({ kind: 'diff', created: true })
    expect(readFileSync(join(dir, 'src/new.ts'), 'utf8')).toBe('x\n')
  })

  it('rejects ambiguous or missing edits before asking anyone', () => {
    const tools = new RepoTools(dir)
    expect(tools.prepare('edit_file', { path: 'app.ts', old_string: 'const', new_string: 'let' }).error).toMatch(/matches 2 places/)
    expect(tools.prepare('edit_file', { path: 'app.ts', old_string: 'nope', new_string: 'x' }).error).toMatch(/not found/)
  })

  it('keeps every path inside the repository', () => {
    const tools = new RepoTools(dir)
    expect(tools.prepare('read_file', { path: '../../etc/passwd' }).error).toMatch(/outside the repository/)
    expect(tools.prepare('read_file', { path: '/etc/hosts' }).error).toMatch(/outside the repository/)
    symlinkSync('/etc', join(dir, 'escape'))
    expect(tools.prepare('read_file', { path: 'escape/hosts' }).error).toMatch(/outside the repository/)
    expect(tools.prepare('write_file', { path: '.git/config', content: '' }).error).toMatch(/inside .git/)
  })

  it('runs commands with exit codes, timeouts and output', async () => {
    const tools = new RepoTools(dir)
    const ctrl = new AbortController()
    const okRun = await tools.prepare('run_command', { command: 'echo hi && pwd' }).run(ctrl.signal)
    expect(okRun.isError).toBe(false)
    expect(okRun.content).toContain('hi')
    const bad = await tools.prepare('run_command', { command: 'exit 3' }).run(ctrl.signal)
    expect(bad).toMatchObject({ isError: true, display: { kind: 'command', exitCode: 3 } })
    const slow = await tools.prepare('run_command', { command: 'sleep 5', timeout_seconds: 1 }).run(ctrl.signal)
    expect(slow.content).toMatch(/Timed out after 1s/)
  }, 15_000)
})

// ------------------------------------------------------------------ providers

describe('provider message conversion', () => {
  const history: AgentMessage[] = [
    { role: 'user', blocks: [{ type: 'text', text: 'fix it' }], createdAt: 1 },
    {
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'call.1', name: 'read_file', input: { path: 'a' } }
      ],
      native: { provider: 'anthropic', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } }] },
      createdAt: 2
    },
    { role: 'user', blocks: [{ type: 'tool_result', toolUseId: 'call.1', content: 'data', isError: false }], createdAt: 3 }
  ]

  it('anthropic: replays native content for the same model, strips thinking after a switch', () => {
    const same = toAnthropicMessages(history, 'claude-opus-5-5')
    expect((same[1].content as { type: string }[]).map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(same[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: 'data', is_error: false }])
    const switched = toAnthropicMessages(history, 'claude-sonnet-5-5')
    expect((switched[1].content as { type: string }[]).map((b) => b.type)).toEqual(['text', 'tool_use'])
  })

  it('anthropic: caching, adaptive thinking, effort and fallbacks on current models only', () => {
    const req = { provider: 'anthropic', model: 'claude-opus-5-5', system: 'S', messages: history, tools: TOOLS, effort: 'high' } as unknown as TurnRequest
    const p = buildAnthropicParams(req)
    expect(p.system).toEqual([{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }])
    expect(p.cache_control).toEqual({ type: 'ephemeral' })
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(p.output_config).toEqual({ effort: 'high' })
    expect(p.fallbacks).toBe('default')
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(p.tools?.every((t) => (t as { eager_input_streaming?: boolean }).eager_input_streaming)).toBe(true)
    const old = buildAnthropicParams({ ...req, model: 'claude-haiku-4-5' })
    expect(old.thinking).toBeUndefined()
    expect(old.output_config).toBeUndefined()
    expect(old.fallbacks).toBeUndefined()
  })

  it('openai: system first, tool_calls and tool messages', () => {
    expect(toOpenAIMessages('S', history)).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'call.1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'call.1', content: 'data' }
    ])
  })

  it('gemini: replays native parts (thought signatures) and names function responses', () => {
    const g: AgentMessage[] = [
      history[0],
      {
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'gemini_1', name: 'read_file', input: { path: 'a' } }],
        native: { provider: 'gemini', model: 'gemini-x', content: [{ functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'SIG' }] },
        createdAt: 2
      },
      { role: 'user', blocks: [{ type: 'tool_result', toolUseId: 'gemini_1', content: 'data', isError: false }], createdAt: 3 }
    ]
    expect(toGeminiContents(g, 'gemini-x')).toEqual([
      { role: 'user', parts: [{ text: 'fix it' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'SIG' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { result: 'data' } } }] }
    ])
  })
})

describe('streaming adapters (mocked HTTP)', () => {
  const base = { provider: 'openai', model: 'm', system: 'S', messages: [], tools: TOOLS, effort: 'high', signal: new AbortController().signal } as unknown as TurnRequest

  it('openai: streams text and assembles tool calls split across chunks', async () => {
    const deltas: string[] = []
    setAiFetch(async () =>
      sse([
        { choices: [{ delta: { content: 'Let me ' } }] },
        { choices: [{ delta: { content: 'look.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'read_', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        '[DONE]'
      ])
    )
    const r = await openAIAdapter('openai').turn({ apiKey: 'k', baseUrl: 'https://x/v1' }, { ...base, onDelta: (_k, t) => deltas.push(t) })
    expect(deltas.join('')).toBe('Let me look.')
    expect(r.stop).toBe('tool_use')
    expect(r.blocks).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'call_9', name: 'read_file', input: { path: 'a.ts' } }
    ])
    expect(r.usage).toEqual({ input: 10, output: 5 })
  })

  it('gemini: keeps raw parts for replay and maps finish reasons', async () => {
    setAiFetch(async () =>
      sse([
        { candidates: [{ content: { parts: [{ text: 'Planning', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { pattern: 'x' } }, thoughtSignature: 'S1' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }
      ])
    )
    const r = await geminiAdapter.turn({ apiKey: 'k' }, { ...base, provider: 'gemini', onDelta: () => undefined })
    expect(r.stop).toBe('tool_use')
    expect(r.blocks[0]).toEqual({ type: 'thinking', text: 'Planning' })
    expect(r.blocks[1]).toMatchObject({ type: 'tool_use', name: 'search', input: { pattern: 'x' } })
    expect((r.native as unknown[])[1]).toEqual({ functionCall: { name: 'search', args: { pattern: 'x' } }, thoughtSignature: 'S1' })
  })

  it('parses SSE split across network chunks', async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"a"'))
        c.enqueue(enc.encode(':1}\n\nevent: x\ndata: two\n\n'))
        c.close()
      }
    })
    const got: string[] = []
    await readSSE(new Response(body), (d, e) => got.push(`${e ?? '-'}:${d}`))
    expect(got).toEqual(['-:{"a":1}', 'x:two'])
  })
})

describe('credentials', () => {
  const cipher: Cipher = { available: () => true, encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() }

  it('encrypts stored keys and prefers them over the environment', () => {
    const file = join(dir, 'creds.json')
    const store = new CredentialStore(file, cipher)
    const reg = new ProviderRegistry(store, { OPENAI_API_KEY: 'env-key', GEMINI_API_KEY: 'g' })
    expect(reg.credential('openai')).toMatchObject({ source: 'env', envVar: 'OPENAI_API_KEY', cred: { apiKey: 'env-key' } })
    store.set('openai', { apiKey: 'sk-secret' })
    expect(readFileSync(file, 'utf8')).not.toContain('sk-secret')
    expect(reg.credential('openai')).toMatchObject({ source: 'stored', cred: { apiKey: 'sk-secret', baseUrl: 'https://api.openai.com/v1' } })
    expect(reg.credential('ollama')?.source).toBe('local')
    expect(reg.credential('anthropic')).toBeNull()
    expect(new CredentialStore(file, cipher).get('openai')).toEqual({ apiKey: 'sk-secret' })
  })

  it('explains that a "claude setup-token" token is not an API key, without calling the API', async () => {
    const store = new CredentialStore(join(dir, 'creds.json'), cipher)
    const reg = new ProviderRegistry(store, {})
    await expect(reg.connect('anthropic', { apiKey: ' sk-ant-oat01-abc ' })).rejects.toThrow(/claude setup-token.*not an API key/)
    expect(store.get('anthropic')).toBeNull()
  })
})

// ------------------------------------------------------------------ agent loop

/** A scripted model: each call returns the next turn. */
function scripted(turns: ((req: TurnRequest) => TurnResult)[]): ProviderAdapter & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = []
  return {
    requests,
    listModels: async () => [],
    turn: async (_c, req) => {
      requests.push({ ...req, messages: structuredClone(req.messages) })
      const next = turns.shift()
      if (!next) throw new Error('no more turns')
      return next(req)
    }
  }
}

function setup(adapter: ProviderAdapter) {
  const cipher: Cipher = { available: () => true, encrypt: (s) => s, decrypt: (s) => s }
  const registry = new ProviderRegistry(new CredentialStore(join(dir, '.creds.json'), cipher), { OPENAI_API_KEY: 'k' })
  registry.adapter = () => adapter
  const service = new AgentService(new ChatStore(join(dir, '.chats')), registry)
  const events: AgentEvent[] = []
  const host = {
    send: (e: AgentEvent) => {
      events.push(e)
      if (e.type === 'permission') onPermission?.(e.request)
    }
  }
  let onPermission: ((r: PermissionRequest) => void) | undefined
  return { service, events, host, setPermissionHandler: (fn: (r: PermissionRequest) => void) => (onPermission = fn) }
}

const opts = { provider: 'openai' as const, model: 'm', effort: 'high' as const }
const editCall = (id: string): TurnResult => ({
  blocks: [{ type: 'tool_use', id, name: 'edit_file', input: { path: 'app.ts', old_string: 'const a = 1', new_string: 'const a = 10' } }],
  stop: 'tool_use'
})

describe('AgentService', () => {
  it('runs read tools freely, asks before edits, then finishes', async () => {
    const adapter = scripted([
      () => ({ blocks: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'app.ts' } }], stop: 'tool_use' }),
      () => editCall('t2'),
      () => ({ blocks: [{ type: 'text', text: 'Done: a is 10.' }], stop: 'end' })
    ])
    const { service, events, host, setPermissionHandler } = setup(adapter)
    const asked: PermissionRequest[] = []
    setPermissionHandler((r) => {
      asked.push(r)
      service.respond(host, r.id, 'allow')
    })
    const chat = await service.newChat(dir, 'ask')
    await service.send(host, chat.id, 'set a to 10', opts)

    expect(asked.map((r) => r.tool)).toEqual(['edit_file'])
    expect(asked[0].preview).toMatchObject({ kind: 'diff', path: 'app.ts' })
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('const a = 10')
    const final = service.store.get(chat.id) as Chat
    expect(final.title).toBe('set a to 10')
    expect(final.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(adapter.requests[1].messages.at(-1)?.blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 't1', isError: false })
    expect(events.filter((e) => e.type === 'running').map((e) => (e as { running: boolean }).running)).toEqual([true, false])
  })

  it('passes a denial (with the user’s reason) back to the model', async () => {
    const adapter = scripted([() => editCall('t1'), () => ({ blocks: [{ type: 'text', text: 'OK, leaving it.' }], stop: 'end' })])
    const { service, host, setPermissionHandler } = setup(adapter)
    setPermissionHandler((r) => service.respond(host, r.id, 'deny', 'keep a at 1'))
    const chat = await service.newChat(dir, 'ask')
    await service.send(host, chat.id, 'change a', opts)
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('const a = 1\n')
    expect(adapter.requests[1].messages.at(-1)?.blocks[0]).toMatchObject({ isError: true, content: 'The user declined this action. They said: keep a at 1' })
  })

  it('"allow always" and auto-edit mode skip later prompts for that kind', async () => {
    const adapter = scripted([() => editCall('t1'), () => ({ ...editCall('t2'), blocks: [{ type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'b.ts', content: 'b' } }] }), () => ({ blocks: [{ type: 'text', text: 'ok' }], stop: 'end' })])
    const { service, host, setPermissionHandler } = setup(adapter)
    let prompts = 0
    setPermissionHandler((r) => {
      prompts++
      service.respond(host, r.id, 'allow-always')
    })
    const chat = await service.newChat(dir, 'ask')
    await service.send(host, chat.id, 'go', opts)
    expect(prompts).toBe(1)
    expect((service.store.get(chat.id) as Chat).allowed).toEqual(['edit'])
  })

  it('stopping while a permission is pending leaves a valid history', async () => {
    const adapter = scripted([() => editCall('t1')])
    const { service, host, setPermissionHandler } = setup(adapter)
    const chat = await service.newChat(dir, 'ask')
    setPermissionHandler(() => setTimeout(() => service.stop(chat.id), 10))
    await service.send(host, chat.id, 'go', opts)
    const saved = service.store.get(chat.id) as Chat
    expect(saved.messages.at(-1)).toMatchObject({ role: 'user', blocks: [{ type: 'tool_result', toolUseId: 't1', isError: true }] })
    expect(service.isRunning(chat.id)).toBe(false)
  })

  it('never runs tools from a refused or truncated turn', async () => {
    const adapter = scripted([
      () => ({ ...editCall('t1'), stop: 'max_tokens' }),
      () => ({ ...editCall('t2'), stop: 'refusal', stopDetail: 'cyber' })
    ])
    const { service, host, setPermissionHandler } = setup(adapter)
    setPermissionHandler((r) => service.respond(host, r.id, 'allow'))
    const chat = await service.newChat(dir, 'all')
    await service.send(host, chat.id, 'go', opts)
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('const a = 1\n')
    const saved = service.store.get(chat.id) as Chat
    expect(saved.messages[2].blocks[0]).toMatchObject({ isError: true, content: expect.stringMatching(/cut off/) })
    expect(saved.messages[3].notice).toMatch(/declined/)
    expect(saved.messages.at(-1)?.role).toBe('user') // refused tool call answered with an error
  })

  it('repairs dangling tool calls', () => {
    const chat = { messages: [{ role: 'assistant', blocks: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }], createdAt: 0 }] } as unknown as Chat
    expect(repairDangling(chat)).toBe(true)
    expect(chat.messages[1].blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 'x', isError: true })
    expect(repairDangling(chat)).toBe(false)
  })
})
