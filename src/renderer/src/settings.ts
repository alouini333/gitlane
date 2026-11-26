// User preferences, persisted in the app profile (localStorage).
import { create } from 'zustand'
import type { DirtyPolicy } from '../../shared/types'

export type DirtySwitchSetting = DirtyPolicy | 'ask'
export type RemoteDoubleClick = 'reset' | 'ff' | 'checkout'

export interface Settings {
  /** What happens to uncommitted changes when switching branches. */
  dirtySwitch: DirtySwitchSetting
  /** What double-clicking a remote branch (origin/dev) does when a local branch already exists. */
  remoteDoubleClick: RemoteDoubleClick
  /** Preferred terminal font family ('' = default stack). */
  terminalFont: string
  terminalFontSize: number
  /** Look for a newer release on GitHub at startup and every few hours. */
  checkUpdates: boolean
}

const KEY = 'gitlane.settings'
const DEFAULTS: Settings = { dirtySwitch: 'stash', remoteDoubleClick: 'reset', terminalFont: '', terminalFontSize: 12, checkUpdates: true }
const DIRTY: DirtySwitchSetting[] = ['stash', 'stash-reapply', 'carry', 'ask']
const REMOTE: RemoteDoubleClick[] = ['reset', 'ff', 'checkout']

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>
    return {
      dirtySwitch: DIRTY.includes(saved.dirtySwitch as DirtySwitchSetting) ? saved.dirtySwitch! : DEFAULTS.dirtySwitch,
      remoteDoubleClick: REMOTE.includes(saved.remoteDoubleClick as RemoteDoubleClick) ? saved.remoteDoubleClick! : DEFAULTS.remoteDoubleClick,
      terminalFont: typeof saved.terminalFont === 'string' ? saved.terminalFont : DEFAULTS.terminalFont,
      terminalFontSize:
        typeof saved.terminalFontSize === 'number' && saved.terminalFontSize >= 8 && saved.terminalFontSize <= 32
          ? saved.terminalFontSize
          : DEFAULTS.terminalFontSize,
      checkUpdates: typeof saved.checkUpdates === 'boolean' ? saved.checkUpdates : DEFAULTS.checkUpdates
    }
  } catch {
    return DEFAULTS
  }
}

export const useSettings = create<Settings & { open: boolean }>(() => ({ ...load(), open: false }))

export function updateSettings(patch: Partial<Settings>) {
  useSettings.setState(patch)
  const { dirtySwitch, remoteDoubleClick, terminalFont, terminalFontSize, checkUpdates } = useSettings.getState()
  try {
    localStorage.setItem(KEY, JSON.stringify({ dirtySwitch, remoteDoubleClick, terminalFont, terminalFontSize, checkUpdates }))
  } catch {
    /* storage unavailable */
  }
}

export const openSettings = () => useSettings.setState({ open: true })
export const closeSettings = () => useSettings.setState({ open: false })
