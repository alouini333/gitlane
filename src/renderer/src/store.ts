import { create } from 'zustand'
import type {
  CommitDetails,
  DiffTarget,
  FileDiff,
  PrDetail,
  PrFile,
  PrFilter,
  PrListResult,
  PrListState,
  PullRequest,
  RepoApi,
  RepoSnapshot
} from '../../shared/types'
import { app, repoApi } from './api'
import type { GitHubData } from './github'
import { errorMessage, hasChanges } from './util'

export type Selection = { kind: 'wip' } | { kind: 'commit'; sha: string; stash?: boolean } | null

export interface MenuItem {
  label?: string
  action?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

export interface DialogField {
  key: string
  label?: string
  placeholder?: string
  initial?: string
  multiline?: boolean
  options?: string[]
}

export interface DialogSpec {
  title: string
  message?: string
  fields?: DialogField[]
  checkbox?: { label: string; initial?: boolean }
  confirmLabel?: string
  danger?: boolean
}

export interface DialogResult {
  values: Record<string, string>
  checked: boolean
}

export interface Toast {
  id: number
  kind: 'error' | 'success' | 'info'
  text: string
}

export interface DiffState {
  target: DiffTarget
  data: FileDiff | null
  error: string | null
}

export interface GitHubState extends GitHubData {
  /** Why open pull requests couldn't be loaded, if they couldn't. */
  error: string | null
  loadedAt: number
}

export interface CommitPrsEntry {
  loading: boolean
  prs: PullRequest[]
  notice?: string
  error?: string
}

export type PrTab = 'conversation' | 'commits' | 'checks' | 'files'

export interface Loadable<T> {
  loading: boolean
  data: T | null
  error: string | null
}

export interface PrListStore {
  filter: PrFilter
  state: PrListState
  loading: boolean
  result: PrListResult | null
  error: string | null
  loadedAt: number
}

export interface PickerOption {
  key: string
  label: string
  detail?: string
  avatarUrl?: string
  color?: string
}

export interface PickerSpec {
  title: string
  x: number
  y: number
  selected: string[]
  /** Options for a search query ('' for the initial list). */
  load: (query: string) => Promise<PickerOption[]>
  onApply: (added: string[], removed: string[]) => void
}

export interface Draft {
  summary: string
  description: string
  amend: boolean
}

interface State {
  repoPath: string | null
  recent: string[]
  snap: RepoSnapshot | null
  limit: number
  selection: Selection
  details: CommitDetails | null
  diff: DiffState | null
  busy: string | null
  draft: Draft
  toasts: Toast[]
  menu: { x: number; y: number; items: MenuItem[] } | null
  dialog: (DialogSpec & { resolve: (r: DialogResult | null) => void }) | null
  scrollRequest: { sha: string; n: number } | null
  /** null until loaded; info is null when the repo has no GitHub remote. */
  github: GitHubState | null
  commitPrs: Record<string, CommitPrsEntry>
  prList: PrListStore
  prView: { number: number; tab: PrTab } | null
  prDetails: Record<number, Loadable<PrDetail>>
  prFiles: Record<number, Loadable<PrFile[]>>
  picker: PickerSpec | null
}

const PAGE = 2000
const emptyDraft: Draft = { summary: '', description: '', amend: false }

function savedPrFilter(): PrFilter {
  try {
    const v = localStorage.getItem('gitlane.prFilter')
    if (v === 'review-requested' || v === 'assigned' || v === 'created' || v === 'involves' || v === 'all') return v
  } catch {
    /* storage unavailable */
  }
  return 'all'
}

const emptyPrList = (): PrListStore => ({ filter: savedPrFilter(), state: 'open', loading: false, result: null, error: null, loadedAt: 0 })
const noPrs = () => ({ prList: emptyPrList(), prView: null, prDetails: {}, prFiles: {}, picker: null })

export const useStore = create<State>(() => ({
  repoPath: null,
  recent: [],
  snap: null,
  limit: PAGE,
  selection: null,
  details: null,
  diff: null,
  busy: null,
  draft: emptyDraft,
  toasts: [],
  menu: null,
  dialog: null,
  scrollRequest: null,
  github: null,
  commitPrs: {},
  ...noPrs()
}))

const set = useStore.setState
const get = useStore.getState

// ------------------------------------------------------------------ toasts, menus, dialogs

let toastId = 0
export function toast(kind: Toast['kind'], text: string) {
  const id = ++toastId
  set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }))
  setTimeout(() => dismissToast(id), kind === 'error' ? 12000 : 4000)
}

