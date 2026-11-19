import React, { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useT } from '../lib/i18n'
import { useStore, formatCost } from '../store'
import { MODELS } from '../../../shared/types'

export function TitleBar(): React.ReactElement {
  const t = useT()
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
          data-tip={t('title.toggleSidebar')}
          onClick={() => useStore.setState({ sidebarOpen: !sidebarOpen })}
        >
          <Icon name="sidebar" size={14} />
        </button>
        <div className="brand" onClick={() => useStore.setState({ aboutOpen: true })} title="Comb Chat">
          <CombMark />
          <span className="brand-name">comb</span>
        </div>
        <span className="tb-sep" />
        <button className="ws-chip" onClick={() => void openWorkspace()} data-tip={workspace || t('title.openFolder')}>
          <Icon name="folder" size={12} />
          <span className="ellipsis">{wsName || t('common.openFolder')}</span>
          <Icon name="chevron-down" size={10} />
        </button>
      </div>

      <div className="tb-center">
        <div className="tb-crumbs">
          {running ? (
            <>
              <span className="spinner" />
              <span className="tb-status acc">{t('title.agentRunning')}</span>
            </>
          ) : (
            <>
              <span className="dot" style={{ background: 'var(--ok)' }} />
              <span className="tb-status">{t('title.ready')}</span>
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
              <div className="menu-label">{t('title.model')}</div>
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
                    <span className="t-xs faint">{t(m.blurbKey)}</span>
                  </span>
                  {settings.model === m.id && <Icon name="check" size={12} className="acc" />}
                </button>
              ))}
              <div className="divider" />
              <div className="menu-item" style={{ cursor: 'default' }}>
                <span className="t-xs faint">
                  {model.contextWindow >= 1_000_000 ? `${Math.round(model.contextWindow / 1_000_000)}M` : `${Math.round(model.contextWindow / 1024)}k`} {t('menu.context')} · ${model.priceIn}/M {t('menu.in')} · ${model.priceOut}/M {t('menu.out')}{model.vision ? ` · ${t('model.vision')}` : ''}
                </span>
              </div>
            </div>
          </>
        )}
        <span className="tb-cost" data-tip={t('title.totalSpend')}>
          {formatCost(totalCost)}
        </span>
        <button className="icon-btn" data-tip={t('title.settings')} onClick={() => useStore.setState({ settingsOpen: true })}>
          <Icon name="settings" size={14} />
        </button>
        {!isMac && (
          <div className="win-controls">
            <button className="win-btn" onClick={() => window.comb.app.minimize()} aria-label={t('title.minimize')}>
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M2 5h6" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button className="win-btn" onClick={() => window.comb.app.maximize()} aria-label={t('title.maximize')}>
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
            <button className="win-btn close" onClick={() => window.comb.app.close()} aria-label={t('title.close')}>
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

/**
 * The mark: three combs of a honeycomb, drawn as strokes rather than a bee.
 * A hexagon with an S-curve inside reads as "cell" at 16px and as "comb" at 64,
 * and it stays legible when the accent colour changes with the theme.
 */
export function CombMark({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="0.6" y="0.6" width="22.8" height="22.8" rx="7" fill="var(--bg-3)" stroke="var(--line-2)" />
      <path
        d="M12 4.6l6.4 3.7v7.4L12 19.4l-6.4-3.7V8.3z"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M12 8.2l3.2 1.85v3.7L12 15.6l-3.2-1.85v-3.7z" fill="var(--accent)" opacity="0.9" />
      <path d="M8.8 10.05h6.4M8.8 13.75h6.4" stroke="var(--bg-3)" strokeWidth="1.1" />
    </svg>
  )
}
