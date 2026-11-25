import type { ApiResult, AppApi, Bridge, RepoApi } from '../../shared/types'

declare global {
  interface Window {
    bridge: Bridge
  }
}

function unwrap<T>(result: ApiResult<unknown>): T {
  if (result.ok) return result.value as T
  throw new Error(result.error)
}

/** App-level calls into the main process. */
export const app = new Proxy({} as AppApi, {
  get:
    (_target, method: string) =>
    async (...args: unknown[]) =>
      unwrap(await window.bridge.app(method, args))
})

const clients = new Map<string, RepoApi>()

/** Typed client for one repository; every call runs git in the main process. */
export function repoApi(path: string): RepoApi {
  let client = clients.get(path)
  if (!client) {
    client = new Proxy({} as RepoApi, {
      get:
        (_target, method: string) =>
        async (...args: unknown[]) =>
          unwrap(await window.bridge.repo(path, method, args))
    })
    clients.set(path, client)
  }
  return client
}
