// Release helpers for CHANGELOG.md (Keep a Changelog format).
//
//   node scripts/changelog.mts release <version> [date]   move the Unreleased notes under <version>
//   node scripts/changelog.mts notes <version>            print the notes of <version> (for the GitHub release)
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const REPO = 'https://github.com/alouini333/gitlane'
const UNRELEASED = '## [Unreleased]'

/** Index of the next "## [" heading or link-reference block after `from` (end of a section). */
function sectionEnd(text: string, from: number): number {
  const rest = text.slice(from)
  const m = /\n## \[|\n\[[^\]]+\]: /.exec(rest)
  return m ? from + m.index : text.length
}

/** Move the Unreleased notes under a new version heading and update the compare links. */
export function releaseChangelog(text: string, version: string, date: string): string {
  const start = text.indexOf(UNRELEASED)
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.')
  if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(text)) throw new Error(`CHANGELOG.md already has a ${version} section.`)
  const bodyStart = start + UNRELEASED.length
  const end = sectionEnd(text, bodyStart)
  const notes = text.slice(bodyStart, end).trim() || '### Changed\n\n- Maintenance release.'
  let out = `${text.slice(0, start)}${UNRELEASED}\n\n## [${version}] - ${date}\n\n${notes}\n${text.slice(end)}`

  const previous = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(text.slice(end))?.[1]
  const versionLink = previous ? `${REPO}/compare/v${previous}...v${version}` : `${REPO}/releases/tag/v${version}`
  const links = `[Unreleased]: ${REPO}/compare/v${version}...HEAD\n[${version}]: ${versionLink}\n`
  out = /^\[Unreleased\]: .*\n?/m.test(out) ? out.replace(/^\[Unreleased\]: .*\n?/m, links) : `${out.trimEnd()}\n\n${links}`
  return out
}

/** The notes of one version, without its heading. */
export function extractNotes(text: string, version: string): string {
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\][^\\n]*\\n`, 'm').exec(text)
  if (!heading) throw new Error(`CHANGELOG.md has no ${version} section.`)
  const start = heading.index + heading[0].length
  return text.slice(start, sectionEnd(text, start)).trim()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, version, date = new Date().toISOString().slice(0, 10)] = process.argv.slice(2)
  const file = new URL('../CHANGELOG.md', import.meta.url)
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error('Usage: node scripts/changelog.mts <release|notes> <version> [date]')
    process.exit(1)
  }
  const text = readFileSync(file, 'utf8')
  if (command === 'release') writeFileSync(file, releaseChangelog(text, version, date))
  else if (command === 'notes') process.stdout.write(`${extractNotes(text, version)}\n`)
  else {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }
}
