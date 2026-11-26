// Update check: compares this build with the latest GitHub release. Nothing is downloaded or
// installed automatically; the app shows what's new and links to the installer for this system.
import type { UpdateInfo } from '../shared/types'

export const RELEASES_REPO = 'alouini333/gitlane'

/** Compare versions like 1.2.10 and 1.2.9 (a leading "v" is ignored). A pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, ...pre] = v.trim().replace(/^v/i, '').split('-')
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre.join('-') }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) < 0 ? -1 : 1
}

/** The installer for this system among a release's files (names follow the build config). */
export function installerFor(names: string[], platform: NodeJS.Platform, arch: string, appImage: boolean): string | null {
  const wanted =
    platform === 'darwin'
      ? [`Gitlane-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`]
      : platform === 'win32'
        ? ['Gitlane-win-x64-setup.exe']
        : platform === 'linux'
          ? appImage
            ? ['Gitlane-linux-x86_64.AppImage']
            : ['Gitlane-linux-amd64.deb', 'Gitlane-linux-x86_64.AppImage']
          : []
  return wanted.find((n) => names.includes(n)) ?? null
}

/** Release notes without the "Downloads" table the release page adds: the dialog offers this system's installer instead. */
export function notesWithoutDownloads(html: string): string {
  return html.replace(/(<div class="markdown-heading"[^>]*>\s*)?<h2[^>]*>\s*Downloads\s*<\/h2>[\s\S]*$/i, '').trim()
}

interface Release {
  tag_name: string
  html_url: string
  body_html?: string
  published_at?: string | null
  assets?: { name: string; browser_download_url: string }[]
}

export interface CheckOptions {
  current: string
  platform: NodeJS.Platform
  arch: string
  /** Running from an AppImage (Linux). */
  appImage: boolean
  fetch: typeof fetch
}

/** Ask GitHub for the latest release. Only the app version is sent (in the User-Agent). */
export async function checkForUpdate(opts: CheckOptions): Promise<UpdateInfo> {
  const none: UpdateInfo = { current: opts.current, latest: null, available: false, releaseUrl: null, notesHtml: '', publishedAt: null, downloadUrl: null, downloadName: null }
  let res: Response
  try {
    res = await opts.fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.html+json', 'User-Agent': `Gitlane/${opts.current}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    throw new Error('Couldn’t reach GitHub to check for updates.')
  }
  // No published release yet.
  if (res.status === 404) return none
  if (!res.ok) throw new Error(`Couldn’t check for updates (GitHub answered ${res.status}).`)
  const release = (await res.json()) as Release
  const latest = release.tag_name.replace(/^v/i, '')
  const assets = release.assets ?? []
  const name = installerFor(
    assets.map((a) => a.name),
    opts.platform,
    opts.arch,
    opts.appImage
  )
  return {
    current: opts.current,
    latest,
    available: compareVersions(latest, opts.current) > 0,
    releaseUrl: release.html_url,
    notesHtml: notesWithoutDownloads(release.body_html ?? ''),
    publishedAt: release.published_at ?? null,
    downloadUrl: assets.find((a) => a.name === name)?.browser_download_url ?? release.html_url,
    downloadName: name
  }
}