export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function showMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.()
  set({ menu: { x: e.clientX, y: e.clientY, items } })
}

export const closeMenu = () => set({ menu: null })

export function ask(spec: DialogSpec): Promise<DialogResult | null> {
  get().dialog?.resolve(null)
  return new Promise((resolve) => set({ dialog: { ...spec, resolve } }))
}

export async function confirm(spec: Omit<DialogSpec, 'fields' | 'checkbox'>): Promise<boolean> {
  return (await ask(spec)) !== null
}

export function closeDialog(result: DialogResult | null) {
  const dialog = get().dialog
  set({ dialog: null })
  dialog?.resolve(result)
}

// ------------------------------------------------------------------ repository lifecycle

export async function loadRecent() {
  set({ recent: await app.recentRepos() })
}

/** Open a repository. `quiet` skips the error toast (used when restoring the last repo at startup). */
export async function openRepo(path: string, quiet = false) {
  try {
    const root = await app.openRepo(path)
    set({
      repoPath: root,
      snap: null,
      selection: null,
      details: null,
      diff: null,
      limit: PAGE,
      draft: emptyDraft,
      github: null,
      commitPrs: {},
      ...noPrs()
    })
    document.title = `${root.split('/').pop()} — Gitlane`
    await refresh('all')
    void loadGitHub(true)
  } catch (e) {
    if (!quiet) toast('error', errorMessage(e))
  }
  void loadRecent()
}

export function closeRepo() {
  set({ repoPath: null, snap: null, selection: null, details: null, diff: null, github: null, commitPrs: {}, ...noPrs() })
  document.title = 'Gitlane'
  void loadRecent()
}

// ------------------------------------------------------------------ refreshing

type RefreshKind = 'status' | 'all'
let refreshing = false
let pendingKind: RefreshKind | null = null
let waiters: (() => void)[] = []

/** Reload repository data. Calls made while a refresh runs are coalesced into one more run. */
export function refresh(kind: RefreshKind = 'all'): Promise<void> {
  pendingKind = pendingKind === 'all' || kind === 'all' ? 'all' : 'status'
  const done = new Promise<void>((resolve) => waiters.push(resolve))
  if (!refreshing) void refreshLoop()
  return done
}

async function refreshLoop() {
  refreshing = true
  while (pendingKind) {
    const kind = pendingKind
    const batch = waiters
    pendingKind = null
    waiters = []
    try {
      await loadSnapshot(kind)
    } catch (e) {
      toast('error', errorMessage(e))
    }
    batch.forEach((resolve) => resolve())
  }
  refreshing = false
}

async function loadSnapshot(kind: RefreshKind) {
  const path = get().repoPath
  if (!path) return
  const api = repoApi(path)
  if (kind === 'status' && get().snap) {
    const status = await api.status()
    if (get().repoPath !== path) return
    set((s) => ({ snap: s.snap && { ...s.snap, status } }))
  } else {
    const snap = await api.snapshot(get().limit)
    if (get().repoPath !== path) return
    set({ snap })
    if (get().github) void loadGitHub()
  }
  reconcile()
}

// ------------------------------------------------------------------ GitHub pull requests

const GITHUB_TTL = 60_000
let githubInflight: Promise<void> | null = null

