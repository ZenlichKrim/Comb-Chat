import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { useStore } from '../store'
import { useT } from '../lib/i18n'
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
  const t = useT()
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
      { id: 'new', label: t('cmd.new'), icon: 'plus', keys: 'Ctrl N', run: () => st.newThread() },
      { id: 'open', label: t('cmd.open'), icon: 'folder', keys: 'Ctrl O', run: () => void st.openWorkspace() },
      { id: 'settings', label: t('cmd.settings'), icon: 'settings', keys: 'Ctrl ,', run: () => useStore.setState({ settingsOpen: true }) },
      { id: 'save', label: t('cmd.save'), icon: 'save', keys: 'Ctrl S', run: () => void st.saveTab() },
      { id: 'saveall', label: t('cmd.saveAll'), icon: 'save', run: () => void st.saveAllTabs() },
      { id: 'terminal', label: t('cmd.terminal'), icon: 'terminal', keys: 'Ctrl `', run: () => st.setBottomPanel(st.bottomPanel === 'terminal' ? 'none' : 'terminal') },
      { id: 'output', label: t('cmd.output'), icon: 'zap', run: () => st.setBottomPanel('output') },
      { id: 'plan', label: t('cmd.plan'), icon: 'check-circle', keys: 'Ctrl J', run: () => st.setRightPanel(st.rightPanel === 'none' ? 'plan' : 'none') },
      { id: 'history', label: t('cmd.history'), icon: 'history', run: () => st.setRightPanel('history') },
      { id: 'context', label: t('cmd.context'), icon: 'layers', run: () => st.setRightPanel('context') },
      { id: 'undo-run', label: t('cmd.undoRun'), icon: 'undo', run: () => void st.undoLastRun() },
      { id: 'approve', label: t('cmd.policyAsk'), icon: 'shield', run: () => void st.setSettings({ approvalPolicy: 'ask' }) },
      { id: 'autoedit', label: t('cmd.policyAuto'), icon: 'edit', run: () => void st.setSettings({ approvalPolicy: 'auto-edit' }) },
      { id: 'yolo', label: t('cmd.policyYolo'), icon: 'zap', run: () => void st.setSettings({ approvalPolicy: 'yolo' }) },
      { id: 'git', label: t('cmd.git'), icon: 'git', run: () => void st.refreshGit() },
      { id: 'theme', label: t('cmd.theme'), icon: 'sun', run: () => {
        const order = ['comb', 'midnight', 'graphite', 'electric', 'nord', 'paper'] as const
        const idx = order.indexOf(st.settings.theme as any)
        void st.setSettings({ theme: order[(idx + 1) % order.length] })
      } },
      { id: 'stop', label: t('cmd.stop'), icon: 'stop', run: () => void st.stopRun() }
    ]
    for (const tab of st.tabs) {
      base.push({ id: `tab-${tab.path}`, label: t('cmd.switchTo', { file: tab.rel }), icon: 'file', run: () => st.setActiveTab(tab.path) })
    }
    for (const p of searchShortcuts(t)) base.push(p)
    return base
  }, [t, workspace, palette.mode])

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
            placeholder={palette.mode === 'files' ? t('pal.goToFile') : t('pal.placeholder')}
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
          {palette.mode === 'files' && !flat.length && query && <div className="palette-empty">{t('pal.noFiles')}</div>}
          {!flat.length && !query && <div className="palette-empty">{t('pal.startTyping')}</div>}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('pal.navigate')}</span>
          <span><kbd>↵</kbd> {t('pal.run')}</span>
          <span><kbd>esc</kbd> {t('pal.close')}</span>
          <span className="spacer" />
          <span>{t('pal.results', { n: flat.length })}</span>
        </div>
      </div>
    </div>
  )
}

function searchShortcuts(t: (k: any, v?: Record<string, string | number>) => string): Command[] {
  const st = useStore.getState()
  return [
    { id: 'search-files', label: t('cmd.searchFiles'), icon: 'search', keys: 'Ctrl Shift F', run: () => useStore.setState({ sidebarSection: 'search', sidebarOpen: true }) },
    { id: 'new-file', label: t('cmd.newFile'), icon: 'file-plus', run: () => st.toast('info', t('cmd.newFileHint')) }
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
        <DiffView before={diff.before} after={diff.after} rel={diff.rel} maxHeight={window.innerHeight - 160} />
      </div>
    </div>
  )
}

import { DiffView } from './CodeBlock'

/* ------------------------------------------------------------------ */
/* File preview                                                        */
/* ------------------------------------------------------------------ */

