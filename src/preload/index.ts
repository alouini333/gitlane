import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent } from '../shared/agent'
import type { Bridge, RepoChangeEvent } from '../shared/types'

const bridge: Bridge = {
  app: (method, args) => ipcRenderer.invoke('app', method, args),
  repo: (path, method, args) => ipcRenderer.invoke('repo', path, method, args),
  onRepoChanged(cb) {
    const listener = (_e: IpcRendererEvent, event: RepoChangeEvent) => cb(event)
    ipcRenderer.on('repo-changed', listener)
    return () => ipcRenderer.removeListener('repo-changed', listener)
  },
  agent: (method, args) => ipcRenderer.invoke('agent', method, args),
  onAgentEvent(cb) {
    const listener = (_e: IpcRendererEvent, event: AgentEvent) => cb(event)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  terminal: {
    create: (opts) => ipcRenderer.invoke('term:create', opts),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('term:kill', id),
    onData(cb) {
      const listener = (_e: IpcRendererEvent, id: number, data: string) => cb(id, data)
      ipcRenderer.on('term:data', listener)
      return () => ipcRenderer.removeListener('term:data', listener)
    },
    onExit(cb) {
      const listener = (_e: IpcRendererEvent, id: number, code: number) => cb(id, code)
      ipcRenderer.on('term:exit', listener)
      return () => ipcRenderer.removeListener('term:exit', listener)
    }
  }
}

contextBridge.exposeInMainWorld('bridge', bridge)
