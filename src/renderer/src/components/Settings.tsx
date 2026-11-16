import React, { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { useStore, formatCost, totalUsage } from '../store'
import { MODELS, type ApprovalPolicy, type ThemeId } from '../../../shared/types'

type Tab = 'model' | 'agent' | 'appearance' | 'editor' | 'terminal' | 'shortcuts' | 'about'

const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'model', label: 'Model', icon: 'cpu' },
  { id: 'agent', label: 'Agent', icon: 'zap' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'editor', label: 'Editor', icon: 'edit' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'shortcuts', label: 'Keys', icon: 'command' },
  { id: 'about', label: 'About', icon: 'info' }
]

const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'comb', label: 'Comb' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'amber', label: 'Amber' },
  { id: 'nord', label: 'Nord' },
  { id: 'paper', label: 'Paper' }
]

const ACCENTS = ['#e8b14c', '#e0a44a', '#f0c04e', '#6aa9ef', '#6dcf8a', '#d98fd8', '#f2695f', '#7fd6c9']

export function SettingsDialog(): React.ReactElement {
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
            <span style={{ fontWeight: 700 }}>settings</span>
          </div>
          {TABS.map((t) => (
            <button key={t.id} className="settings-tab" data-active={tab === t.id} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={12} />
              {t.label}
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
            <Section title="Model & API" desc="Comb talks directly to DeepSeek — your key never leaves this machine except to call the API.">
              <Field label="DeepSeek API key" hint="platform.deepseek.com → API keys">
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
                    {testing ? <span className="spinner" /> : <Icon name="zap" size={11} />} test
                  </button>
                </div>
                {testResult && (
                  <div className={`test-result ${testResult.ok ? 'ok' : 'err'}`}>
                    <Icon name={testResult.ok ? 'check-circle' : 'x-circle'} size={11} />
                    <span className="t-xs">{testResult.message}</span>
                  </div>
                )}
              </Field>

              <Field label="Base URL" hint="api.deepseek.com or any OpenAI-compatible endpoint">
                <input
                  className="input"
                  value={settings.baseUrl}
                  spellCheck={false}
                  onChange={(e) => void setSettings({ baseUrl: e.target.value })}
                />
              </Field>

              <Field label="Model">
                <div className="model-grid">
                  {MODELS.map((m) => (
                    <button key={m.id} className="model-card" data-active={settings.model === m.id} onClick={() => void setSettings({ model: m.id })}>
                      <div className="row gap-2">
                        <Icon name={m.reasoning ? 'sparkles' : 'zap'} size={12} className={settings.model === m.id ? 'acc' : 'faint'} />
                        <span className="mono t-sm" style={{ fontWeight: 600 }}>{m.label}</span>
                        {settings.model === m.id && <Icon name="check" size={11} className="acc" style={{ marginLeft: 'auto' }} />}
                      </div>
                      <span className="t-xs faint">{m.blurb}</span>
                      <span className="t-xs ghost">
                        {m.contextWindow / 1024}k ctx · ${m.priceIn}/M in · ${m.priceOut}/M out
                      </span>
                    </button>
                  ))}
                </div>
              </Field>

              <Row label="Temperature" hint={`${settings.temperature} — lower is more deterministic`}>
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
              <Row label="Max output tokens" hint={`${settings.maxTokens} per response`}>
                <input
                  type="range"
                  min={1024}
                  max={settings.model === 'deepseek-reasoner' ? 65536 : 8192}
                  step={1024}
                  value={settings.maxTokens}
                  style={{ ['--fill' as any]: `${((settings.maxTokens - 1024) / ((settings.model === 'deepseek-reasoner' ? 65536 : 8192) - 1024)) * 100}%` }}
                  onChange={(e) => void setSettings({ maxTokens: Number(e.target.value) })}
                />
              </Row>

              <div className="usage-card">
                <div className="cap">lifetime usage</div>
                <div className="stat-grid" style={{ marginTop: 8 }}>
                  <div className="stat"><span className="stat-value">{formatCost(usage.cost)}</span><span className="stat-label">spent</span></div>
                  <div className="stat"><span className="stat-value">{(usage.promptTokens / 1000).toFixed(0)}k</span><span className="stat-label">input</span></div>
                  <div className="stat"><span className="stat-value">{(usage.completionTokens / 1000).toFixed(0)}k</span><span className="stat-label">output</span></div>
                  <div className="stat"><span className="stat-value">{threads.length}</span><span className="stat-label">sessions</span></div>
                </div>
                <p className="t-xs ghost" style={{ marginBottom: 0 }}>
                  DeepSeek V3.2 is ≈20× cheaper than frontier models. At $0.28/M input you get roughly 350M tokens of agent work for $100.
                </p>
              </div>
            </Section>
          )}

          {tab === 'agent' && (
            <Section title="Agent behaviour" desc="How much autonomy Comb has over your files and shell.">
              <Field label="Approval policy">
                <div className="policy-grid">
                  {([
                    ['ask', 'Ask first', 'Every write, edit, delete and command waits for your click.', 'shield'],
                    ['auto-edit', 'Auto-edit', 'File edits apply instantly. Commands and deletes still ask.', 'edit'],
                    ['yolo', 'Yolo', 'Full autonomy — nothing asks. Use on throwaway branches.', 'zap']
                  ] as [ApprovalPolicy, string, string, any][]).map(([id, title, desc, icon]) => (
                    <button key={id} className="policy-card" data-active={settings.approvalPolicy === id} data-danger={id === 'yolo'} onClick={() => void setSettings({ approvalPolicy: id })}>
                      <Icon name={icon} size={12} className={settings.approvalPolicy === id ? (id === 'yolo' ? 'err' : 'acc') : 'faint'} />
                      <span className="t-sm" style={{ fontWeight: 600 }}>{title}</span>
                      <span className="t-xs faint" style={{ lineHeight: 1.5 }}>{desc}</span>
                    </button>
                  ))}
                </div>
              </Field>
              <Row label="Max agent steps" hint="Tool-call rounds before the run stops. Default 40.">
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
              <Toggle label="Auto workspace context" hint="Send the folder tree, manifests and open tabs with each prompt." value={settings.autoContext} onChange={(v) => void setSettings({ autoContext: v })} />
              <Toggle label="Send on Enter" hint="Off: Ctrl+Enter sends, Enter inserts a newline." value={settings.sendOnEnter} onChange={(v) => void setSettings({ sendOnEnter: v })} />
              <Toggle label="Experimental UI" hint="Taller diffs, denser previews." value={settings.alphaFeatures} onChange={(v) => void setSettings({ alphaFeatures: v })} />
              <Field label="Custom instructions" hint="Appended to the system prompt for every run — project rules, conventions, forbidden paths.">
                <textarea
                  className="textarea"
                  rows={5}
                  value={settings.customInstructions}
                  spellCheck={false}
                  placeholder={'- Use pnpm, never npm\n- Run `pnpm typecheck` before finishing\n- Never modify src/legacy/**'}
                  onChange={(e) => void setSettings({ customInstructions: e.target.value })}
                />
              </Field>
            </Section>
          )}

          {tab === 'appearance' && (
            <Section title="Appearance" desc="Monospace everywhere, by design. Pick a palette that suits your monitor.">
              <Field label="Theme">
                <div className="theme-grid">
                  {THEMES.map((t) => (
                    <button key={t.id} className="theme-card" data-active={settings.theme === t.id} onClick={() => void setSettings({ theme: t.id })}>
                      <span className={`theme-preview theme-${t.id}`}>
                        <span className="tp-bg" />
                        <span className="tp-line" />
                        <span className="tp-line short" />
                        <span className="tp-acc" />
                      </span>
                      <span className="t-xs">{t.label}</span>
                      {settings.theme === t.id && <Icon name="check" size={10} className="acc" style={{ marginLeft: 'auto' }} />}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Accent">
                <div className="swatches">
                  {ACCENTS.map((c) => (
                    <button key={c} className="swatch" data-active={settings.accent === c} style={{ background: c }} onClick={() => void setSettings({ accent: c })} />
                  ))}
                  <input type="color" className="swatch-input" value={settings.accent} onChange={(e) => void setSettings({ accent: e.target.value })} />
                </div>
              </Field>
              <Row label="Interface scale" hint={`${Math.round(settings.uiScale * 100)}%`}>
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
              <Row label="Font size" hint={`${settings.fontSize}px — applies to chat, panels and editor`}>
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
              <Toggle label="Programming ligatures" hint="Turn => into ⇒, != into ≠, etc." value={settings.fontLigatures} onChange={(v) => void setSettings({ fontLigatures: v })} />
              <Toggle label="Reduce motion" hint="Disables transitions and stream animations." value={settings.reducedMotion} onChange={(v) => void setSettings({ reducedMotion: v })} />
              <div className="type-sample">
                <div className="cap" style={{ marginBottom: 6 }}>type specimen</div>
                <div className="mono" style={{ fontSize: settings.fontSize + 4, color: 'var(--fg-0)' }}>
                  const comb = async () =&gt; 0xFF &amp;&amp; a !== b;
                </div>
                <div className="mono t-xs faint">JetBrains Mono · 100–800 · cyrillic + latin · {settings.fontLigatures ? 'ligatures on' : 'ligatures off'}</div>
              </div>
            </Section>
          )}

          {tab === 'editor' && (
            <Section title="Editor" desc="The editor is for reviewing what the agent did — and fixing it yourself.">
              <Toggle label="Line numbers" value={settings.showLineNumbers} onChange={(v) => void setSettings({ showLineNumbers: v })} />
              <Toggle label="Soft wrap" value={settings.wordWrap} onChange={(v) => void setSettings({ wordWrap: v })} />
              <Toggle label="Auto-save on agent edits" hint="Agent writes reload into open tabs automatically." value={settings.autoSave} onChange={(v) => void setSettings({ autoSave: v })} />
              <Row label="Tab size" hint={`${settings.tabSize} spaces`}>
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
            <Section title="Terminal" desc="A real shell in your workspace. The agent uses the same working directory.">
              <Field label="Shell" hint={window.comb.app.platform === 'win32' ? 'powershell.exe, cmd.exe, or bash.exe (Git Bash)' : '/bin/zsh, /bin/bash, /bin/fish'}>
                <input
                  className="input"
                  value={settings.shell}
                  spellCheck={false}
                  placeholder={window.comb.app.platform === 'win32' ? 'powershell.exe' : '/bin/bash'}
                  onChange={(e) => void setSettings({ shell: e.target.value })}
                />
              </Field>
              <Row label="Terminal font size" hint={`${settings.terminalFontSize}px`}>
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
                  If the native PTY module is unavailable on this machine, Comb falls back to a pipe shell: commands, git and npm work; full-screen TUI apps do not.
                </span>
              </div>
            </Section>
          )}

          {tab === 'shortcuts' && <Shortcuts />}

          {tab === 'about' && (
            <Section title="Comb Chat" desc="An AI coding agent on your desktop. Bring your own key.">
              <div className="about-grid">
                <Row label="Version" hint={window.comb.app.version || '1.0.0'} />
                <Row label="Platform" hint={`${window.comb.app.platform} · electron ${window.comb.app.electron} · node ${window.comb.app.node}`} />
                <Row label="Repository" hint="github.com/ZenlichKrim/Comb-Chat" />
                <Row label="Licence" hint="MIT" />
              </div>
              <div className="info-box">
                <Icon name="shield" size={12} />
                <span className="t-xs faint">
                  Your API key is stored in this machine's app-data folder and sent only to the endpoint you configure. No telemetry, no accounts, no servers in between.
                </span>
              </div>
              <div className="row gap-3" style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => window.comb.app.openExternal('https://platform.deepseek.com/api_keys')}>
                  <Icon name="external" size={11} /> DeepSeek keys
                </button>
                <button className="btn" onClick={() => window.comb.app.openExternal('https://github.com/ZenlichKrim/Comb-Chat')}>
                  <Icon name="external" size={11} /> GitHub
                </button>
                <button className="btn danger" onClick={async () => {
                  if (window.confirm('Delete all sessions? This cannot be undone.')) {
                    await window.comb.threads.clearAll()
                    useStore.setState({ threads: [], activeThreadId: null })
                  }
                }}>
                  <Icon name="trash" size={11} /> clear all sessions
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
  const groups: [string, [string, string][]][] = [
    ['Chat', [['Ctrl N', 'New session'], ['Enter', 'Send message'], ['Shift Enter', 'Newline'], ['Esc', 'Stop / deny approval'], ['Up', 'Edit last message']]],
    ['Navigation', [['Ctrl K', 'Command palette'], ['Ctrl P', 'Quick open file'], ['Ctrl Shift F', 'Search in files'], ['Ctrl B', 'Toggle sidebar'], ['Ctrl `', 'Toggle terminal'], ['Ctrl J', 'Toggle right panel']]],
    ['Files', [['Ctrl O', 'Open folder'], ['Ctrl S', 'Save file'], ['Ctrl W', 'Close tab'], ['Ctrl Shift A', 'Attach selection to chat']]],
    ['App', [['Ctrl ,', 'Settings'], ['Ctrl R', 'Reload'], ['F11', 'Fullscreen'], ['Ctrl +/-', 'Zoom']]]
  ]
  return (
    <Section title="Keyboard" desc="Everything reachable from the keys. Built for people who don't move their hands.">
      <div className="shortcut-grid">
        {groups.map(([name, rows]) => (
          <div key={name} className="shortcut-group">
            <div className="cap" style={{ marginBottom: 8 }}>{name}</div>
            {rows.map(([k, label]) => (
              <div key={k} className="shortcut-row">
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
