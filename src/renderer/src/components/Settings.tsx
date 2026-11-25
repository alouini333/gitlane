import { useEffect } from 'react'
import { closeSettings, updateSettings, useSettings, type DirtySwitchSetting, type RemoteDoubleClick } from '../settings'
import { openProviders } from '../agent'
import { cls } from '../util'

interface Choice<T> {
  value: T
  label: string
  detail: string
}

const DIRTY: Choice<DirtySwitchSetting>[] = [
  { value: 'stash', label: 'Stash them', detail: 'Your changes are saved under Stashes; the new branch starts clean.' },
  { value: 'stash-reapply', label: 'Stash, then re-apply on the new branch', detail: 'Like git --autostash. If they conflict, they stay in the stash.' },
  { value: 'carry', label: 'Carry them over', detail: 'Git’s default. Switching stops if they would be overwritten.' },
  { value: 'ask', label: 'Ask me each time', detail: '' }
]

const REMOTE: Choice<RemoteDoubleClick>[] = [
  {
    value: 'reset',
    label: 'Check out the local branch and reset it to the remote branch',
    detail: 'Double-clicking origin/dev makes dev match origin/dev. Asks first if dev has commits origin/dev doesn’t.'
  },
  { value: 'ff', label: 'Fast-forward only', detail: 'Moves dev up to origin/dev, but never drops commits that only dev has.' },
  { value: 'checkout', label: 'Just check out the local branch', detail: 'Leaves dev where it is.' }
]

function Group<T extends string>({ title, choices, value, onChange }: { title: string; choices: Choice<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <fieldset className="pref-group">
      <legend>{title}</legend>
      {choices.map((c) => (
        <label key={c.value} className={cls('pref-choice', value === c.value && 'on')}>
          <input type="radio" checked={value === c.value} onChange={() => onChange(c.value)} />
          <span>
            <span className="pref-label">{c.label}</span>
            {c.detail && <span className="pref-detail">{c.detail}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  )
}

export function SettingsDialog() {
  const settings = useSettings()

  useEffect(() => {
    if (!settings.open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeSettings()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings.open])

  if (!settings.open) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeSettings()}>
      <div className="modal prefs">
        <h2>Preferences</h2>
        <Group
          title="When switching branches with uncommitted changes"
          choices={DIRTY}
          value={settings.dirtySwitch}
          onChange={(dirtySwitch) => updateSettings({ dirtySwitch })}
        />
        <Group
          title="Double-clicking a remote branch (e.g. origin/dev) when a local one exists"
          choices={REMOTE}
          value={settings.remoteDoubleClick}
          onChange={(remoteDoubleClick) => updateSettings({ remoteDoubleClick })}
        />
        <fieldset className="pref-group">
          <legend>Integrated terminal</legend>
          <div className="pref-row">
            <label className="modal-field pref-font">
              <span>Font family</span>
              <input
                value={settings.terminalFont}
                placeholder="Default (SF Mono, then any installed Nerd Font)"
                spellCheck={false}
                onChange={(e) => updateSettings({ terminalFont: e.target.value })}
              />
            </label>
            <label className="modal-field pref-size">
              <span>Size</span>
              <input
                type="number"
                min={8}
                max={32}
                value={settings.terminalFontSize}
                onChange={(e) => {
                  const size = Number(e.target.value)
                  if (size >= 8 && size <= 32) updateSettings({ terminalFontSize: size })
                }}
              />
            </label>
          </div>
          <span className="pref-detail">Prompt icons (e.g. starship’s branch symbol) need a Nerd Font, such as JetBrainsMono Nerd Font.</span>
        </fieldset>
        <fieldset className="pref-group">
          <legend>Coding agent</legend>
          <div className="pref-row">
            <span className="pref-detail">Connect Claude, GPT, Gemini, OpenRouter, local Ollama models or any OpenAI-compatible endpoint.</span>
            <button
              className="btn btn-sm"
              onClick={() => {
                closeSettings()
                openProviders()
              }}
            >
              Model providers…
            </button>
          </div>
        </fieldset>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={closeSettings} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
