// fetch used by the provider adapters; the main process swaps in Electron's net.fetch (system proxy).
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

let impl: FetchFn = (url, init) => fetch(url, init)

export const aiFetch: FetchFn = (url, init) => impl(url, init)

export function setAiFetch(fn: FetchFn) {
  impl = fn
}
