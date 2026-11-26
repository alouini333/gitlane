import { app } from '../api'
import { cloneRepoDialog, initRepoDialog, openRepoDialog } from '../actions'
import { openRepo, useStore } from '../store'
import { repoName } from '../util'
import { Icon } from './Icon'
import { UpdateNotice } from './Updates'
import logo from '../../../../assets/logo.svg'

export function Welcome() {
  const recent = useStore((s) => s.recent)
  const busy = useStore((s) => s.busy)

  return (
    <div className="welcome">
      <div className="welcome-drag" />
      <div className="welcome-inner">
        <div className="welcome-brand">
          <img src={logo} width={64} height={64} alt="" />
          <div>
            <h1>Gitlane</h1>
            <p>A fast, open-source Git client</p>
          </div>
          <UpdateNotice className="welcome-update" />
        </div>

        <div className="welcome-actions">
          <button className="welcome-card" onClick={openRepoDialog}>
            <Icon name="folder" size={22} />
            <span>Open repository</span>
          </button>
          <button className="welcome-card" onClick={cloneRepoDialog} disabled={!!busy}>
            <Icon name="pull" size={22} />
            <span>{busy ?? 'Clone repository'}</span>
          </button>
          <button className="welcome-card" onClick={initRepoDialog}>
            <Icon name="plus" size={22} />
            <span>Init repository</span>
          </button>
        </div>

        {recent.length > 0 && (
          <div className="welcome-recent">
            <h3>Recent repositories</h3>
            {recent.map((path) => (
              <div key={path} className="recent-row" onClick={() => openRepo(path)}>
                <Icon name="repo" />
                <span className="recent-name">{repoName(path)}</span>
                <span className="recent-path">{path}</span>
                <button
                  className="icon-btn"
                  title="Remove from list"
                  onClick={async (e) => {
                    e.stopPropagation()
                    useStore.setState({ recent: await app.forgetRepo(path) })
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
