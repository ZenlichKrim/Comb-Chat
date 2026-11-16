import React, { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { Icon } from './Icon'
import { useT } from '../lib/i18n'
import { useStore, uid } from '../store'
import { highlightLine } from '../lib/highlight'
import type { GitFile } from '../../../shared/types'

export function BottomPanel(): React.ReactElement {
  const panel = useStore((s) => s.bottomPanel)
  const setPanel = useStore((s) => s.setBottomPanel)
  const height = useStore((s) => s.bottomPanelHeight)
  const git = useStore((s) => s.git)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      const h = Math.max(120, Math.min(window.innerHeight - 260, window.innerHeight - e.clientY))
      useStore.setState({ bottomPanelHeight: h })
    }
    const up = (): void => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging])

  if (panel === 'none') return <></>

  const t = useT()
  const problems = git?.files.filter((f) => f.index === '!').length || 0

  return (
    <div className="bottom-panel" style={{ height }}>
      <div className="bp-resize" onMouseDown={() => setDragging(true)} />
      <div className="bp-tabs">
        <button className="bp-tab" data-active={panel === 'terminal'} onClick={() => setPanel('terminal')}>
          <Icon name="terminal" size={11} /> {t('bp.terminal')}
        </button>
        <button className="bp-tab" data-active={panel === 'output'} onClick={() => setPanel('output')}>
          <Icon name="zap" size={11} /> {t('bp.output')}
        </button>
        <button className="bp-tab" data-active={panel === 'problems'} onClick={() => setPanel('problems')}>
          <Icon name="alert" size={11} /> {t('bp.problems')}
          {problems > 0 && <span className="pill err" style={{ height: 14 }}>{problems}</span>}
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => setPanel('none')} data-tip={t('bp.hide')}>
          <Icon name="close" size={11} />
        </button>
      </div>
      <div className="bp-body">
        {panel === 'terminal' && <TermTab />}
        {panel === 'output' && <OutputTab />}
        {panel === 'problems' && <ProblemsTab />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* xterm terminal                                                      */
/* ------------------------------------------------------------------ */

function readCssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function terminalTheme(): any {
  const bg = readCssVar('--bg-0', '#0b0a08')
  const fg = readCssVar('--fg-1', '#d9d3c6')
  const accent = readCssVar('--accent', '#e8b14c')
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: 'rgba(232,177,76,0.25)',
    black: '#1c1c1c',
    red: '#f2695f',
    green: '#6dcf8a',
    yellow: '#e9b949',
    blue: '#6aa9ef',
    magenta: '#d98fd8',
    cyan: '#7fd6c9',
    white: '#d9d3c6',
    brightBlack: '#5c5a52',
    brightRed: '#ff8a80',
    brightGreen: '#8ee6a8',
    brightYellow: '#ffd479',
    brightBlue: '#8fc3ff',
    brightMagenta: '#eaa8e8',
    brightCyan: '#9ee8dd',
    brightWhite: '#f3efe6'
  }
}

