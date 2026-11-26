import { useEffect } from 'react'
import { openUrl } from '../actions'
import { closeUpdateDialog, openUpdateDialog, selectNotice, skipVersion, useUpdates } from '../updates'
import { cls } from '../util'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

/** "Update available" button, shown when a newer release exists and hasn't been skipped. */
export function UpdateNotice({ className }: { className?: string }) {
  const show = useUpdates(selectNotice)
  const latest = useUpdates((s) => s.info?.latest)
  if (!show) return null
  return (
    <button className={cls('update-pill', className)} title={`Gitlane ${latest} is available`} onClick={openUpdateDialog}>
      <Icon name="pull" size={13} />
      Update available
    </button>
  )
}

function installHint(file: string | null): string {
  if (file?.endsWith('.dmg')) return 'Open the .dmg and drag Gitlane to Applications, replacing the current copy. Your settings are kept.'
  if (file?.endsWith('.exe')) return 'Run the installer; it replaces the current version. Your settings are kept.'
  if (file?.endsWith('.deb')) return `Install it with "sudo apt install ./${file}". Your settings are kept.`
  if (file?.endsWith('.AppImage')) return 'Replace your current AppImage with the new one (and make it executable). Your settings are kept.'
  return 'Download the installer for your system from the release page.'
}

export function UpdateDialog() {
  const open = useUpdates((s) => s.dialogOpen)
  const info = useUpdates((s) => s.info)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeUpdateDialog()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open || !info?.latest) return null
  const released = info.publishedAt
    ? new Date(info.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : null
  const download = info.downloadUrl
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeUpdateDialog()}>
      <div className="modal update-dialog">
        <h2>{info.available ? `Gitlane ${info.latest} is available` : 'Gitlane is up to date'}</h2>
        <p className="modal-message">
          You have {info.current}
          {info.available && released ? `. ${info.latest} was released on ${released}.` : '.'}
        </p>
        {info.available && info.notesHtml && <Markdown className="update-notes" html={info.notesHtml} />}
        {info.available && <p className="pref-detail">{installHint(info.downloadName)}</p>}
        <div className="modal-actions">
          {info.available && (
            <button className="btn update-skip" onClick={() => skipVersion(info.latest!)}>
              Skip this version
            </button>
          )}
          {info.releaseUrl && (
            <button className="btn" onClick={() => openUrl(info.releaseUrl!)}>
              Release page
            </button>
          )}
          <button className="btn" onClick={closeUpdateDialog}>
            {info.available ? 'Later' : 'Close'}
          </button>
          {info.available && download && (
            <button
              className="btn btn-primary"
              autoFocus
              onClick={() => {
                openUrl(download)
                closeUpdateDialog()
              }}
            >
              Download
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
