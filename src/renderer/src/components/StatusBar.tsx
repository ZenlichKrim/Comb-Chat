import React, { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useStore, useActiveThread, formatTokens, formatCost } from '../store'
import { MODELS } from '../../../shared/types'
import { useT } from '../lib/i18n'

export function StatusBar(): React.ReactElement {
  const t = useT()
  const workspace = useStore((s) => s.workspace)
  const git = useStore((s) => s.git)
  const tabs = useStore((s) => s.tabs)
  const activePath = useStore((s) => s.activeTabPath)
  const settings = useStore((s) => s.settings)
  const running = useStore((s) => s.running)
  const thread = useActiveThread()
  const setBottomPanel = useStore((s) => s.setBottomPanel)
  const bottomPanel = useStore((s) => s.bottomPanel)
  const dirty = tabs.filter((t) => t.dirty).length
  const active = tabs.find((t) => t.path === activePath)
  const [backendOk, setBackendOk] = useState(true)

  useEffect(() => {
    setBackendOk(!!settings.apiKey)
  }, [settings.apiKey])

  const model = MODELS.find((m) => m.id === settings.model) || MODELS[0]
  const usagePct = thread ? Math.min(100, Math.round(((thread.usage.promptTokens || 0) / model.contextWindow) * 100)) : 0

  return (
    <footer className="statusbar">
      <button className="sb-item" onClick={() => useStore.getState().setPalette({ open: true, mode: 'commands' })} data-tip={t('status.commandPalette')}>
        <Icon name="command" size={11} />
        <span>comb</span>
      </button>
      <span className="sb-sep" />
      {git?.isRepo ? (
        <button className="sb-item" onClick={() => setBottomPanel(bottomPanel === 'problems' ? 'none' : 'problems')}>
          <Icon name="git" size={11} />
          <span>{git.branch || 'HEAD'}</span>
          {git.files.length > 0 && <span className="sb-count">{git.files.length}</span>}
          {git.ahead > 0 && <span className="faint">↑{git.ahead}</span>}
          {git.behind > 0 && <span className="faint">↓{git.behind}</span>}
        </button>
      ) : (
        <span className="sb-item faint">
          <Icon name="git" size={11} />
          <span>{t('status.noRepo')}</span>
        </span>
      )}
      <span className="sb-sep" />
      {running ? (
        <span className="sb-item acc">
          <span className="spinner" style={{ width: 8, height: 8 }} />
          {t('title.agentRunning')}
        </span>
      ) : (
        <span className="sb-item">
          <span className="dot" style={{ background: backendOk ? 'var(--ok)' : 'var(--warn)' }} />
          {backendOk ? t('title.ready') : t('status.noKey')}
        </span>
      )}
      {dirty > 0 && (
        <span className="sb-item warn">
          <Icon name="save" size={11} /> {t('status.unsaved', { n: dirty })}
        </span>
      )}
      <span className="sb-item faint ellipsis" style={{ maxWidth: 280 }} title={active?.path || workspace || ''}>
        <Icon name="folder" size={11} />
        {active?.rel || (workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : 'no folder')}
      </span>

      <span className="spacer" />

      {thread && (
        <>
          <span className="sb-item faint" data-tip={t('status.contextUsed')}>
            ctx {usagePct}%
          </span>
          <span className="sb-item faint" data-tip={t('status.sessionCost')}>
            {formatCost(thread.usage.cost)}
          </span>
          <span className="sb-item faint" data-tip={t('status.tokens')}>
            {formatTokens(thread.usage.promptTokens + thread.usage.completionTokens)} tok
          </span>
          <span className="sb-sep" />
        </>
      )}
      <button className="sb-item" onClick={() => setBottomPanel(bottomPanel === 'terminal' ? 'none' : 'terminal')} data-tip={t('status.toggleTerminal')}>
        <Icon name="panel-bottom" size={11} />
      </button>
      <span className="sb-sep" />
      <span className="sb-item faint" title={settings.model}>{settings.model.replace('deepseek-', '')}</span>
    </footer>
  )
}
