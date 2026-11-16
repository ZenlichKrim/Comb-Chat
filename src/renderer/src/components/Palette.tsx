import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { useStore } from '../store'
import type { SearchHit } from '../../../shared/types'

interface Command {
  id: string
  label: string
  hint?: string
  icon: IconName
  keys?: string
  run: () => void
}

export function CommandPalette(): React.ReactElement {
  const palette = useStore((s) => s.palette)
  const setPalette = useStore((s) => s.setPalette)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [files, setFiles] = useState<{ path: string; rel: string }[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const workspace = useStore((s) => s.workspace)

  const close = (): void => {
    setPalette({ open: false })
    setQuery('')
    setIndex(0)
  }

  useEffect(() => {
    if (palette.open) {
      setTimeout(() => inputRef.current?.focus(), 30)
      setIndex(0)
    } else {
      setQuery('')
    }
  }, [palette.open])

  const commands = useMemo<Command[]>(() => {
    const st = useStore.getState()
    const base: Command[] = [
      { id: 'new', label: 'New session', icon: 'plus', keys: 'Ctrl N', run: () => st.newThread() },
      { id: 'open', label: 'Open folder…', icon: 'folder', keys: 'Ctrl O', run: () => void st.openWorkspace() },
      { id: 'settings', label: 'Open settings', icon: 'settings', keys: 'Ctrl ,', run: () => useStore.setState({ settingsOpen: true }) },
      { id: 'save', label: 'Save file', icon: 'save', keys: 'Ctrl S', run: () => void st.saveTab() },
      { id: 'saveall', label: 'Save all files', icon: 'save', run: () => void st.saveAllTabs() },
      { id: 'terminal', label: 'Toggle terminal', icon: 'terminal', keys: 'Ctrl `', run: () => st.setBottomPanel(st.bottomPanel === 'terminal' ? 'none' : 'terminal') },
      { id: 'output', label: 'Show agent activity', icon: 'zap', run: () => st.setBottomPanel('output') },
      { id: 'plan', label: 'Toggle plan panel', icon: 'check-circle', keys: 'Ctrl J', run: () => st.setRightPanel(st.rightPanel === 'none' ? 'plan' : 'none') },
      { id: 'history', label: 'Show checkpoints', icon: 'history', run: () => st.setRightPanel('history') },
      { id: 'context', label: 'Show context panel', icon: 'layers', run: () => st.setRightPanel('context') },
      { id: 'undo-run', label: 'Undo last agent run', icon: 'undo', run: () => void st.undoLastRun() },
      { id: 'approve', label: 'Approval policy: ask first', icon: 'shield', run: () => void st.setSettings({ approvalPolicy: 'ask' }) },
      { id: 'autoedit', label: 'Approval policy: auto-edit', icon: 'edit', run: () => void st.setSettings({ approvalPolicy: 'auto-edit' }) },
      { id: 'yolo', label: 'Approval policy: yolo', icon: 'zap', run: () => void st.setSettings({ approvalPolicy: 'yolo' }) },
      { id: 'git', label: 'Refresh source control', icon: 'git', run: () => void st.refreshGit() },
      { id: 'theme', label: 'Cycle theme', icon: 'sun', run: () => {
        const order = ['comb', 'midnight', 'graphite', 'amber', 'nord', 'paper'] as const
        const idx = order.indexOf(st.settings.theme as any)
        void st.setSettings({ theme: order[(idx + 1) % order.length] })
      } },
      { id: 'stop', label: 'Stop the agent', icon: 'stop', run: () => void st.stopRun() }
    ]
    for (const t of st.tabs) {
      base.push({ id: `tab-${t.path}`, label: `Switch to ${t.rel}`, icon: 'file', run: () => st.setActiveTab(t.path) })
    }
    for (const p of searchShortcuts()) base.push(p)
    return base
  }, [])

  const results = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (palette.mode === 'files' || (q && !palette.mode)) {
      return []
    }
    if (!q) return commands.slice(0, 60)
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.id.includes(q)).slice(0, 60)
  }, [commands, query, palette.mode])

  // file quick-open
  useEffect(() => {
    if (!palette.open || !workspace) return
    if (!query.trim() || (palette.mode !== 'files' && commands.some((c) => c.label.toLowerCase().includes(query.toLowerCase())))) {
      if (palette.mode !== 'files') return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      const res = (await window.comb.fs.findFiles(workspace, query, { max: 60 })) as { path: string; rel: string }[]
      if (!cancelled) setFiles(res)
    }, 90)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, workspace, palette.open, palette.mode, commands])

  const items: { kind: 'cmd'; cmd: Command }[] | { kind: 'file'; file: { path: string; rel: string } }[] =
    (palette.mode === 'files' && files.length ? files.map((file) => ({ kind: 'file' as const, file })) : results.map((cmd) => ({ kind: 'cmd' as const, cmd }))) as any

  const flat = Array.isArray(items) ? items : []

  const run = (item: any): void => {
    if (item.kind === 'file') {
      void useStore.getState().openFile(item.file.path, item.file.rel)
    } else item.cmd.run()
    close()
  }

  useEffect(() => {
    if (!palette.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex((i) => Math.min(i + 1, flat.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (flat[index]) run(flat[index])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    const el = listRef.current?.querySelector('.palette-item[data-active="true"]') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!palette.open) return <></>

  return (
    <div className="palette-backdrop" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-wrap">
          <Icon name={palette.mode === 'files' ? 'file' : 'command'} size={13} className="faint" />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            placeholder={palette.mode === 'files' ? 'Go to file…' : 'Type a command or search…'}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {flat.map((item: any, i) => (
            <button
              key={item.kind === 'file' ? item.file.path : item.cmd.id}
              className="palette-item"
              data-active={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(item)}
            >
              <Icon name={item.kind === 'file' ? 'file' : item.cmd.icon} size={12} className={i === index ? 'acc' : 'faint'} />
              <span className="ellipsis">{item.kind === 'file' ? item.file.rel : item.cmd.label}</span>
              <span className="spacer" />
              {item.kind === 'cmd' && item.cmd.keys && (
                <span className="kbd-group">
                  {item.cmd.keys.split(' ').map((k: string) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              )}
            </button>
          ))}
          {palette.mode === 'files' && !flat.length && query && <div className="palette-empty">No files match</div>}
          {!flat.length && !query && <div className="palette-empty">Start typing…</div>}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
          <span className="spacer" />
          <span>{flat.length} results</span>
        </div>
      </div>
    </div>
  )
}

function searchShortcuts(): Command[] {
  const st = useStore.getState()
  return [
    { id: 'search-files', label: 'Search in files', icon: 'search', keys: 'Ctrl Shift F', run: () => useStore.setState({ sidebarSection: 'search', sidebarOpen: true }) },
    { id: 'new-file', label: 'New file in workspace', icon: 'file-plus', run: () => st.toast('info', 'Right-click in the explorer to create files') }
  ]
}

/** Full-screen diff modal opened from a tool card. */
export function DiffModal(): React.ReactElement {
  const diff = useStore((s) => s.diffPreview)
  const close = useStore((s) => s.closeDiff)
  if (!diff) return <></>
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-modal-head">
          <span className="pill acc">{diff.kind}</span>
          <span className="mono t-sm ellipsis">{diff.rel}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={close}>
            <Icon name="close" size={12} />
          </button>
        </div>
        <DiffFull before={diff.before} after={diff.after} rel={diff.rel} />
      </div>
    </div>
  )
}

import { DiffView } from './CodeBlock'
function DiffFull({ before, after, rel }: { before: string; after: string; rel: string }): React.ReactElement {
  return <DiffView before={before} after={after} rel={rel} maxHeight={window.innerHeight - 160} />
}

export function Toasts(): React.ReactElement {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind} onClick={() => dismiss(t.id)}>
          <Icon name={t.kind === 'err' ? 'x-circle' : t.kind === 'warn' ? 'alert' : t.kind === 'ok' ? 'check-circle' : 'info'} size={12} />
          <div className="col" style={{ gap: 1, minWidth: 0 }}>
            <span className="t-sm">{t.text}</span>
            {t.detail && <span className="t-xs faint ellipsis selectable">{t.detail}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

export function AboutDialog(): React.ReactElement {
  const open = useStore((s) => s.aboutOpen)
  if (!open) return <></>
  return (
    <div className="modal-backdrop" onClick={() => useStore.setState({ aboutOpen: false })}>
      <div className="about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-mark"><Icon name="bee" size={34} strokeWidth={1.1} /></div>
        <h1 className="about-title">Comb<span className="acc">.</span></h1>
        <p className="t-sm faint" style={{ textAlign: 'center', lineHeight: 1.7 }}>
          A desktop coding agent with hands.
          <br />
          Reads your repo, edits files, runs your tests.
        </p>
        <div className="about-meta">
          <span>v{window.comb.app.version || '1.0.0'}</span>
          <span className="ghost">·</span>
          <span>{window.comb.app.platform}</span>
          <span className="ghost">·</span>
          <span>electron {window.comb.app.electron}</span>
        </div>
        <div className="row gap-3" style={{ marginTop: 18 }}>
          <button className="btn" onClick={() => window.comb.app.openExternal('https://github.com/ZenlichKrim/Comb-Chat')}>
            <Icon name="external" size={11} /> source
          </button>
          <button className="btn primary" onClick={() => useStore.setState({ aboutOpen: false, settingsOpen: true })}>
            settings
          </button>
        </div>
      </div>
    </div>
  )
}