/** Load GitHub info and open pull requests. Throttled unless `force` (used after fetch/push). */
export async function loadGitHub(force = false): Promise<void> {
  const path = get().repoPath
  if (!path) return
  const current = get().github
  if (!force && current && Date.now() - current.loadedAt < GITHUB_TTL) return
  if (!force && githubInflight) return githubInflight

  const task = (async () => {
    const api = repoApi(path)
    let info: GitHubState['info'] = null
    let openPrs: PullRequest[] = []
    let error: string | null = null
    try {
      info = await api.githubInfo()
      if (info && get().repoPath === path) {
        // Publish the repo info right away so the PR list loads in parallel with the open-PR badges.
        const known = info
        set((s) => ({ github: { info: known, openPrs: s.github?.openPrs ?? [], error: null, loadedAt: s.github?.loadedAt ?? 0 } }))
        void loadPrList(force)
        openPrs = await api.openPullRequests(force)
      }
    } catch (e) {
      error = errorMessage(e)
    }
    if (get().repoPath !== path) return
    set((s) => ({
      github: { info, openPrs, error, loadedAt: Date.now() },
      commitPrs: force ? {} : s.commitPrs
    }))
  })()
  githubInflight = task
  try {
    await task
  } finally {
    if (githubInflight === task) githubInflight = null
  }
}

/** Look up pull requests containing a commit (once per commit unless refreshed). */
export async function loadCommitPrs(sha: string, force = false): Promise<void> {
  const { repoPath: path, github, commitPrs } = get()
  if (!path || !github?.info) return
  if (!force && commitPrs[sha]) return
  set((s) => ({ commitPrs: { ...s.commitPrs, [sha]: { loading: true, prs: s.commitPrs[sha]?.prs ?? [] } } }))
  let entry: CommitPrsEntry
  try {
    const result = await repoApi(path).pullRequestsForCommit(sha)
    entry = { loading: false, prs: result.prs, notice: result.notice }
  } catch (e) {
    entry = { loading: false, prs: [], error: errorMessage(e) }
  }
  if (get().repoPath !== path) return
  set((s) => ({ commitPrs: { ...s.commitPrs, [sha]: entry } }))
}

/** Re-query GitHub, bypassing every cache. */
export async function refreshPullRequests(sha?: string): Promise<void> {
  await loadGitHub(true)
  if (sha) await loadCommitPrs(sha, true)
}

let loadingMore = false
export async function loadMore() {
  const { snap, limit } = get()
  if (!snap || loadingMore || snap.commits.length < limit) return
  loadingMore = true
  set({ limit: limit + PAGE })
  await refresh('all')
  loadingMore = false
}

function defaultSelection(): Selection {
  const snap = get().snap
  if (!snap) return null
  if (hasChanges(snap.status)) return { kind: 'wip' }
  return snap.status.head ? { kind: 'commit', sha: snap.status.head } : null
}

/** Keep selection and open diff consistent with freshly loaded data. */
function reconcile() {
  const { snap, selection, diff } = get()
  if (!snap) return
  if (!selection) {
    select(defaultSelection())
  } else if (selection.kind === 'wip') {
    if (!hasChanges(snap.status)) select(defaultSelection())
  } else {
    const exists = selection.stash
      ? snap.stashes.some((s) => s.sha === selection.sha)
      : snap.commits.some((c) => c.sha === selection.sha)
    if (!exists) select(defaultSelection())
  }

  if (diff && get().selection?.kind === 'wip' && diff.target.kind !== 'commit') {
    const target = diff.target
    const files =
      target.kind === 'staged' ? snap.status.staged : [...snap.status.unstaged, ...snap.status.conflicted]
    if (files.some((f) => f.path === target.path)) void loadDiff(target)
    else set({ diff: null })
  }
}

// ------------------------------------------------------------------ selection & diffs

const sameSelection = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b)

export function select(selection: Selection) {
  if (sameSelection(selection, get().selection)) return
  const keepDetails = selection?.kind === 'commit' && get().details?.sha === selection.sha
  set({ selection, diff: null, details: keepDetails ? get().details : null })
  if (selection?.kind === 'commit' && !keepDetails) void loadDetails(selection.sha, !!selection.stash)
}