function TermTab(): React.ReactElement {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string>(uid('term'))
  const workspace = useStore((s) => s.workspace)
  const settings = useStore((s) => s.settings)
  const theme = useStore((s) => s.settings.theme)
  const [backend, setBackend] = useState<string>('')
  const [exited, setExited] = useState(false)
  const [key, setKey] = useState(0)

  useEffect(() => {
    if (!host.current) return
    const term = new XTerm({
      fontFamily: 'var(--font-code), JetBrains Mono, monospace',
      fontSize: settings.terminalFontSize,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowProposedApi: true,
      theme: terminalTheme(),
      letterSpacing: 0,
      macOptionIsMeta: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.comb.app.openExternal(uri)))
    term.open(host.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const id = idRef.current
    void window.comb.terminal.create({
      id,
      cwd: workspace || window.comb.app.homedir || '.',
      cols: term.cols,
      rows: term.rows,
      shell: settings.shell || undefined
    }).then((res) => {
      if (res) {
        setBackend(res.backend)
        if (res.backend === 'pipe') {
          term.writeln('\x1b[33m[comb] node-pty unavailable — using pipe shell. Commands work; full-screen TUIs do not.\x1b[0m')
        }
        term.writeln('\x1b[90m[comb] shell ready · ' + (workspace || '~') + '\x1b[0m')
      }
    })

    const offData = window.comb.terminal.onData((e) => {
      const ev = e as { id: string; data: string }
      if (ev.id === id) term.write(ev.data)
    })
    const offExit = window.comb.terminal.onExit((e) => {
      const ev = e as { id: string; code: number }
      if (ev.id === id) {
        setExited(true)
        term.writeln(`\r\n\x1b[90m[process exited with code ${ev.code}]\x1b[0m`)
      }
    })

    const onDataDisposable = term.onData((data) => window.comb.terminal.write(id, data))
    const onResize = term.onResize(({ cols, rows }) => window.comb.terminal.resize(id, cols, rows))
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* noop */
      }
    })
    ro.observe(host.current)

    term.focus()
    return () => {
      ro.disconnect()
      onDataDisposable.dispose()
      offData()
      offExit()
      term.dispose()
      window.comb.terminal.kill(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = settings.terminalFontSize
      fitRef.current?.fit()
    }
  }, [settings.terminalFontSize])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme()
  }, [theme])

  return (
    <div className="term-wrap">
      <div className="term-toolbar">
        <span className="pill">{backend || t('bp.starting')}</span>
        <span className="t-xs faint ellipsis">{workspace || '~'}</span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setKey((k) => k + 1)} data-tip={t('bp.restartShell')}>
          <Icon name="refresh" size={10} /> {t('common.restart')}
        </button>
        <button
          className="btn ghost sm"
          onClick={() => {
            window.comb.terminal.write(idRef.current, 'clear\n')
          }}
        >
          {t('bp.clear')}
        </button>
      </div>
      <div className="term-host" ref={host} />
      {exited && (
        <div className="term-exited">
          <span className="t-xs faint">{t('bp.shellExited')}</span>
          <button className="btn sm" onClick={() => setKey((k) => k + 1)}>
            <Icon name="play" size={10} /> {t('common.restart')}
          </button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Output (agent activity log)                                         */
/* ------------------------------------------------------------------ */

function OutputTab(): React.ReactElement {
  const t = useT()
  const threads = useStore((s) => s.threads)
  const activeId = useStore((s) => s.activeThreadId)
  const thread = threads.find((t) => t.id === activeId)
  const rows = (thread?.messages || []).flatMap((m) =>
    (m.tools || []).map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      arg: t.args?.path || t.args?.command || t.args?.pattern || '',
      ms: t.durationMs || 0,
      output: t.output || t.error || ''
    }))
  )

  return (
    <div className="output-list">
      {rows.length ? (
        rows.map((r) => (
          <details key={r.id} className="output-row">
            <summary>
              <span className={`pill ${r.status === 'ok' ? 'ok' : r.status === 'error' ? 'err' : ''}`}>{r.status}</span>
              <span className="mono t-xs acc">{r.name}</span>
              <span className="mono t-xs faint ellipsis">{String(r.arg).slice(0, 90)}</span>
              <span className="spacer" />
              <span className="t-xs ghost">{r.ms}ms</span>
            </summary>
            <pre className="output-pre">{r.output || '(no output)'}</pre>
          </details>
        ))
      ) : (
        <div className="t-xs faint" style={{ padding: 14 }}>{t('bp.noActivity')}</div>
      )}
    </div>
  )
}

function ProblemsTab(): React.ReactElement {
  const t = useT()
  const git = useStore((s) => s.git)
  const files: GitFile[] = git?.files || []
  return (
    <div className="problems-list">
      {files.length ? (
        files.map((f) => (
          <div key={f.path} className="problem-row">
            <span className={f.index === '?' ? 'pill ok' : 'pill warn'}>{f.index === '?' ? t('gitStatus.untracked') : f.index === 'M' ? t('tool.modified') : f.index === 'D' ? t('tool.deleted') : t('gitStatus.changed')}</span>
            <span className="mono t-xs">{f.path}</span>
          </div>
        ))
      ) : (
        <div className="t-xs faint" style={{ padding: 14 }}>{t('bp.noProblems')}</div>
      )}
    </div>
  )
}
