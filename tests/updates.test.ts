import { describe, expect, it } from 'vitest'
import { checkForUpdate, compareVersions, installerFor, notesWithoutDownloads, RELEASES_REPO } from '../src/main/updates'

const FILES = [
  'Gitlane-linux-amd64.deb',
  'Gitlane-linux-x86_64.AppImage',
  'Gitlane-mac-arm64.dmg',
  'Gitlane-mac-arm64.zip',
  'Gitlane-mac-x64.dmg',
  'Gitlane-mac-x64.zip',
  'Gitlane-win-x64-setup.exe'
]

const release = {
  tag_name: 'v0.2.0',
  html_url: `https://github.com/${RELEASES_REPO}/releases/tag/v0.2.0`,
  body_html: '<h3>Added</h3><ul><li>WSL support</li></ul>\n<h2>Downloads</h2>\n<table><tr><td>macOS</td></tr></table>\n<p>Builds are not code-signed yet.</p>',
  published_at: '2026-11-27T10:00:00Z',
  assets: FILES.map((name) => ({ name, browser_download_url: `https://github.com/${RELEASES_REPO}/releases/download/v0.2.0/${name}` }))
}

function fakeFetch(status: number, body: unknown, seen: { url?: string; headers?: Record<string, string> } = {}) {
  return (async (url: string, init?: RequestInit) => {
    seen.url = url
    seen.headers = init?.headers as Record<string, string>
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
}

const mac = { platform: 'darwin' as const, arch: 'arm64', appImage: false }

describe('compareVersions', () => {
  it('orders versions numerically', () => {
    expect(compareVersions('0.2.0', '0.1.1')).toBe(1)
    expect(compareVersions('v0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })

  it('puts a pre-release before its release', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBe(1)
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1)
  })
})

describe('notesWithoutDownloads', () => {
  it('drops the downloads section, in either heading markup', () => {
    expect(notesWithoutDownloads('<h3>Fixed</h3><ul><li>x</li></ul>\n<h2>Downloads</h2><table></table>')).toBe('<h3>Fixed</h3><ul><li>x</li></ul>')
    expect(notesWithoutDownloads('<p>a</p><div class="markdown-heading" dir="auto"><h2 class="heading-element" dir="auto">Downloads</h2></div><p>b</p>')).toBe('<p>a</p>')
    expect(notesWithoutDownloads('<h3>Fixed</h3>')).toBe('<h3>Fixed</h3>')
  })
})

describe('installerFor', () => {
  it('picks the installer for this system', () => {
    expect(installerFor(FILES, 'darwin', 'arm64', false)).toBe('Gitlane-mac-arm64.dmg')
    expect(installerFor(FILES, 'darwin', 'x64', false)).toBe('Gitlane-mac-x64.dmg')
    expect(installerFor(FILES, 'win32', 'x64', false)).toBe('Gitlane-win-x64-setup.exe')
    expect(installerFor(FILES, 'linux', 'x64', true)).toBe('Gitlane-linux-x86_64.AppImage')
    expect(installerFor(FILES, 'linux', 'x64', false)).toBe('Gitlane-linux-amd64.deb')
    expect(installerFor(['Gitlane-linux-x86_64.AppImage'], 'linux', 'x64', false)).toBe('Gitlane-linux-x86_64.AppImage')
    expect(installerFor(FILES, 'freebsd', 'x64', false)).toBeNull()
  })
})

describe('checkForUpdate', () => {
  it('reports a newer release with its notes and the installer for this system', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {}
    const info = await checkForUpdate({ ...mac, current: '0.1.1', fetch: fakeFetch(200, release, seen) })
    expect(seen.url).toBe(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`)
    expect(seen.headers).toMatchObject({ Accept: 'application/vnd.github.html+json', 'User-Agent': 'Gitlane/0.1.1' })
    expect(info).toEqual({
      current: '0.1.1',
      latest: '0.2.0',
      available: true,
      releaseUrl: release.html_url,
      notesHtml: '<h3>Added</h3><ul><li>WSL support</li></ul>',
      publishedAt: release.published_at,
      downloadUrl: `https://github.com/${RELEASES_REPO}/releases/download/v0.2.0/Gitlane-mac-arm64.dmg`,
      downloadName: 'Gitlane-mac-arm64.dmg'
    })
  })

  it('says nothing is available when this is the latest (or a newer dev) build', async () => {
    expect((await checkForUpdate({ ...mac, current: '0.2.0', fetch: fakeFetch(200, release) })).available).toBe(false)
    expect((await checkForUpdate({ ...mac, current: '0.3.0', fetch: fakeFetch(200, release) })).available).toBe(false)
  })

  it('falls back to the release page when there is no installer for this system', async () => {
    const info = await checkForUpdate({ platform: 'freebsd', arch: 'x64', appImage: false, current: '0.1.0', fetch: fakeFetch(200, release) })
    expect(info).toMatchObject({ available: true, downloadUrl: release.html_url, downloadName: null })
  })

  it('handles no releases, API errors and being offline', async () => {
    expect(await checkForUpdate({ ...mac, current: '0.1.0', fetch: fakeFetch(404, { message: 'Not Found' }) })).toMatchObject({ latest: null, available: false })
    await expect(checkForUpdate({ ...mac, current: '0.1.0', fetch: fakeFetch(403, { message: 'rate limited' }) })).rejects.toThrow(/GitHub answered 403/)
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(checkForUpdate({ ...mac, current: '0.1.0', fetch: offline })).rejects.toThrow(/Couldn’t reach GitHub/)
  })
})
