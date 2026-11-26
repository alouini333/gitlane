// Update check state: asks the main process (which asks GitHub) whether a newer release exists.
import { create } from 'zustand'
import type { UpdateInfo } from '../../shared/types'
import { app } from './api'
import { useSettings } from './settings'
import { errorMessage } from './util'

const SKIP_KEY = 'gitlane.skippedVersion'
const EVERY_MS = 6 * 60 * 60 * 1000

interface UpdateState {
  /** This build's version. */
  version: string
  info: UpdateInfo | null
  checking: boolean
  /** Only set for checks the user asked for. */
  error: string | null
  dialogOpen: boolean
  /** A version the user chose to skip; the notice stays hidden for it. */
  skipped: string | null
}

function loadSkipped(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY)
  } catch {
    return null
  }
}

export const useUpdates = create<UpdateState>(() => ({
  version: '',
  info: null,
  checking: false,
  error: null,
  dialogOpen: false,
  skipped: loadSkipped()
}))

/** Show the toolbar notice: a newer release exists and the user hasn't skipped it. */
export const selectNotice = (s: UpdateState) => !!s.info?.available && s.info.latest !== s.skipped

export async function checkForUpdates(manual: boolean) {
  if (useUpdates.getState().checking) return
  useUpdates.setState({ checking: true, error: null })
  try {
    const info = await app.checkForUpdates()
    useUpdates.setState({ info, checking: false })
    if (manual && info.available) useUpdates.setState({ dialogOpen: true })
  } catch (e) {
    // Automatic checks fail quietly (offline, rate-limited); manual ones say why.
    useUpdates.setState({ checking: false, error: manual ? errorMessage(e) : null })
  }
}

export const openUpdateDialog = () => useUpdates.setState({ dialogOpen: true })
export const closeUpdateDialog = () => useUpdates.setState({ dialogOpen: false })

export function skipVersion(version: string) {
  try {
    localStorage.setItem(SKIP_KEY, version)
  } catch {
    /* storage unavailable */
  }
  useUpdates.setState({ skipped: version, dialogOpen: false })
}

let started = false

/** Load the version, then check shortly after startup and every few hours (if enabled in Preferences). */
export function startUpdateChecks() {
  if (started) return
  started = true
  app
    .version()
    .then((version) => useUpdates.setState({ version }))
    .catch(() => {})
  const auto = () => {
    if (useSettings.getState().checkUpdates) void checkForUpdates(false)
  }
  setTimeout(auto, 5_000)
  setInterval(auto, EVERY_MS)
}
