import React, { useEffect, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { EditorPane } from './components/Editor'
import { ChatPane } from './components/Chat'
import { RightPanel } from './components/RightPanel'
import { BottomPanel } from './components/Terminal'
import { StatusBar } from './components/StatusBar'
import { SettingsDialog } from './components/Settings'
import { CommandPalette, Toasts, DiffModal, AboutDialog } from './components/Palette'
import { useStore } from './store'
import { Icon } from './components/Icon'

export function App(): React.ReactElement {
  const ready = useStore((s) => s.ready)
  const boot = useStore((s) => s.boot)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const rightPanel = useStore((s) => s.rightPanel)
  const bottomPanel = useStore((s) => s.bottomPanel)
  const workspace = useStore((s) => s.workspace)
  const [splitter, setSplitter] = useState(0.52)
  const [dragging, setDragging] = useState(false)
  const [chatCollapsed, setChatCollapsed] = useState(false)

  useEffect(() => {
    void boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      const top = 38
      const bottom = window.innerHeight - 26 - (bottomPanel === 'none' ? 0 : useStore.getState().bottomPanelHeight)
      const frac = (e.clientX - 260) / (window.innerWidth - 260)
      setSplitter(Math.max(0.22, Math.min(0.78, frac)))
    }
    const up = (): void => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging, bottomPanel])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const st = useStore.getState()
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        st.setPalette({ open: true, mode: 'commands' })
      } else if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) {
        e.preventDefault()
        st.setPalette({ open: true, mode: 'files' })
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        st.setPalette({ open: true, mode: 'commands' })
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        useStore.setState({ sidebarOpen: !st.sidebarOpen })
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        st.setRightPanel(st.rightPanel === 'none' ? 'plan' : 'none')
      } else if (mod && e.key === '`') {
        e.preventDefault()
        st.setBottomPanel(st.bottomPanel === 'terminal' ? 'none' : 'terminal')
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void st.openWorkspace()
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        st.newThread()
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void st.saveTab()
      } else if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (st.activeTabPath) st.closeTab(st.activeTabPath)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        useStore.setState({ sidebarOpen: true, sidebarSection: 'search' })
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        window.dispatchEvent(new Event('comb:attach-selection'))
      } else if (mod && e.key === ',') {
        e.preventDefault()
        useStore.setState({ settingsOpen: true })
      } else if (e.key === 'Escape' && st.running) {
        st.stopRun()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark">
          <Icon name="bee" size={40} strokeWidth={1.1} />
        </div>
        <div className="boot-text">
          comb<span className="acc">.</span>
        </div>
        <div className="boot-bar"><span /></div>
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        {sidebarOpen && <Sidebar />}
        <div className="workspace-area">
          <div className="main-split">
            <div className="editor-col" style={{ flex: chatCollapsed ? 1 : splitter }}>
              <EditorPane />
            </div>
            <div className="split-handle" onMouseDown={() => setDragging(true)} data-active={dragging}>
              <button
                className="collapse-btn"
                data-tip={chatCollapsed ? 'Show chat' : 'Collapse chat'}
                onClick={() => setChatCollapsed((v) => !v)}
              >
                <Icon name={chatCollapsed ? 'chevron-left' : 'chevron-right'} size={9} />
              </button>
            </div>
            <div className="chat-col" style={{ flex: chatCollapsed ? 0 : 1 - splitter, display: chatCollapsed ? 'none' : 'flex' }}>
              <ChatPane />
            </div>
            {rightPanel !== 'none' && <RightPanel />}
          </div>
          {bottomPanel !== 'none' && <BottomPanel />}
        </div>
      </div>
      <StatusBar />
      <SettingsDialog />
      <CommandPalette />
      <DiffModal />
      <AboutDialog />
      <Toasts />
      <OnboardingOverlay />
    </div>
  )
}

function OnboardingOverlay(): React.ReactElement {
  const settings = useStore((s) => s.settings)
  const [dismissed, setDismissed] = useState<boolean>(() => !!useStore.getState().settings.apiKey)
  const setSettings = useStore((s) => s.setSettings)
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [step, setStep] = useState(0)
  const setSettingsOpen = (): void => useStore.setState({ settingsOpen: true })

  const connect = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    const res = (await window.comb.agent.testKey(key.trim(), settings.baseUrl)) as { ok: boolean; message: string }
    setResult(res)
    setTesting(false)
    if (res.ok) {
      await setSettings({ apiKey: key.trim() })
      setStep(2)
    }
  }

  if (dismissed) return <></>

  return (
    <div className="onb-overlay">
      <div className="onb-modal">
        <div className="onb-modal-head">
          <div className="onb-mark lg"><Icon name="bee" size={26} strokeWidth={1.2} /></div>
          <div className="col" style={{ gap: 3 }}>
            <h1 className="t-lg" style={{ margin: 0, fontWeight: 700, color: 'var(--fg-0)' }}>
              Welcome to Comb<span className="acc">.</span>
            </h1>
            <span className="t-xs faint">A desktop coding agent — no subscription, your own API key.</span>
          </div>
        </div>

        {step === 0 && (
          <>
            <div className="onb-steps">
              {[
                ['key', 'Paste your DeepSeek API key', 'Stored locally, sent only to api.deepseek.com'],
                ['folder', 'Open a project folder', 'Comb reads, edits and runs things inside it'],
                ['shield', 'You stay in control', 'Every write asks first — until you say otherwise']
              ].map(([icon, title, desc], i) => (
                <div key={title} className="onb-step">
                  <span className="onb-step-num">{i + 1}</span>
                  <Icon name={icon as any} size={14} className="acc" />
                  <div className="col" style={{ gap: 1 }}>
                    <span className="t-sm" style={{ color: 'var(--fg-0)' }}>{title}</span>
                    <span className="t-xs faint">{desc}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="onb-field">
              <label className="cap">deepseek api key</label>
              <div className="row gap-2">
                <input
                  className="input"
                  type="password"
                  value={key}
                  placeholder="sk-…"
                  spellCheck={false}
                  style={{ fontFamily: 'var(--font-code)' }}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && key) void connect()
                  }}
                />
                <button className="btn primary" onClick={() => void connect()} disabled={!key || testing}>
                  {testing ? <span className="spinner" /> : <Icon name="arrow-right" size={12} />} connect
                </button>
              </div>
              {result && (
                <div className={`test-result ${result.ok ? 'ok' : 'err'}`}>
                  <Icon name={result.ok ? 'check-circle' : 'x-circle'} size={11} />
                  <span className="t-xs">{result.message}</span>
                </div>
              )}
              <div className="row gap-2" style={{ marginTop: 4 }}>
                <button className="link t-xs" onClick={() => window.comb.app.openExternal('https://platform.deepseek.com/api_keys')}>
                  get a key →
                </button>
                <span className="ghost">·</span>
                <button className="link t-xs" onClick={setSettingsOpen}>configure endpoint</button>
                <span className="spacer" />
                <button className="link t-xs faint" onClick={() => setDismissed(true)}>
                  skip for now
                </button>
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <div className="onb-done">
            <Icon name="check-circle" size={22} className="ok" />
            <span className="t-sm" style={{ color: 'var(--fg-0)' }}>Connected. Your key works.</span>
            <span className="t-xs faint" style={{ textAlign: 'center' }}>
              Open a folder to give Comb hands — or just start chatting.
            </span>
            <div className="row gap-3">
              <button className="btn primary" onClick={() => setDismissed(true)}>
                <Icon name="folder" size={12} /> open a folder
              </button>
              <button className="btn" onClick={() => setDismissed(true)}>
                later
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