const EXT_META: { re: RegExp; icon: IconName; kind: string; tint: string }[] = [
  { re: /^tsx?$/, icon: 'code', kind: 'ts', tint: '#4f9cf5' },
  { re: /^jsx?$|^mjs$|^cjs$/, icon: 'code', kind: 'js', tint: '#e8c04c' },
  { re: /^json$|^jsonc$|^ya?ml$|^toml$|^ini$|^env$/, icon: 'braces', kind: 'json', tint: '#b58cf0' },
  { re: /^md$|^mdx$|^txt$|^rst$/, icon: 'file', kind: 'md', tint: '#9fb3c8' },
  { re: /^css$|^scss$|^sass$|^less$/, icon: 'braces', kind: 'css', tint: '#6fc3df' },
  { re: /^html?$|^vue$|^svelte$/, icon: 'code', kind: 'html', tint: '#e08a5a' },
  { re: /^py$/, icon: 'code', kind: 'py', tint: '#6cc48a' },
  { re: /^rs$/, icon: 'code', kind: 'rs', tint: '#d98a6a' },
  { re: /^go$/, icon: 'code', kind: 'go', tint: '#5fbcd8' },
  { re: /^png$|^jpe?g$|^gif$|^webp$|^svg$|^ico$|^bmp$/, icon: 'image', kind: 'img', tint: '#c79bf0' },
  { re: /^sh$|^bash$|^zsh$|^ps1$|^bat$/, icon: 'terminal', kind: 'sh', tint: '#8fbf6f' },
  { re: /^zip$|^tar$|^gz$|^7z$|^rar$|^dmg$|^exe$|^apk$|^jar$/, icon: 'layers', kind: 'bin', tint: '#b0a08a' },
  { re: /^pdf$/, icon: 'file', kind: 'pdf', tint: '#e07070' },
  { re: /^lock$/, icon: 'shield', kind: 'lock', tint: '#b0a08a' },
  { re: /^l?o?g$/, icon: 'history', kind: 'log', tint: '#b0a08a' }
]

function extOf(p: string): string {
  const base = p.split(/[\\/]/).pop() || p
  const m = /\.([a-z0-9]+)$/i.exec(base)
  return m ? m[1].toLowerCase() : ''
}

function fileMeta(p: string): { icon: IconName; kind: string; tint: string } {
  const ext = extOf(p)
  return EXT_META.find((m) => m.re.test(ext)) || { icon: 'file', kind: ext || 'file', tint: 'var(--fg-3)' }
}

function formatBytes(n?: number): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Preview for a file the agent handed over.
 *
 * A blur veil behind, then a portrait card: subtitle line, the file itself with
 * a type tile, its name and weight, and a grid of wide rectangular actions at
 * the bottom. The description is written by the model only when the file is
 * worth one (see `describe.ts`), so most of them arrive already labelled.
 */