/** Select a commit (or stash) by sha and scroll the graph to it. */
export function selectSha(sha: string) {
  const snap = get().snap
  const stash = snap?.stashes.some((s) => s.sha === sha)
  select({ kind: 'commit', sha, stash })
  set((s) => ({ prView: null, scrollRequest: { sha, n: (s.scrollRequest?.n ?? 0) + 1 } }))
}

async function loadDetails(sha: string, stash: boolean) {
  const path = get().repoPath
  if (!path) return
  try {
    const details = await repoApi(path).commitDetails(sha, stash)
    const current = get().selection
    if (current?.kind === 'commit' && current.sha === sha) set({ details })
  } catch (e) {
    toast('error', errorMessage(e))
  }
}

const sameTarget = (a: DiffTarget, b: DiffTarget) => JSON.stringify(a) === JSON.stringify(b)

export function openDiff(target: DiffTarget) {
  const current = get().diff
  if (current && sameTarget(current.target, target)) return
  set({ diff: { target, data: null, error: null }, prView: null })
  void loadDiff(target)
}

export const closeDiff = () => set({ diff: null })

async function loadDiff(target: DiffTarget) {
  const path = get().repoPath
  if (!path) return
  let data: FileDiff | null = null
  let error: string | null = null
  try {
    data = await repoApi(path).diff(target)
  } catch (e) {
    error = errorMessage(e)
  }
  const current = get().diff
  if (current && sameTarget(current.target, target)) set({ diff: { target, data, error } })
}

export function setDraft(patch: Partial<Draft>) {
  set((s) => ({ draft: { ...s.draft, ...patch } }))
}

export const resetDraft = () => set({ draft: emptyDraft })

// ------------------------------------------------------------------ running git operations

export interface RunOptions {
  success?: string
  /** Return true if the error was handled (no error toast is shown). */
  onError?: (message: string) => Promise<boolean> | boolean
}

/** Run a git operation with a busy indicator, report errors, then refresh. */
export async function run(label: string, fn: (api: RepoApi) => Promise<unknown>, opts: RunOptions = {}): Promise<boolean> {
  const path = get().repoPath
  if (!path) return false
  set({ busy: label })
  let ok = false
  try {
    await fn(repoApi(path))
    ok = true
    if (opts.success) toast('success', opts.success)
  } catch (e) {
    const message = errorMessage(e)
    if (get().busy === label) set({ busy: null })
    const handled = opts.onError ? await opts.onError(message) : false
    if (!handled) toast('error', message)
  } finally {
    if (get().busy === label) set({ busy: null })
  }
  await refresh('all')
  return ok
}

// ------------------------------------------------------------------ pull request workspace

const PR_LIST_TTL = 2 * 60_000

/** Load the sidebar's PR list for the current filter (throttled unless forced). */
export async function loadPrList(force = false): Promise<void> {
  const { repoPath: path, github, prList } = get()
  if (!path || !github?.info) return
  if (!github.info.authenticated) {
    set((s) => ({ prList: { ...s.prList, loading: false, error: 'Sign in with the GitHub CLI ("gh auth login") to see pull requests here.' } }))
    return
  }
  if (!force && (prList.loading || Date.now() - prList.loadedAt < PR_LIST_TTL)) return
  const { filter, state } = prList
  const cacheKey = `gitlane.prList:${path}:${filter}:${state}`
  // Show the last known list immediately; GitHub search can take a few seconds.
  let cached: PrListResult | null = null
  if (!prList.result?.items.length) {
    try {
      cached = JSON.parse(localStorage.getItem(cacheKey) ?? 'null') as PrListResult | null
    } catch {
      /* storage unavailable or corrupt */
    }
  }
  set((s) => ({ prList: { ...s.prList, loading: true, result: cached ?? s.prList.result } }))
  try {
    const result = await repoApi(path).pullRequestList(filter, state)
    const cur = get()
    if (cur.repoPath !== path || cur.prList.filter !== filter || cur.prList.state !== state) return
    set((s) => ({ prList: { ...s.prList, loading: false, result, error: null, loadedAt: Date.now() } }))
    try {
      localStorage.setItem(cacheKey, JSON.stringify(result))
    } catch {
      /* storage unavailable */
    }
  } catch (e) {
    if (get().repoPath !== path) return
    set((s) => ({ prList: { ...s.prList, loading: false, error: errorMessage(e) } }))
  }
}

