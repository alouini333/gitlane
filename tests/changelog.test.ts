import { describe, expect, it } from 'vitest'
import { REPO, extractNotes, releaseChangelog } from '../scripts/changelog.mts'

const first = `# Changelog

Intro.

## [Unreleased]

### Added

- Everything.

[Unreleased]: ${REPO}/commits/main
`

describe('changelog release helper', () => {
  it('cuts the first release from Unreleased', () => {
    const out = releaseChangelog(first, '0.1.0', '2026-11-25')
    expect(out).toContain('## [Unreleased]\n\n## [0.1.0] - 2026-11-25\n\n### Added\n\n- Everything.\n')
    expect(out).toContain(`[Unreleased]: ${REPO}/compare/v0.1.0...HEAD\n[0.1.0]: ${REPO}/releases/tag/v0.1.0\n`)
    expect(extractNotes(out, '0.1.0')).toBe('### Added\n\n- Everything.')
  })

  it('links later releases to the previous version and handles empty notes', () => {
    const one = releaseChangelog(first, '0.1.0', '2026-11-25')
    const two = releaseChangelog(one, '0.2.0', '2026-12-01')
    expect(two).toMatch(/## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-12-01\n\n### Changed\n\n- Maintenance release\.\n\n## \[0\.1\.0\]/)
    expect(two).toContain(`[0.2.0]: ${REPO}/compare/v0.1.0...v0.2.0`)
    expect(two).toContain(`[0.1.0]: ${REPO}/releases/tag/v0.1.0`)
    expect(extractNotes(two, '0.1.0')).toBe('### Added\n\n- Everything.')
  })

  it('refuses to release the same version twice', () => {
    const one = releaseChangelog(first, '0.1.0', '2026-11-25')
    expect(() => releaseChangelog(one, '0.1.0', '2026-11-26')).toThrow(/already has/)
  })
})
