// The agent's tools, confined to one repository. Each call is prepared first (validated, with a
// preview for permission prompts), then applied.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolDisplay, ToolKind } from '../../shared/agent'
import { childEnv, runGit } from '../git/runner'
import type { ToolSpec } from './adapter'
import { lineDiff } from './diff'
import { parseWslPath, wslInvocation } from '../wsl'

const s = (description: string) => ({ type: 'string' as const, description })
const i = (description: string) => ({ type: 'integer' as const, description })
const b = (description: string) => ({ type: 'boolean' as const, description })

export const TOOLS: ToolSpec[] = [
  {
    name: 'list_files',
    kind: 'read',
    description:
      'List files tracked or not ignored by git, optionally under a directory. Call this first to find your way around the repository or to locate files by name.',
    parameters: { type: 'object', properties: { path: s('Directory relative to the repository root (default: whole repository)') }, required: [] }
  },
  {
    name: 'read_file',
    kind: 'read',
    description:
      'Read a text file with line numbers. Call this before editing a file, and whenever you need to see code you are reasoning about. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: s('File path relative to the repository root'),
        offset: i('First line to read, 1-based (default 1)'),
        limit: i('Number of lines to read (default 2000)')
      },
      required: ['path']
    }
  },
  {
    name: 'search',
    kind: 'read',
    description:
      'Search file contents with a regular expression (git grep, respects .gitignore). Call this to find definitions, usages, strings or config before reading whole files.',
    parameters: {
      type: 'object',
      properties: {
        pattern: s('Extended regular expression'),
        path: s('Limit to this file or directory (relative)'),
        case_insensitive: b('Ignore case')
      },
      required: ['pattern']
    }
  },
  {
    name: 'edit_file',
    kind: 'edit',
    description:
      'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first. Use this for targeted changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: s('File path relative to the repository root'),
        old_string: s('Exact text to replace'),
        new_string: s('Replacement text'),
        replace_all: b('Replace every occurrence (default false)')
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'write_file',
    kind: 'edit',
    description: 'Create a file, or overwrite one completely. Use this for new files; prefer edit_file for changes to existing files.',
    parameters: {
      type: 'object',
      properties: { path: s('File path relative to the repository root'), content: s('Full file content') },
      required: ['path', 'content']
    }
  },
  {
    name: 'run_command',
    kind: 'exec',
    description:
      'Run a shell command in the repository root and get its output and exit code. Use it to build, run tests, lint, or inspect things the other tools cannot. There is no interactive terminal: avoid commands that wait for input.',
    parameters: {
      type: 'object',
      properties: { command: s('Command line, run with the user’s login shell'), timeout_seconds: i('Time limit in seconds (default 120, max 600)') },
      required: ['command']
    }
  },
  {
    name: 'git_status',
    kind: 'read',
    description: 'Show the current branch and which files are modified, staged or untracked. Call this to see the state of the working tree.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'git_diff',
    kind: 'read',
    description: 'Show uncommitted changes as a unified diff (working tree by default, or staged changes). Call this to review what has changed so far.',
    parameters: {
      type: 'object',
      properties: { staged: b('Show staged changes instead of unstaged ones'), path: s('Limit to this file or directory') },
      required: []
    }
  },
  {
    name: 'git_log',
    kind: 'read',
    description: 'Show recent commits (one line each), optionally for one path. Call this to understand recent history.',
    parameters: {
      type: 'object',
      properties: { count: i('Number of commits (default 20, max 200)'), path: s('Limit to this file or directory') },
      required: []
    }
  }
]

export const toolSpec = (name: string) => TOOLS.find((t) => t.name === name)

