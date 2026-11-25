// Live end-to-end check of the agent loop against a local Ollama model.
// Skipped unless GITLANE_LIVE_OLLAMA is set, e.g.:  GITLANE_LIVE_OLLAMA=llama3.2 npx vitest run tests/live-ollama.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent, Chat } from '../src/shared/agent'
import { AgentService, ChatStore } from '../src/main/ai/agent'
import { CredentialStore, ProviderRegistry } from '../src/main/ai/providers'
import { runGit } from '../src/main/git/runner'

const model = process.env.GITLANE_LIVE_OLLAMA

describe.skipIf(!model)('live agent loop (Ollama)', () => {
  it('lists models and completes a small task through tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlane-live-'))
    try {
      await runGit(dir, ['init', '-q'])
      writeFileSync(join(dir, 'config.json'), '{\n  "port": 3000\n}\n')
      const cipher = { available: () => true, encrypt: (s: string) => s, decrypt: (s: string) => s }
      const registry = new ProviderRegistry(new CredentialStore(join(dir, '.creds.json'), cipher), {})
      const models = await registry.models('ollama')
      expect(models.map((m) => m.id)).toContain(`${model}:latest`)

      const service = new AgentService(new ChatStore(join(dir, '.chats')), registry)
      const events: AgentEvent[] = []
      const chat = await service.newChat(dir, 'all')
      await service.send({ send: (e) => events.push(e) }, chat.id, 'Create a file named hello.txt whose content is exactly: hi from the agent', {
        provider: 'ollama',
        model: `${model}:latest`,
        effort: 'medium'
      })
      const saved = service.store.get(chat.id) as Chat
      const toolNames = saved.messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name))
      console.log('tools used:', toolNames.join(', '), '| errors:', events.filter((e) => e.type === 'error').map((e) => (e as { message: string }).message))
      for (const m of saved.messages)
        for (const b of m.blocks)
          if (b.type === 'tool_use' || b.type === 'tool_result') console.log(b.type, JSON.stringify(b.type === 'tool_use' ? b.input : b.content).slice(0, 200))
      console.log('final:', JSON.stringify(saved.messages.at(-1)?.blocks).slice(0, 300))
      expect(events.some((e) => e.type === 'error')).toBe(false)
      expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toContain('hi from the agent')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 240_000)
})
