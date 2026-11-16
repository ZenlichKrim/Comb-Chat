import React, { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useStore, formatCost } from '../store'
import { MODELS } from '../../../shared/types'

export function TitleBar(): React.ReactElement {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const workspace = useStore((s) => s.workspace)
  const openWorkspace = useStore((s) => s.openWorkspace)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const threads = useStore((s) => s.threads)
  const running = useStore((s) => s.running)
  const [maximized, setMaximized] = useState(false)
  const [modelMenu, setModelMenu] = useState(false)
  const isMac = window.comb?.app?.platform === 'darwin'

  useEffect(() => {
    void window.comb.app.isMaximized().then(setMaximized)
    return window.comb.app.onMaximized(setMaximized)
  }, [])

  const totalCost = threads.reduce((a, t) => a + t.usage.cost, 0)
  const wsName = workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : null
  const model = MODELS.find((m) => m.id === settings.model) || MODELS[0]

  return (
    <header className="titlebar" style={{ paddingLeft: isMac ? 78 : 8 }}>
      <div className="tb-left">
        <button
          className="icon-btn"
          data-tip="Toggle sidebar"
          onClick={() => useStore.setState({ sidebarOpen: !sidebarOpen })}
        >
          <Icon name="sidebar" size={14} />
        </button>
        <div className="brand" onClick={() => useStore.setState({ aboutOpen: true })} title="Comb Chat">
          <CombMark />
          <span className="brand-name">comb</span>
        </div>
        <span className="tb-sep" />
        <button className="ws-chip" onClick={() => void openWorkspace()} data-tip={workspace || 'Open a folder'}>
          <Icon name="folder" size={12} />
          <span className="ellipsis">{wsName || 'open folder'}</span>
          <Icon name="chevron-down" size={10} />
        </button>
      </div>

      <div className="tb-center">
        <div className="tb-crumbs">
          {running ? (
            <>
              <span className="spinner" />
              <span className="tb-status acc">agent running</span>
            </>
          ) : (
            <>
              <span className="dot" style={{ background: 'var(--ok)' }} />
              <span className="tb-status">ready</span>
            </>
          )}
        </div>
      </div>

      <div className="tb-right">
        <button className="model-chip" onClick={() => setModelMenu((v) => !v)}>
          <Icon name="cpu" size={12} />
          <span>{model.label}</span>
          {model.reasoning && <span className="pill acc" style={{ height: 15, padding: '0 4px' }}>R1</span>}
          <Icon name="chevron-down" size={10} />
        </button>
        {modelMenu && (
          <>
            <div className="backdrop" onClick={() => setModelMenu(false)} />
            <div className="menu model-menu">
              <div className="menu-label">Model</div>
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  className="menu-item"
                  data-active={settings.model === m.id}
                  onClick={() => {
                    void setSettings({ model: m.id })
                    setModelMenu(false)
                  }}
                >
                  <Icon name={m.reasoning ? 'sparkles' : 'zap'} size={13} />
                  <span className="col" style={{ alignItems: 'flex-start', gap: 0 }}>
                    <span className="mono">{m.label}</span>
                    <span className="t-xs faint">{m.blurb}</span>
                  </span>
                  {settings.model === m.id && <Icon name="check" size={12} className="acc" />}
                </button>
              ))}
              <div className="divider" />
              <div className="menu-item" style={{ cursor: 'default' }}>
                <span className="t-xs faint">
                  {model.contextWindow / 1024}k context · ${model.priceIn}/M in · ${model.priceOut}/M out
                </span>
              </div>
            </div>
          </>
        )}
        <span className="tb-cost" data-tip="Total spend this app">
          {formatCost(totalCost)}
        </span>
        <button className="icon-btn" data-tip="Settings (Ctrl+,)" onClick={() => useStore.setState({ settingsOpen: true })}>
          <Icon name="settings" size={14} />
        </button>
        {!isMac && (
          <div className="win-controls">
            <button className="win-btn" onClick={() => window.comb.app.minimize()} aria-label="Minimize">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M2 5h6" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button className="win-btn" onClick={() => window.comb.app.maximize()} aria-label="Maximize">
              {maximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <rect x="1.5" y="3" width="5.5" height="5.5" fill="none" stroke="currentColor" strokeWidth="1" />
                  <path d="M3.5 3V1.5h5v5H7" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              )}
            </button>
            <button className="win-btn close" onClick={() => window.comb.app.close()} aria-label="Close">
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        )}
        {isMac && <div style={{ width: 8 }} />}
      </div>
    </header>
  )
}

export function CombMark({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--bg-3)" stroke="var(--line-3)" />
      <path d="M7 15.5V9.5l5-3 5 3v6l-5 3z" stroke="var(--accent)" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M12 9v9M7 12.5l5 3 5-3" stroke="var(--accent)" strokeWidth="1.2" strokeLinejoin="round" opacity="0.75" />
    </svg>
  )
}