/** Minimal check of a tool input against our simple schemas (streamed tool input isn't validated by the API). */
export function validateInput(tool: ToolSpec | undefined, input: unknown): string | null {
  if (!tool) return 'Unknown tool'
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Input must be an object'
  const obj = input as Record<string, unknown>
  if ('__invalid_json__' in obj) return `Arguments were not valid JSON: ${JSON.stringify(obj.__invalid_json__)}`
  for (const key of tool.parameters.required) if (!(key in obj)) return `Missing required parameter "${key}"`
  for (const [key, value] of Object.entries(obj)) {
    const spec = tool.parameters.properties[key]
    if (!spec || value === null || value === undefined) continue
    const okType = spec.type === 'string' ? typeof value === 'string' : spec.type === 'boolean' ? typeof value === 'boolean' : Number.isInteger(value)
    if (!okType) return `Parameter "${key}" must be ${spec.type === 'integer' ? 'an integer' : `a ${spec.type}`}`
  }
  return null
}

export interface ToolOutcome {
  content: string
  isError: boolean
  display?: ToolDisplay
}

export interface PreparedCall {
  kind: ToolKind
  title: string
  preview?: ToolDisplay
  /** Set when the call is invalid; returned to the model without asking the user. */
  error?: string
  run: (signal: AbortSignal) => Promise<ToolOutcome>
}

const MAX_OUTPUT = 30_000

function clip(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  const head = Math.floor(max / 3)
  return `${text.slice(0, head)}\n\n[… ${text.length - max} characters omitted …]\n\n${text.slice(text.length - (max - head))}`
}

const ok = (content: string, display?: ToolDisplay): ToolOutcome => ({ content, isError: false, display })
const fail = (content: string, display?: ToolDisplay): ToolOutcome => ({ content, isError: true, display })

export class RepoTools {
  readonly root: string

  constructor(root: string) {
    this.root = realpathSync(root)
  }

