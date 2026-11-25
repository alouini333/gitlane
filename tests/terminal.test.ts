import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TerminalManager, type TerminalSink } from '../src/main/terminal'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gitlane-term-')))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function sink() {
  const events: { channel: string; id: number; payload: string | number }[] = []
  const s: TerminalSink = { send: (channel, id, payload) => void events.push({ channel, id, payload }), isDestroyed: () => false }
  const output = () => events.filter((e) => e.channel === 'term:data').map((e) => e.payload).join('')
  return { s, events, output }
}

async function waitFor(check: () => boolean, ms = 5000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('TerminalManager', () => {
  it('runs an interactive shell in the repository folder with a real TTY', async () => {
    const mgr = new TerminalManager()
    const { s, output } = sink()
    const { id } = mgr.create(1, s, { cwd: dir, cols: 100, rows: 30, shell: '/bin/sh', args: [] })
    mgr.write(1, id, 'pwd; tty -s && echo IS_TTY; stty size\r')
    await waitFor(() => output().includes('IS_TTY') && /30 100/.test(output()))
    expect(output()).toContain(dir)

    mgr.resize(1, id, 120, 40)
    mgr.write(1, id, 'stty size\r')
    await waitFor(() => output().includes('40 120'))
    mgr.kill(1, id)
  })

  it('reports exit and only lets the owner control a session', async () => {
    const mgr = new TerminalManager()
    const { s, events, output } = sink()
    const { id } = mgr.create(1, s, { cwd: dir, cols: 80, rows: 24, shell: '/bin/sh', args: [] })
    mgr.write(2, id, 'echo INTRUDER\r') // another window: ignored
    mgr.write(1, id, 'exit 3\r')
    await waitFor(() => events.some((e) => e.channel === 'term:exit'))
    expect(events.find((e) => e.channel === 'term:exit')?.payload).toBe(3)
    expect(output()).not.toContain('INTRUDER')
  })
})
