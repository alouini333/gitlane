// Provider registry: credentials (encrypted on disk, or from the environment) and adapters.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelInfo, ProviderId, ProviderStatus } from '../../shared/agent'
import type { Credential, ProviderAdapter } from './adapter'
import { anthropicAdapter } from './anthropic'
import { geminiAdapter } from './gemini'
import { openAIAdapter } from './openai'

interface ProviderMeta {
  name: string
  description: string
  env: string[]
  baseUrl?: string
  keyUrl?: string
  needsKey: boolean
  needsBaseUrl: boolean
  oauth: boolean
  adapter: ProviderAdapter
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    name: 'Anthropic (Claude)',
    description: 'Claude models with an Anthropic API key.',
    env: ['ANTHROPIC_API_KEY'],
    keyUrl: 'https://platform.claude.com/settings/keys',
    needsKey: true,
    needsBaseUrl: false,
    oauth: false,
    adapter: anthropicAdapter
  },
  openai: {
    name: 'OpenAI',
    description: 'GPT and o-series models with an OpenAI API key.',
    env: ['OPENAI_API_KEY'],
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    needsBaseUrl: false,
    oauth: false,
    adapter: openAIAdapter('openai')
  },
  gemini: {
    name: 'Google Gemini',
    description: 'Gemini models with a Google AI Studio API key.',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keyUrl: 'https://aistudio.google.com/apikey',
    needsKey: true,
    needsBaseUrl: false,
    oauth: false,
    adapter: geminiAdapter
  },
  openrouter: {
    name: 'OpenRouter',
    description: 'One sign-in for Claude, Gemini, GPT, Llama, Mistral and hundreds more.',
    env: ['OPENROUTER_API_KEY'],
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
    needsBaseUrl: false,
    oauth: true,
    adapter: openAIAdapter('openrouter')
  },
  ollama: {
    name: 'Ollama (local)',
    description: 'Models running on this Mac. Nothing leaves your machine.',
    env: [],
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    needsBaseUrl: false,
    oauth: false,
    adapter: openAIAdapter('ollama')
  },
  custom: {
    name: 'OpenAI-compatible',
    description: 'Groq, Mistral, DeepSeek, Together, LM Studio, vLLM or any other compatible endpoint.',
    env: [],
    needsKey: false,
    needsBaseUrl: true,
    oauth: false,
    adapter: openAIAdapter('custom')
  }
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

export interface Cipher {
  available(): boolean
  encrypt(plain: string): string
  decrypt(stored: string): string
}

/** Credentials on disk, each encrypted with the OS keychain (Electron safeStorage). */
export class CredentialStore {
  #data: Partial<Record<ProviderId, string>>

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher
  ) {
    try {
      this.#data = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<ProviderId, string>>) : {}
    } catch {
      this.#data = {}
    }
  }

  get(id: ProviderId): Credential | null {
    const stored = this.#data[id]
    if (!stored) return null
    try {
      return JSON.parse(this.cipher.decrypt(stored)) as Credential
    } catch {
      return null
    }
  }

  set(id: ProviderId, cred: Credential) {
    if (!this.cipher.available()) throw new Error('Secure storage (Keychain) is unavailable, so the key cannot be saved. Set it as an environment variable instead.')
    this.#data[id] = this.cipher.encrypt(JSON.stringify(cred))
    this.#save()
  }

  delete(id: ProviderId) {
    delete this.#data[id]
    this.#save()
  }

  #save() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.#data, null, 2), { mode: 0o600 })
  }
}

export class ProviderRegistry {
  constructor(
    private readonly store: CredentialStore,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  /** Effective credential: stored first, then environment, then keyless local defaults. */
  credential(id: ProviderId): { cred: Credential; source: ProviderStatus['source']; envVar?: string } | null {
    const meta = PROVIDERS[id]
    const stored = this.store.get(id)
    if (stored) return { cred: { ...stored, baseUrl: stored.baseUrl || meta.baseUrl }, source: 'stored' }
    for (const v of meta.env) {
      const key = this.env[v]
      if (key) return { cred: { apiKey: key, baseUrl: meta.baseUrl }, source: 'env', envVar: v }
    }
    if (id === 'ollama') return { cred: { baseUrl: meta.baseUrl }, source: 'local' }
    return null
  }

  statuses(): ProviderStatus[] {
    return PROVIDER_IDS.map((id) => {
      const meta = PROVIDERS[id]
      const found = this.credential(id)
      return {
        id,
        name: meta.name,
        description: meta.description,
        // Ollama counts as available by default; listing models tells whether it's actually running.
        connected: !!found,
        source: found?.source ?? null,
        envVar: found?.envVar,
        baseUrl: found?.cred.baseUrl ?? meta.baseUrl,
        label: found?.cred.label,
        keyUrl: meta.keyUrl,
        needsKey: meta.needsKey,
        needsBaseUrl: meta.needsBaseUrl,
        oauth: meta.oauth
      }
    })
  }

  /** Save a credential after proving it works (by listing models). */
  async connect(id: ProviderId, cred: Credential): Promise<void> {
    const meta = PROVIDERS[id]
    const candidate: Credential = {
      apiKey: cred.apiKey?.trim() || undefined,
      baseUrl: cred.baseUrl?.trim().replace(/\/+$/, '') || meta.baseUrl,
      label: cred.label?.trim() || undefined
    }
    if (meta.needsKey && !candidate.apiKey) throw new Error('Enter an API key.')
    if (meta.needsBaseUrl && !candidate.baseUrl) throw new Error('Enter the endpoint URL (for example https://api.groq.com/openai/v1).')
    await meta.adapter.listModels(candidate)
    this.store.set(id, candidate)
  }

  disconnect(id: ProviderId) {
    this.store.delete(id)
  }

  saveVerified(id: ProviderId, cred: Credential) {
    this.store.set(id, cred)
  }

  async models(id: ProviderId): Promise<ModelInfo[]> {
    const found = this.credential(id)
    if (!found) throw new Error(`${PROVIDERS[id].name} is not connected.`)
    return PROVIDERS[id].adapter.listModels(found.cred)
  }

  adapter(id: ProviderId): ProviderAdapter {
    return PROVIDERS[id].adapter
  }
}