  /** Resolve a model-supplied path and make sure it stays inside the repository. */
  resolvePath(path: string, forWrite = false): string {
    if (typeof path !== 'string' || !path.trim()) throw new Error('A path is required.')
    const abs = resolve(this.root, path)
    // Resolve symlinks on the closest existing ancestor so links can't point outside.
    let probe = abs
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe)
    const real = resolve(realpathSync(probe), relative(probe, abs))
    const rel = relative(this.root, real)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${path} is outside the repository.`)
    if (forWrite && (rel === '.git' || rel.startsWith(`.git${sep}`))) throw new Error('Writing inside .git is not allowed.')
    return real
  }

  rel(abs: string) {
    return relative(this.root, abs) || '.'
  }

  prepare(name: string, input: Record<string, unknown>): PreparedCall {
    const spec = toolSpec(name)
    const kind = spec?.kind ?? 'read'
    const invalid = (error: string, title = name): PreparedCall => ({ kind, title, error, run: async () => fail(error) })
    try {
      switch (name) {
        case 'list_files':
          return this.#listFiles(input)
        case 'read_file':
          return this.#readFile(input)
        case 'search':
          return this.#search(input)
        case 'edit_file':
          return this.#editFile(input)
        case 'write_file':
          return this.#writeFile(input)
        case 'run_command':
          return this.#runCommand(input)
        case 'git_status':
          return {
            kind,
            title: 'Checked git status',
            run: async () => ok(clip(await runGit(this.root, ['--no-optional-locks', 'status', '--short', '--branch'])))
          }
        case 'git_diff': {
          const staged = input.staged === true
          const path = typeof input.path === 'string' && input.path ? this.rel(this.resolvePath(input.path)) : undefined
          const args = ['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', ...(path ? [path] : [])]
          return {
            kind,
            title: `Viewed ${staged ? 'staged' : 'unstaged'} changes${path ? ` in ${path}` : ''}`,
            run: async () => ok(clip((await runGit(this.root, args)) || 'No changes.'))
          }
        }
        case 'git_log': {
          const count = Math.min(200, Math.max(1, Number(input.count) || 20))
          const path = typeof input.path === 'string' && input.path ? this.rel(this.resolvePath(input.path)) : undefined
          return {
            kind,
            title: `Viewed ${count} recent commits${path ? ` for ${path}` : ''}`,
            run: async () => ok(clip(await runGit(this.root, ['log', '--oneline', '--decorate', `-n${count}`, '--', ...(path ? [path] : [])])) || 'No commits.')
          }
        }
        default:
          return invalid(`Unknown tool "${name}".`)
      }
    } catch (e) {
      return invalid(e instanceof Error ? e.message : String(e))
    }
  }

  #listFiles(input: Record<string, unknown>): PreparedCall {
    const dir = typeof input.path === 'string' && input.path && input.path !== '.' ? this.rel(this.resolvePath(input.path)) : ''
    return {
      kind: 'read',
      title: `Listed files${dir ? ` in ${dir}` : ''}`,
      run: async () => {
        const out = await runGit(this.root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...(dir ? [dir] : [])])
        const files = [...new Set(out.split('\0').filter(Boolean))].sort()
        if (!files.length) return ok('No files.')
        const shown = files.slice(0, 1500)
        return ok(shown.join('\n') + (files.length > shown.length ? `\n… and ${files.length - shown.length} more` : ''))
      }
    }
  }

  #readFile(input: Record<string, unknown>): PreparedCall {
    const abs = this.resolvePath(String(input.path))
    const rel = this.rel(abs)
    const offset = Math.max(1, Number(input.offset) || 1)
    const limit = Math.min(5000, Math.max(1, Number(input.limit) || 2000))
    return {
      kind: 'read',
      title: `Read ${rel}`,
      run: async () => {
        if (!existsSync(abs)) return fail(`${rel} does not exist.`)
        if (statSync(abs).isDirectory()) return fail(`${rel} is a directory. Use list_files.`)
        const buf = readFileSync(abs)
        if (buf.subarray(0, 8000).includes(0)) return fail(`${rel} is a binary file.`)
        const lines = buf.toString('utf8').split('\n')
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const body = slice.map((l, k) => `${String(offset + k).padStart(6)}\t${l}`).join('\n')
        const more = offset - 1 + limit < lines.length ? `\n… ${lines.length - (offset - 1 + limit)} more lines (use offset to continue)` : ''
        return ok(clip(body + more, 100_000), { kind: 'text', summary: `${rel}: lines ${offset}–${offset + slice.length - 1} of ${lines.length}` })
      }
    }
  }

  #search(input: Record<string, unknown>): PreparedCall {
    const pattern = String(input.pattern ?? '')
    const path = typeof input.path === 'string' && input.path ? this.rel(this.resolvePath(input.path)) : undefined
    const args = ['grep', '-n', '-I', '--untracked', '-E', ...(input.case_insensitive === true ? ['-i'] : []), '-e', pattern, '--', ...(path ? [path] : [])]
    return {
      kind: 'read',
      title: `Searched for “${pattern}”${path ? ` in ${path}` : ''}`,
      run: async () => {
        const out = await runGit(this.root, args, { okCodes: [1] })
        const lines = out.split('\n').filter(Boolean)
        if (!lines.length) return ok('No matches.', { kind: 'text', summary: 'No matches' })
        const shown = lines.slice(0, 300).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l))
        return ok(shown.join('\n') + (lines.length > shown.length ? `\n… ${lines.length - shown.length} more matches` : ''), {
          kind: 'text',
          summary: `${lines.length} match${lines.length === 1 ? '' : 'es'}`
        })
      }
    }
  }

  #editFile(input: Record<string, unknown>): PreparedCall {
    const abs = this.resolvePath(String(input.path), true)
    const rel = this.rel(abs)
    const oldString = String(input.old_string ?? '')
    const newString = String(input.new_string ?? '')
    const base = { kind: 'edit' as const, title: `Edit ${rel}` }
    if (!existsSync(abs)) return { ...base, error: `${rel} does not exist. Use write_file to create it.`, run: async () => fail(`${rel} does not exist.`) }
    const before = readFileSync(abs, 'utf8')
    if (!oldString) return { ...base, error: 'old_string must not be empty.', run: async () => fail('old_string must not be empty.') }
    if (oldString === newString) return { ...base, error: 'old_string and new_string are identical.', run: async () => fail('No change.') }
    const count = before.split(oldString).length - 1
    if (count === 0) {
      const msg = `old_string was not found in ${rel}. Read the file again and copy the exact text, including whitespace.`
      return { ...base, error: msg, run: async () => fail(msg) }
    }
    if (count > 1 && input.replace_all !== true) {
      const msg = `old_string matches ${count} places in ${rel}. Include more surrounding context to make it unique, or set replace_all.`
      return { ...base, error: msg, run: async () => fail(msg) }
    }
    const after = input.replace_all === true ? before.split(oldString).join(newString) : before.replace(oldString, () => newString)
    const display: ToolDisplay = { kind: 'diff', path: rel, ...lineDiff(before, after), created: false }
    return {
      ...base,
      preview: display,
      run: async () => {
        if (readFileSync(abs, 'utf8') !== before) return fail(`${rel} changed while waiting for approval. Read it again.`)
        writeFileSync(abs, after)
        return ok(`Edited ${rel}${count > 1 ? ` (${count} replacements)` : ''}.`, display)
      }
    }
  }

  #writeFile(input: Record<string, unknown>): PreparedCall {
    const abs = this.resolvePath(String(input.path), true)
    const rel = this.rel(abs)
    const content = String(input.content ?? '')
    const exists = existsSync(abs)
    if (exists && statSync(abs).isDirectory()) {
      const msg = `${rel} is a directory.`
      return { kind: 'edit', title: `Write ${rel}`, error: msg, run: async () => fail(msg) }
    }
    const before = exists ? readFileSync(abs, 'utf8') : ''
    const display: ToolDisplay = { kind: 'diff', path: rel, ...lineDiff(before, content), created: !exists }
    return {
      kind: 'edit',
      title: exists ? `Overwrite ${rel}` : `Create ${rel}`,
      preview: display,
      run: async () => {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
        return ok(`${exists ? 'Wrote' : 'Created'} ${rel} (${content.split('\n').length} lines).`, display)
      }
    }
  }

  #runCommand(input: Record<string, unknown>): PreparedCall {
    const command = String(input.command ?? '').trim()
    const seconds = Math.min(600, Math.max(1, Number(input.timeout_seconds) || 120))
    if (!command) return { kind: 'exec', title: 'Run command', error: 'command is empty.', run: async () => fail('command is empty.') }
    return {
      kind: 'exec',
      title: `Run \`${command.length > 80 ? command.slice(0, 80) + '…' : command}\``,
      preview: { kind: 'command', command, output: '', exitCode: null },
      run: (signal) => this.#exec(command, seconds, signal)
    }
  }

  #exec(command: string, seconds: number, signal: AbortSignal): Promise<ToolOutcome> {
    return new Promise((resolveOutcome) => {
      const env = { ...childEnv(), CI: '1', PAGER: 'cat', GIT_PAGER: 'cat' }
      // Inside WSL, commands run in the distribution with bash, like they would in its terminal.
      const wsl = parseWslPath(this.root)
      const run = wsl
        ? wslInvocation(wsl, ['bash', '-lc', command], env, ['CI', 'PAGER', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'GIT_EDITOR', 'LC_ALL'])
        : process.platform === 'win32'
          ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command], env }
          : { file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-lc', command], env }
      const child = spawn(run.file, run.args, {
        cwd: wsl ? undefined : this.root,
        env: run.env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      let timedOut = false
      const add = (d: Buffer) => {
        output += d.toString('utf8')
        if (output.length > 4 * MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n[…]\n' + output.slice(-2 * MAX_OUTPUT)
      }
      child.stdout.on('data', add)
      child.stderr.on('data', add)
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, seconds * 1000)
      const onAbort = () => kill()
      signal.addEventListener('abort', onAbort, { once: true })
      const finish = (exitCode: number | null) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const text = clip(output.trimEnd())
        const display: ToolDisplay = { kind: 'command', command, output: text, exitCode, timedOut }
        const header = timedOut ? `Timed out after ${seconds}s.` : signal.aborted ? 'Stopped by the user.' : `Exit code: ${exitCode}`
        const content = `${header}\n${text || '(no output)'}`
        resolveOutcome(exitCode === 0 && !timedOut ? ok(content, display) : fail(content, display))
      }
      child.on('error', (e) => {
        output += `\n${e.message}`
        finish(null)
      })
      child.on('close', (code) => finish(code))
    })
  }
}
