import React, { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useStore, formatCost, totalUsage } from '../store'
import { MODELS, type ApprovalPolicy, type ThemeId, type Locale } from '../../../shared/types'
import { useT } from '../lib/i18n'

type Tab = 'model' | 'agent' | 'appearance' | 'editor' | 'terminal' | 'shortcuts' | 'about'

const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'model', label: 'set.tabModel', icon: 'cpu' },
  { id: 'agent', label: 'set.tabAgent', icon: 'zap' },
  { id: 'appearance', label: 'set.tabAppearance', icon: 'sun' },
  { id: 'editor', label: 'set.tabEditor', icon: 'edit' },
  { id: 'terminal', label: 'set.tabTerminal', icon: 'terminal' },
  { id: 'shortcuts', label: 'set.tabKeys', icon: 'command' },
  { id: 'about', label: 'set.tabAbout', icon: 'info' }
]

const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'comb', label: 'Comb' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'electric', label: 'Electric' },
  { id: 'nord', label: 'Nord' },
  { id: 'paper', label: 'Paper' }
]

const ACCENTS = ['#e8b14c', '#e0a44a', '#f0c04e', '#6aa9ef', '#6dcf8a', '#d98fd8', '#f2695f', '#7fd6c9']

export function SettingsDialog(): React.ReactElement {
  const t = useT()
  const open = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const [tab, setTab] = useState<Tab>('model')
  const [keyDraft, setKeyDraft] = useState(settings.apiKey)
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const threads = useStore((s) => s.threads)
  const usage = totalUsage(threads)

  useEffect(() => setKeyDraft(settings.apiKey), [settings.apiKey])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useStore.setState({ settingsOpen: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return <></>
  const close = (): void => useStore.setState({ settingsOpen: false })

  const testKey = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = (await window.comb.agent.testKey(keyDraft, settings.baseUrl)) as { ok: boolean; message: string }
      setTestResult(res)
      if (res.ok) await setSettings({ apiKey: keyDraft })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-nav">
          <div className="settings-brand">
            <Icon name="bee" size={16} className="acc" />
            <span style={{ fontWeight: 700 }}>{t('set.title')}</span>
          </div>
          {TABS.map((tabDef) => (
            <button key={tabDef.id} className="settings-tab" data-active={tab === tabDef.id} onClick={() => setTab(tabDef.id)}>
              <Icon name={tabDef.icon} size={12} />
              {t(tabDef.label as any)}
            </button>
          ))}
          <span className="spacer" />
          <div className="settings-version t-xs ghost">v{window.comb.app.version || '1.0.0'}</div>
        </div>

        <div className="settings-body">
          <button className="modal-close" onClick={close}>
            <Icon name="close" size={12} />
          </button>

          {tab === 'model' && (
            <Section title={t('set.modelSection')} desc={t('set.modelDesc')}>
              <Field label={t('set.apiKey')} hint={t('set.apiKeyHint')}>
                <div className="row gap-2">
                  <div className="input-with-icon">
                    <Icon name="key" size={12} />
                    <input
                      className="input"
                      type={showKey ? 'text' : 'password'}
                      value={keyDraft}
                      spellCheck={false}
                      placeholder="sk-…"
                      onChange={(e) => setKeyDraft(e.target.value)}
                      onBlur={() => {
                        if (keyDraft !== settings.apiKey) void setSettings({ apiKey: keyDraft })
                      }}
                      style={{ fontFamily: 'var(--font-code)' }}
                    />
                    <button className="input-icon" onClick={() => setShowKey((v) => !v)}>
                      <Icon name={showKey ? 'eye-off' : 'eye'} size={12} />
                    </button>
                  </div>
                  <button className="btn" onClick={() => void testKey()} disabled={testing || !keyDraft}>
                    {testing ? <span className="spinner" /> : <Icon name="zap" size={11} />} {t('set.testKey')}
                  </button>
                </div>
                {testResult && (
                  <div className={`test-result ${testResult.ok ? 'ok' : 'err'}`}>
                    <Icon name={testResult.ok ? 'check-circle' : 'x-circle'} size={11} />
                    <span className="t-xs">{testResult.message}</span>
                  </div>
                )}
              </Field>

              <Field label={t('set.baseUrl')} hint={t('set.baseUrlHint')}>
                <input
                  className="input"
                  value={settings.baseUrl}
                  spellCheck={false}
                  onChange={(e) => void setSettings({ baseUrl: e.target.value })}
                />
              </Field>

              <Field label={t('set.tabModel')}>
                <div className="model-grid">
                  {MODELS.map((m) => (
                    <button key={m.id} className="model-card" data-active={settings.model === m.id} onClick={() => void setSettings({ model: m.id })}>
                      <div className="row gap-2">
                        <Icon name={m.reasoning ? 'sparkles' : 'zap'} size={12} className={settings.model === m.id ? 'acc' : 'faint'} />
                        <span className="mono t-sm" style={{ fontWeight: 600 }}>{m.label}</span>
                        {settings.model === m.id && <Icon name="check" size={11} className="acc" style={{ marginLeft: 'auto' }} />}
                      </div>
                      <span className="t-xs faint">{t(m.blurbKey)}</span>
                      <span className="t-xs ghost">
                        {m.contextWindow / 1024}k · ${m.priceIn}/M {t('menu.context')} · ${m.priceOut}/M {t('menu.out')}
                      </span>
                    </button>
                  ))}
                </div>
              </Field>

              <Row label={t('set.temperature')} hint={t('set.temperatureHint', { v: settings.temperature })}>
                <input
                  type="range"
                  min={0}
                  max={1.4}
                  step={0.05}
                  value={settings.temperature}
                  style={{ ['--fill' as any]: `${(settings.temperature / 1.4) * 100}%` }}
                  onChange={(e) => void setSettings({ temperature: Number(e.target.value) })}
                />
              </Row>
              <Row label={t('set.maxTokens')} hint={t('set.maxTokensHint', { n: settings.maxTokens })}>
                <input
                  type="range"
                  min={1024}
                  max={65536}
                  step={1024}
                  value={settings.maxTokens}
                  style={{ ['--fill' as any]: `${((settings.maxTokens - 1024) / (65536 - 1024)) * 100}%` }}
                  onChange={(e) => void setSettings({ maxTokens: Number(e.target.value) })}
                />
              </Row>

              <div className="usage-card">
                <div className="cap">{t('set.lifetime')}</div>
                <div className="stat-grid" style={{ marginTop: 8 }}>
                  <div className="stat"><span className="stat-value">{formatCost(usage.cost)}</span><span className="stat-label">{t('set.spent')}</span></div>
                  <div className="stat"><span className="stat-value">{(usage.promptTokens / 1000).toFixed(0)}k</span><span className="stat-label">{t('set.input')}</span></div>
                  <div className="stat"><span className="stat-value">{(usage.completionTokens / 1000).toFixed(0)}k</span><span className="stat-label">{t('set.output')}</span></div>
                  <div className="stat"><span className="stat-value">{threads.length}</span><span className="stat-label">{t('set.sessions')}</span></div>
                </div>
                <p className="t-xs ghost" style={{ marginBottom: 0 }}>
                  {t('set.cheapNote')}
                </p>
              </div>
            </Section>
          )}

          {tab === 'agent' && (
            <Section title={t('set.agentSection')} desc={t('set.agentDesc')}>
              <Field label={t('set.approvalPolicy')}>
                <div className="policy-grid">
                  {([
                    ['ask', t('set.policyAsk'), t('set.policyAskDesc'), 'shield'],
                    ['auto-edit', t('set.policyAuto'), t('set.policyAutoDesc'), 'edit'],
                    ['yolo', t('set.policyYolo'), t('set.policyYoloDesc'), 'zap']
                  ] as [ApprovalPolicy, string, string, any][]).map(([id, title, desc, icon]) => (
                    <button key={id} className="policy-card" data-active={settings.approvalPolicy === id} data-danger={id === 'yolo'} onClick={() => void setSettings({ approvalPolicy: id })}>
                      <Icon name={icon} size={12} className={settings.approvalPolicy === id ? (id === 'yolo' ? 'err' : 'acc') : 'faint'} />
                      <span className="t-sm" style={{ fontWeight: 600 }}>{title}</span>
                      <span className="t-xs faint" style={{ lineHeight: 1.5 }}>{desc}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={t('set.alwaysAllowed')} hint={t('set.alwaysAllowedHint')}>
                {settings.allowedTools?.length ? (
                  <div className="row gap-2 wrap">
                    {settings.allowedTools.map((tool) => (
                      <span key={tool} className="ctx-chip">
                        <Icon name="check" size={10} className="ok" />
                        {tool}
                        <button onClick={() => void setSettings({ allowedTools: settings.allowedTools.filter((x) => x !== tool) })}>
                          <Icon name="close" size={9} />
                        </button>
                      </span>
                    ))}
                    <button className="btn ghost sm" onClick={() => void setSettings({ allowedTools: [] })}>
                      {t('common.clearAll')}
                    </button>
                  </div>
                ) : (
                  <span className="t-xs faint">{t('set.alwaysNone')}</span>
                )}
              </Field>
              <Row label={t('set.maxSteps')} hint={t('set.maxStepsHint')}>
                <div className="row gap-3">
                  <input
                    type="range"
                    min={4}
                    max={120}
                    step={2}
                    value={settings.maxAgentSteps}
                    style={{ ['--fill' as any]: `${((settings.maxAgentSteps - 4) / 116) * 100}%` }}
                    onChange={(e) => void setSettings({ maxAgentSteps: Number(e.target.value) })}
                  />
                  <span className="mono t-sm" style={{ width: 28 }}>{settings.maxAgentSteps}</span>
                </div>
              </Row>
              <Toggle label={t('set.autoContext')} hint={t('set.autoContextHint')} value={settings.autoContext} onChange={(v) => void setSettings({ autoContext: v })} />

              <Toggle
                label={t('set.fullDisk')}
                hint={t('set.fullDiskHint')}
                value={settings.fullDiskAccess}
                onChange={(v) => void setSettings({ fullDiskAccess: v })}
              />
              <Toggle label={t('set.sendOnEnter')} hint={t('set.sendOnEnterHint')} value={settings.sendOnEnter} onChange={(v) => void setSettings({ sendOnEnter: v })} />
              <Toggle label={t('set.experimental')} hint={t('set.experimentalHint')} value={settings.alphaFeatures} onChange={(v) => void setSettings({ alphaFeatures: v })} />
              <Field label={t('set.customInstructions')} hint={t('set.customInstructionsHint')}>
                <textarea
                  className="textarea"
                  rows={5}
                  value={settings.customInstructions}
                  spellCheck={false}
                  placeholder={t('set.customPlaceholder')}
                  onChange={(e) => void setSettings({ customInstructions: e.target.value })}
                />
              </Field>
            </Section>
          )}

          {tab === 'appearance' && (
            <Section title={t('set.appearanceSection')} desc={t('set.appearanceDesc')}>
              <Field label={t('set.theme')}>
                <div className="theme-grid">
                  {THEMES.map((theme) => (
                    <button key={theme.id} className="theme-card" data-active={settings.theme === theme.id} onClick={() => void setSettings({ theme: theme.id })}>
                      <span className={`theme-preview theme-${theme.id}`}>
                        <span className="tp-bg" />
                        <span className="tp-line" />
                        <span className="tp-line short" />
                        <span className="tp-acc" />
                      </span>
                      <span className="t-xs">{theme.label}</span>
                      {settings.theme === theme.id && <Icon name="check" size={10} className="acc" style={{ marginLeft: 'auto' }} />}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={t('set.language')} hint={t('set.languageHint')}>
                <div className="segmented">
                  {(['en', 'ru'] as Locale[]).map((loc) => (
                    <button key={loc} data-active={settings.locale === loc} onClick={() => void setSettings({ locale: loc })}>
                      {loc === 'en' ? t('set.languageEn') : t('set.languageRu')}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={t('set.accent')}>
                <div className="swatches">
                  <button
                    className="swatch auto"
                    data-active={settings.accent === 'auto'}
                    title={t('set.accentAuto')}
                    onClick={() => void setSettings({ accent: 'auto' })}
                  />
                  {ACCENTS.map((c) => (
                    <button key={c} className="swatch" data-active={settings.accent === c} style={{ background: c }} onClick={() => void setSettings({ accent: c })} />
                  ))}
                  <input type="color" className="swatch-input" value={settings.accent} onChange={(e) => void setSettings({ accent: e.target.value })} />
                </div>
              </Field>
              <Row label={t('set.uiScale')} hint={`${Math.round(settings.uiScale * 100)}%`}>
                <input
                  type="range"
                  min={0.8}
                  max={1.25}
                  step={0.05}
                  value={settings.uiScale}
                  style={{ ['--fill' as any]: `${((settings.uiScale - 0.8) / 0.45) * 100}%` }}
                  onChange={(e) => void setSettings({ uiScale: Number(e.target.value) })}
                />
              </Row>
              <Row label={t('set.fontSize')} hint={t('set.fontSizeHint', { n: settings.fontSize })}>
                <input
                  type="range"
                  min={11}
                  max={18}
                  step={1}
                  value={settings.fontSize}
                  style={{ ['--fill' as any]: `${((settings.fontSize - 11) / 7) * 100}%` }}
                  onChange={(e) => void setSettings({ fontSize: Number(e.target.value) })}
                />
              </Row>
              <Toggle label={t('set.ligatures')} hint={t('set.ligaturesHint')} value={settings.fontLigatures} onChange={(v) => void setSettings({ fontLigatures: v })} />
              <Toggle label={t('set.reducedMotion')} hint={t('set.reducedMotionHint')} value={settings.reducedMotion} onChange={(v) => void setSettings({ reducedMotion: v })} />
              <div className="type-sample">
                <div className="cap" style={{ marginBottom: 6 }}>{t('set.typeSpecimen')}</div>
                <div className="mono" style={{ fontSize: settings.fontSize + 4, color: 'var(--fg-0)' }}>
                  const comb = async () =&gt; 0xFF &amp;&amp; a !== b;
                </div>
                <div className="mono t-xs faint">JetBrains Mono · 100–800 · cyrillic + latin · {settings.fontLigatures ? t('set.ligaturesOn') : t('set.ligaturesOff')}</div>
              </div>
            </Section>
          )}

          {tab === 'editor' && (
            <Section title={t('set.editorSection')} desc={t('set.editorDesc')}>
              <Toggle label={t('set.lineNumbers')} value={settings.showLineNumbers} onChange={(v) => void setSettings({ showLineNumbers: v })} />
              <Toggle label={t('set.wordWrap')} hint={t('set.wordWrapHint')} value={settings.wordWrap} onChange={(v) => void setSettings({ wordWrap: v })} />
              <Toggle label={t('set.autoSave')} hint={t('set.autoSaveHint')} value={settings.autoSave} onChange={(v) => void setSettings({ autoSave: v })} />
              <Row label={t('set.tabSize')} hint={t('set.tabSizeHint', { n: settings.tabSize })}>
                <div className="segmented">
                  {[2, 4, 8].map((n) => (
                    <button key={n} data-active={settings.tabSize === n} onClick={() => void setSettings({ tabSize: n })}>
                      {n}
                    </button>
                  ))}
                </div>
              </Row>
            </Section>
          )}

          {tab === 'terminal' && (
            <Section title={t('set.terminalSection')} desc={t('set.terminalDesc')}>
              <Field label={t('set.shell')} hint={window.comb.app.platform === 'win32' ? t('set.shellHintWin') : t('set.shellHintUnix')}>
                <input
                  className="input"
                  value={settings.shell}
                  spellCheck={false}
                  placeholder={window.comb.app.platform === 'win32' ? 'powershell.exe' : '/bin/bash'}
                  onChange={(e) => void setSettings({ shell: e.target.value })}
                />
              </Field>
              <Row label={t('set.terminalFontSize')} hint={`${settings.terminalFontSize}px`}>
                <input
                  type="range"
                  min={10}
                  max={18}
                  step={1}
                  value={settings.terminalFontSize}
                  style={{ ['--fill' as any]: `${((settings.terminalFontSize - 10) / 8) * 100}%` }}
                  onChange={(e) => void setSettings({ terminalFontSize: Number(e.target.value) })}
                />
              </Row>
              <div className="info-box">
                <Icon name="info" size={12} />
                <span className="t-xs faint">
                  {t('set.ptyNote')}
                </span>
              </div>
            </Section>
          )}

          {tab === 'shortcuts' && <Shortcuts />}

          {tab === 'about' && (
            <Section title={t('set.aboutSection')} desc={t('set.aboutDesc')}>
              <div className="about-grid">
                <Row label={t('set.version')} hint={window.comb.app.version || '1.0.0'} />
                <Row label={t('set.platform')} hint={`${window.comb.app.platform} · electron ${window.comb.app.electron} · node ${window.comb.app.node}`} />
                <Row label={t('set.repository')} hint="github.com/ZenlichKrim/Comb-Chat" />
                <Row label={t('set.licence')} hint="MIT" />
              </div>
              <div className="info-box">
                <Icon name="shield" size={12} />
                <span className="t-xs faint">
                  {t('set.privacyNote')}
                </span>
              </div>
              <div className="row gap-3" style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => window.comb.app.openExternal('https://platform.deepseek.com/api_keys')}>
                  <Icon name="external" size={11} /> {t('set.deepseekKeys')}
                </button>
                <button className="btn" onClick={() => window.comb.app.openExternal('https://github.com/ZenlichKrim/Comb-Chat')}>
                  <Icon name="external" size={11} /> GitHub
                </button>
                <button className="btn danger" onClick={async () => {
                  if (window.confirm(t('set.clearSessionsConfirm'))) {
                    await window.comb.threads.clearAll()
                    useStore.setState({ threads: [], activeThreadId: null })
                  }
                }}>
                  <Icon name="trash" size={11} /> {t('set.clearSessions')}
                </button>
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="settings-section">
      <h2 className="settings-title">{title}</h2>
      <p className="settings-desc">{desc}</p>
      <div className="settings-content">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="field">
      <div className="field-label">
        <span className="t-sm" style={{ fontWeight: 600, color: 'var(--fg-0)' }}>{label}</span>
        {hint && <span className="t-xs faint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="setting-row">
      <div className="col" style={{ gap: 2 }}>
        <span className="t-sm" style={{ color: 'var(--fg-0)' }}>{label}</span>
        {hint && <span className="t-xs faint">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }): React.ReactElement {
  return (
    <button className="setting-row as-button" onClick={() => onChange(!value)}>
      <div className="col" style={{ gap: 2, alignItems: 'flex-start' }}>
        <span className="t-sm" style={{ color: 'var(--fg-0)' }}>{label}</span>
        {hint && <span className="t-xs faint" style={{ textAlign: 'left' }}>{hint}</span>}
      </div>
      <span className="switch" data-on={value} />
    </button>
  )
}

function Shortcuts(): React.ReactElement {
  const t = useT()
  const groups: [string, [string, string][]][] = [
    [
      t('set.groupChat'),
      [
        ['Ctrl N', t('keys.newSession')],
        ['Enter', t('keys.send')],
        ['Shift Enter', t('keys.newline')],
        ['Enter', t('keys.allow')],
        ['Shift Enter', t('keys.alwaysAllow')],
        ['Esc', t('keys.deny')],
        ['Up', t('keys.editLast')]
      ]
    ],
    [
      t('set.groupNav'),
      [
        ['Ctrl K', t('keys.palette')],
        ['Ctrl P', t('keys.quickOpen')],
        ['Ctrl Shift F', t('keys.searchFiles')],
        ['Ctrl B', t('keys.toggleSidebar')],
        ['Ctrl `', t('keys.toggleTerminal')],
        ['Ctrl J', t('keys.togglePanel')]
      ]
    ],
    [
      t('set.groupFiles'),
      [
        ['Ctrl O', t('keys.openFolder')],
        ['Ctrl S', t('keys.saveFile')],
        ['Ctrl W', t('keys.closeTab')],
        ['Ctrl Shift A', t('keys.attach')]
      ]
    ],
    [
      t('set.groupApp'),
      [
        ['Ctrl ,', t('keys.settings')],
        ['Ctrl R', t('keys.reload')],
        ['F11', t('keys.fullscreen')],
        ['Ctrl +/-', t('keys.zoom')]
      ]
    ]
  ]
  return (
    <Section title={t('set.keysSection')} desc={t('set.keysDesc')}>
      <div className="shortcut-grid">
        {groups.map(([name, rows]) => (
          <div key={name} className="shortcut-group">
            <div className="cap" style={{ marginBottom: 8 }}>{name}</div>
            {rows.map(([k, label]) => (
              <div key={`${name}-${k}-${label}`} className="shortcut-row">
                <span className="t-xs dim">{label}</span>
                <span className="kbd-group">
                  {k.split(' ').map((part) => (
                    <kbd key={part}>{part}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Section>
  )
}