export function FilePreviewModal(): React.ReactElement {
  const t = useT()
  const preview = useStore((s) => s.filePreview)
  const setPreview = useStore((s) => s.setFilePreview)
  const openFile = useStore((s) => s.openFile)
  const toast = useStore((s) => s.toast)
  const [body, setBody] = React.useState<string>('')
  const [size, setSize] = React.useState<number | undefined>(undefined)
  const [lines, setLines] = React.useState<number>(0)
  const [err, setErr] = React.useState('')
  const [summary, setSummary] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [wrap, setWrap] = React.useState(true)

  React.useEffect(() => {
    if (!preview) return
    setBody('')
    setErr('')
    setSummary('')
    setSize(undefined)
    setLines(0)
    const meta = fileMeta(preview.path)
    const img = meta.kind === 'img'
    void window.comb.files.summaries([preview.path]).then((rows) => {
      if (rows[0]?.description) setSummary(rows[0].description)
    })
    if (img) {
      void window.comb.fs.readImage(preview.path).then((r) => {
        if (r?.ok && r.dataUrl) setBody(r.dataUrl)
        else setErr(r?.error || 'Cannot read image')
      })
      return
    }
    void window.comb.fs
      .read(preview.path)
      .then((fc) => {
        setBody(fc.content || '')
        setSize(fc.size)
        setLines((fc.content || '').split('\n').length)
      })
      .catch((e: any) => setErr(e?.message || 'Cannot read file'))
  }, [preview])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPreview(null)
    }
    if (preview) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview, setPreview])

  if (!preview) return <></>

  const meta = fileMeta(preview.path)
  const base = preview.rel.split('/').pop() || preview.rel
  const ext = extOf(preview.path)
  const dir = preview.rel.includes('/') ? preview.rel.slice(0, preview.rel.lastIndexOf('/')) : ''

  const describe = async (): Promise<void> => {
    setBusy(true)
    const res = await window.comb.files.describe(preview.path)
    setBusy(false)
    if (res.ok && res.summary) setSummary(res.summary.description)
    else if (res.ok) toast('warn', t('fp.notWorth'))
    else toast('err', t('fp.describeFailed'), res.error)
  }

  const open = (): void => {
    setPreview(null)
    void openFile(preview.path, preview.rel)
  }

  const copy = (text: string, msg: string): void => {
    window.comb.clipboard.write(text)
    toast('ok', msg)
  }

  return (
    <div className="modal-backdrop" onClick={() => setPreview(null)}>
      <div className="file-modal" onClick={(e) => e.stopPropagation()}>
        <div className="file-modal-sub">
          <span className="file-modal-kicker">{t('fp.kicker')}</span>
          <span className="file-modal-sep">·</span>
          <span className="mono ellipsis">{base}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setPreview(null)} title={t('common.close')}>
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="file-modal-ident">
          <span className="file-type-tile" style={{ color: meta.tint }}>
            <Icon name={meta.icon} size={20} strokeWidth={1.3} />
            <span className="file-type-ext">{ext || 'file'}</span>
          </span>
          <span className="col" style={{ minWidth: 0, gap: 2 }}>
            <span className="file-modal-name ellipsis" title={preview.rel}>{base}</span>
            <span className="file-modal-meta mono t-xs faint">
              {[formatBytes(size), lines ? t('fp.lines', { n: lines }) : '', dir].filter(Boolean).join('  ·  ')}
            </span>
          </span>
        </div>

        {(summary || busy) && (
          <div className="file-modal-summary">
            <Icon name="sparkles" size={11} className="acc" />
            <span className="t-xs dim">{busy ? t('fp.describing') : summary}</span>
          </div>
        )}
        {preview.note && <div className="file-modal-note t-xs faint">{preview.note}</div>}

        <div className="file-modal-body">
          {err ? (
            <div className="t-xs err" style={{ padding: 14 }}>{err}</div>
          ) : meta.kind === 'img' ? (
            body && <img src={body} alt={preview.rel} className="file-modal-img" />
          ) : (
            <pre className="file-modal-pre" data-wrap={wrap}>{body || t('fp.loading')}</pre>
          )}
        </div>

        <div className="file-modal-actions">
          <button className="file-act primary" onClick={open}>
            <Icon name="file" size={13} /> {t('fp.open')}
          </button>
          <button className="file-act" onClick={() => window.comb.app.showItemInFolder(preview.path)}>
            <Icon name="folder" size={13} /> {t('fp.reveal')}
          </button>
          <button className="file-act" onClick={() => copy(preview.path, t('fp.copied'))}>
            <Icon name="copy" size={13} /> {t('fp.copyPath')}
          </button>
          {meta.kind !== 'img' && (
            <button className="file-act" onClick={() => copy(body, t('fp.copiedAll'))} disabled={!body}>
              <Icon name="copy" size={13} /> {t('fp.copyAll')}
            </button>
          )}
          {meta.kind !== 'img' && (
            <button className="file-act" onClick={() => setWrap((v) => !v)}>
              <Icon name="diff" size={13} /> {wrap ? t('fp.nowrap') : t('fp.wrap')}
            </button>
          )}
          <button className="file-act" onClick={() => void describe()} disabled={busy}>
            <Icon name="sparkles" size={13} /> {summary ? t('fp.redescribe') : t('fp.describe')}
          </button>
        </div>
      </div>
    </div>
  )
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
  const t = useT()
  const open = useStore((s) => s.aboutOpen)
  if (!open) return <></>
  return (
    <div className="modal-backdrop" onClick={() => useStore.setState({ aboutOpen: false })}>
      <div className="about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-mark"><Icon name="bee" size={34} strokeWidth={1.1} /></div>
        <h1 className="about-title">Comb<span className="acc">.</span></h1>
        <p className="t-sm faint" style={{ textAlign: 'center', lineHeight: 1.7 }}>
          {t('about.blurb1')}
          <br />
          {t('about.blurb2')}
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
            <Icon name="external" size={11} /> {t('about.source')}
          </button>
          <button className="btn primary" onClick={() => useStore.setState({ aboutOpen: false, settingsOpen: true })}>
            {t('set.title')}
          </button>
        </div>
      </div>
    </div>
  )
}
