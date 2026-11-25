// "Sign in with OpenRouter": OAuth PKCE with a one-shot loopback callback. Returns a user-controlled API key.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { aiFetch } from './http'

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px -apple-system,sans-serif;background:#1c1f26;color:#d6dbe4;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`

export async function signInWithOpenRouter(openBrowser: (url: string) => Promise<void>, timeoutMs = 5 * 60_000): Promise<string> {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const nonce = b64url(randomBytes(12))
  const servers: Server[] = []

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sign-in timed out. Try again.')), timeoutMs)
    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== `/callback/${nonce}`) {
        res.writeHead(404).end()
        return
      }
      const value = url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(value ? PAGE('Connected to Gitlane', 'You can close this tab and go back to Gitlane.') : PAGE('Sign-in cancelled', 'No authorization code was returned.'))
      clearTimeout(timer)
      if (value) resolve(value)
      else reject(new Error('Sign-in was cancelled.'))
    }
    // Loopback only: IPv4 picks the port, IPv6 joins on the same port so "localhost" works either way.
    const v4 = createServer(handler)
    servers.push(v4)
    v4.once('error', reject)
    v4.listen(0, '127.0.0.1', () => {
      const { port } = v4.address() as AddressInfo
      const v6 = createServer(handler)
      v6.once('error', () => undefined)
      v6.listen(port, '::1', () => undefined)
      servers.push(v6)
      const callback = `http://localhost:${port}/callback/${nonce}`
      const url = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`
      openBrowser(url).catch(reject)
    })
  }).finally(() => servers.forEach((s) => s.close()))

  const res = await aiFetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' })
  })
  if (!res.ok) throw new Error(`OpenRouter did not issue a key (${res.status}).`)
  const json = (await res.json()) as { key?: string }
  if (!json.key) throw new Error('OpenRouter did not return a key.')
  return json.key
}
