// Repositories that live inside WSL, opened from the Windows app as \\wsl.localhost\<distro>\… (or the
// older \\wsl$\<distro>\…). Git, the integrated terminal and agent commands run inside the distribution
// through wsl.exe, so they use Linux git with the user's Linux config, credentials and SSH keys. That
// also avoids the slowness and "dubious ownership" errors of Windows git on these paths. Files are
// still read and written through the UNC path.

export interface WslLocation {
  /** Distribution name, e.g. "Ubuntu". */
  distro: string
  /** The same folder as a Linux path, e.g. "/home/ada/project". */
  linuxPath: string
  /** UNC prefix of the distribution, in the form the user opened it, e.g. "\\\\wsl.localhost\\Ubuntu". */
  root: string
}

export interface Invocation {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

const UNC = /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i

let platform: NodeJS.Platform = process.platform
let executable = 'wsl.exe'

/** Tests: behave as on Windows, and run a stand-in for wsl.exe. */
export function configureWsl(opts: { platform?: NodeJS.Platform; executable?: string }) {
  if (opts.platform) platform = opts.platform
  if (opts.executable) executable = opts.executable
}

/** The WSL location of a Windows path, or null when it isn't inside a WSL distribution. */
export function parseWslPath(path: string): WslLocation | null {
  if (platform !== 'win32' || !path) return null
  const m = UNC.exec(path)
  if (!m) return null
  const parts = (m[3] ?? '').split(/[\\/]+/).filter(Boolean)
  return { distro: m[2], linuxPath: '/' + parts.join('/'), root: `\\\\${m[1]}\\${m[2]}` }
}

/** A path printed by Linux tools (e.g. `git rev-parse --show-toplevel`) as a path Windows can open. */
export function toWindowsPath(loc: WslLocation, linuxPath: string): string {
  const p = linuxPath.trim()
  if (!p.startsWith('/')) return p
  const parts = p.split('/').filter(Boolean)
  // Windows drives are mounted under /mnt/<letter>.
  if (parts[0] === 'mnt' && parts[1] && /^[a-z]$/i.test(parts[1])) return `${parts[1].toUpperCase()}:\\${parts.slice(2).join('\\')}`
  return `${loc.root}\\${parts.join('\\')}`
}

/** Environment with `keys` added to WSLENV, so wsl.exe passes them on to Linux. */
export function withWslEnv(env: NodeJS.ProcessEnv, keys: string[]): NodeJS.ProcessEnv {
  const shared = (env.WSLENV ?? '').split(':').filter(Boolean)
  for (const key of keys) {
    if (env[key] !== undefined && !shared.some((s) => s.split('/')[0] === key)) shared.push(key)
  }
  // WSL_UTF8 makes wsl.exe print its own messages in UTF-8 instead of UTF-16.
  return { ...env, WSLENV: shared.join(':'), WSL_UTF8: '1' }
}

/** Run `command` (no shell) inside the distribution, in `loc`'s folder. */
export function wslInvocation(loc: WslLocation, command: string[], env: NodeJS.ProcessEnv, forward: string[]): Invocation {
  return { file: executable, args: ['-d', loc.distro, '--cd', loc.linuxPath, '--exec', ...command], env: withWslEnv(env, forward) }
}

/** An interactive login shell (the user's default) inside the distribution, in `loc`'s folder. */
export function wslShell(loc: WslLocation): { file: string; args: string[] } {
  return { file: executable, args: ['-d', loc.distro, '--cd', loc.linuxPath] }
}

/** Text from wsl.exe. Older versions ignore WSL_UTF8 and print their own errors as UTF-16. */
export function decodeWslText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  const sample = buf.subarray(0, 64)
  let utf16 = sample.length >= 4
  for (let i = 1; i < sample.length && utf16; i += 2) if (sample[i] !== 0) utf16 = false
  return (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '')
}

/** A clearer message for the usual ways running a program in WSL fails. */
export function explainWslFailure(loc: WslLocation, program: string, message: string): string {
  if (/no distribution with the supplied name|WSL_E_DISTRO_NOT_FOUND/i.test(message)) {
    return `The WSL distribution "${loc.distro}" isn't installed. Run "wsl --list" to see your distributions.`
  }
  if (new RegExp(`execvp\\(${program}\\)|${program}: (command )?not found`).test(message)) {
    return `${program} isn't installed in the WSL distribution "${loc.distro}". Install it there (for example "sudo apt install ${program}").`
  }
  return message
}