export function setPrListFilter(patch: { filter?: PrFilter; state?: PrListState }) {
  if (patch.filter) {
    try {
      localStorage.setItem('gitlane.prFilter', patch.filter)
    } catch {
      /* storage unavailable */
    }
  }
  set((s) => ({ prList: { ...s.prList, ...patch, result: s.prList.result && { ...s.prList.result, items: [] } } }))
  void loadPrList(true)
}

export function openPr(number: number, tab: PrTab = 'conversation') {
  set({ prView: { number, tab }, diff: null })
  void loadPrDetail(number)
  if (tab === 'files') void loadPrFiles(number)
}

export const closePr = () => set({ prView: null })

export function setPrTab(tab: PrTab) {
  const view = get().prView
  if (!view) return
  set({ prView: { ...view, tab } })
  if (tab === 'files' && !get().prFiles[view.number]?.data) void loadPrFiles(view.number)
}

export async function loadPrDetail(number: number): Promise<void> {
  const path = get().repoPath
  if (!path) return
  set((s) => ({ prDetails: { ...s.prDetails, [number]: { loading: true, data: s.prDetails[number]?.data ?? null, error: null } } }))
  try {
    const data = await repoApi(path).pullRequestDetail(number)
    if (get().repoPath === path) set((s) => ({ prDetails: { ...s.prDetails, [number]: { loading: false, data, error: null } } }))
  } catch (e) {
    if (get().repoPath === path)
      set((s) => ({ prDetails: { ...s.prDetails, [number]: { loading: false, data: s.prDetails[number]?.data ?? null, error: errorMessage(e) } } }))
  }
}

export async function loadPrFiles(number: number): Promise<void> {
  const path = get().repoPath
  if (!path) return
  set((s) => ({ prFiles: { ...s.prFiles, [number]: { loading: true, data: s.prFiles[number]?.data ?? null, error: null } } }))
  try {
    const data = await repoApi(path).pullRequestFiles(number)
    if (get().repoPath === path) set((s) => ({ prFiles: { ...s.prFiles, [number]: { loading: false, data, error: null } } }))
  } catch (e) {
    if (get().repoPath === path)
      set((s) => ({ prFiles: { ...s.prFiles, [number]: { loading: false, data: s.prFiles[number]?.data ?? null, error: errorMessage(e) } } }))
  }
}

export interface PrRunOptions {
  success?: string
  /** Also reload the PR's files (after diff comments). */
  files?: boolean
  /** Also reload open-PR badges (after state changes such as merge, close, create). */
  badges?: boolean
}

/** Run a GitHub pull-request action for the open PR, report errors, then refresh what changed. */
export async function prRun(label: string, fn: (api: RepoApi) => Promise<unknown>, opts: PrRunOptions = {}): Promise<boolean> {
  const path = get().repoPath
  if (!path) return false
  const number = get().prView?.number
  set({ busy: label })
  let ok = false
  try {
    await fn(repoApi(path))
    ok = true
    if (opts.success) toast('success', opts.success)
  } catch (e) {
    toast('error', errorMessage(e))
  } finally {
    if (get().busy === label) set({ busy: null })
  }
  if (number !== undefined) {
    await loadPrDetail(number)
    if (opts.files) void loadPrFiles(number)
  }
  void loadPrList(true)
  if (opts.badges) void loadGitHub(true)
  return ok
}

export const openPicker = (spec: PickerSpec) => set({ picker: spec })
export const closePicker = () => set({ picker: null })
