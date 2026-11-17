import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { useStore, timeAgo, uid } from '../store'
import { useT } from '../lib/i18n'
import type { DirEntry, SearchHit, GitFile } from '../../../shared/types'

export function Sidebar(): React.ReactElement {
  const t = useT()
  const section = useStore((s) => s.sidebarSection)
  const setSection = (v: 'files' | 'search' | 'git' | 'threads'): void => useStore.setState({ sidebarSection: v })
  const git = useStore((s) => s.git)
  const refreshGit = useStore((s) => s.refreshGit)
  const changes = (git?.files.length ?? 0)

  return (
    <aside className="sidebar">
      <div className="sb-tabs">
        <button className="sb-tab" data-active={section === 'files'} onClick={() => setSection('files')} data-tip={t('side.explorer')}>
          <Icon name="file" size={13} />
        </button>
        <button className="sb-tab" data-active={section === 'search'} onClick={() => setSection('search')} data-tip={t('side.searchTip')}>
          <Icon name="search" size={13} />
        </button>
        <button className="sb-tab" data-active={section === 'git'} onClick={() => { setSection('git'); void refreshGit() }} data-tip={t('side.sourceControl')}>
          <Icon name="git" size={13} />
          {changes > 0 && <span className="sb-badge">{changes > 99 ? '99+' : changes}</span>}
        </button>
        <button className="sb-tab" data-active={section === 'threads'} onClick={() => setSection('threads')} data-tip={t('side.sessionsTip')}>
          <Icon name="chat" size={13} />
        </button>
        <span className="spacer" />
      </div>
      <div className="sb-body">
        {section === 'files' && <FileTree />}
        {section === 'search' && <SearchPanel />}
        {section === 'git' && <GitPanel />}
        {section === 'threads' && <ThreadsPanel />}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* File tree                                                           */
/* ------------------------------------------------------------------ */

function FileTree(): React.ReactElement {
  const t = useT()
  const workspace = useStore((s) => s.workspace)
  const openWorkspace = useStore((s) => s.openWorkspace)
  const expanded = useStore((s) => s.expandedDirs)
  const dirCache = useStore((s) => s.dirCache)
  const toggleDir = useStore((s) => s.toggleDir)
  const openFile = useStore((s) => s.openFile)
  const refreshTree = useStore((s) => s.refreshTree)
  const toast = useStore((s) => s.toast)
  const activeTabPath = useStore((s) => s.activeTabPath)
  const [filter, setFilter] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: DirEntry | null } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const fileSummaries = useStore((s) => s.fileSummaries)
  const loadSummaries = useStore((s) => s.loadSummaries)
  const describeFileNow = useStore((s) => s.describeFileNow)
  const extraRoots = useStore((s) => s.extraRoots)
  const addRoot = useStore((s) => s.addRoot)
  const removeRoot = useStore((s) => s.removeRoot)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!workspace) {
    return (
      <div className="sb-empty">
        <div className="col gap-4" style={{ alignItems: 'center', textAlign: 'center', padding: '28px 16px' }}>
          <Icon name="folder" size={26} className="ghost" />
          <div className="t-sm dim">{t('side.noFolder')}</div>
          <button className="btn primary sm" onClick={() => void openWorkspace()}>
            <Icon name="folder" size={12} /> {t('common.openFolder')}
          </button>
        </div>
      </div>
    )
  }

  const rootEntries = dirCache[workspace] || []

  // pull any cached descriptions for files currently on screen (free: disk only)
  useEffect(() => {
    const paths: string[] = []
    const collect = (dir: string): void => {
      for (const e of dirCache[dir] || []) {
        if (e.isDir) {
          if (expanded.has(e.path)) collect(e.path)
        } else paths.push(e.path)
      }
    }
    collect(workspace)
    for (const r of extraRoots) collect(r)
    if (paths.length) void loadSummaries(paths)
  }, [dirCache, expanded, workspace, extraRoots, loadSummaries])
  const filtered = filter
    ? (function flatten(): DirEntry[] {
        const out: DirEntry[] = []
        const walk = (dir: string): void => {
          for (const e of dirCache[dir] || []) {
            if (e.name.toLowerCase().includes(filter.toLowerCase())) out.push(e)
            if (e.isDir && !e.ignored) walk(e.path)
          }
        }
        walk(workspace)
        return out
      })()
    : rootEntries

  const doAction = async (action: string, entry: DirEntry | null): Promise<void> => {
    setCtxMenu(null)
    try {
      if (action === 'new-file' || action === 'new-folder') {
        const base = entry ? (entry.isDir ? entry.path : entry.path.replace(/[\\/][^\\/]*$/, '')) : workspace
        const name = window.prompt(action === 'new-file' ? t('side.newFileName') : t('side.newFolderName'))
        if (!name) return
        await window.comb.fs.create(`${base}/${name}`, action === 'new-folder')
        await refreshTree(base)
        if (action === 'new-file') await openFile(`${base}/${name}`, name)
      } else if (action === 'rename' && entry) {
        setRenaming(entry.path)
        setNewName(entry.name)
      } else if (action === 'delete' && entry) {
        if (!window.confirm(t('side.deleteConfirm', { name: entry.name }))) return
        await window.comb.fs.remove(entry.path)
        await refreshTree(entry.path.replace(/[\\/][^\\/]*$/, ''))
      } else if (action === 'reveal' && entry) {
        window.comb.app.showItemInFolder(entry.path)
      } else if (action === 'copy-path' && entry) {
        window.comb.clipboard.write(entry.path)
        toast('ok', t('side.pathCopied'))
      }
    } catch (e: any) {
      toast('err', t('side.actionFailed'), e?.message)
    }
  }

  /** Describe every loaded text file under a folder, sequentially to be gentle on the API. */
  const describeDir = async (dir: string): Promise<void> => {
    setCtxMenu(null)
    const files: string[] = []
    const walk = (d: string): void => {
      for (const e of dirCache[d] || []) {
        if (e.isDir) walk(e.path)
        else files.push(e.path)
      }
    }
    walk(dir)
    const todo = files.slice(0, 40)
    if (!todo.length) {
      toast('warn', t('side.describeEmpty'))
      return
    }
    toast('info', t('side.describeStarted', { n: todo.length }))
    let done = 0
    for (const abs of todo) {
      if (fileSummaries[abs]) continue
      await describeFileNow(abs)
      done += 1
    }
    toast('ok', t('side.describeDone', { n: done }))
  }

  const commitRename = async (entry: DirEntry): Promise<void> => {
    const next = newName.trim()
    setRenaming(null)
    if (!next || next === entry.name) return
    const dir = entry.path.replace(/[\\/][^\\/]*$/, '')
    try {
      await window.comb.fs.rename(entry.path, `${dir}/${next}`)
      await refreshTree(dir)
    } catch (e: any) {
      toast('err', t('side.renameFailed'), e?.message)
    }
  }

  const renderEntry = (e: DirEntry, depth: number): React.ReactNode => {
    const isOpen = expanded.has(e.path)
    const isActive = activeTabPath === e.path
    return (
      <React.Fragment key={e.path}>
        <div
          className="tree-row"
          data-active={isActive}
          data-dim={e.ignored}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => {
            if (e.isDir) void toggleDir(e.path)
            else void openFile(e.path, e.rel)
          }}
          onContextMenu={(ev) => {
            ev.preventDefault()
            setCtxMenu({ x: ev.clientX, y: ev.clientY, entry: e })
          }}
          title={fileSummaries[e.path] ? `${e.rel} — ${fileSummaries[e.path]}` : e.rel}
        >
          {e.isDir ? (
            <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={10} className="tree-caret" />
          ) : (
            <span className="tree-caret" />
          )}
          {e.isDir ? <FolderIcon open={isOpen} /> : <FileIcon name={e.name} />}
          {renaming === e.path ? (
            <input
              className="tree-rename"
              autoFocus
              value={newName}
              onChange={(ev) => setNewName(ev.target.value)}
              onBlur={() => void commitRename(e)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') void commitRename(e)
                if (ev.key === 'Escape') setRenaming(null)
              }}
              onClick={(ev) => ev.stopPropagation()}
            />
          ) : (
            <span className="col" style={{ minWidth: 0, gap: 0, flex: 1 }}>
              <span className="tree-name ellipsis">{e.name}</span>
              {fileSummaries[e.path] && <span className="tree-desc ellipsis">{fileSummaries[e.path]}</span>}
            </span>
          )}
        </div>
        {e.isDir && isOpen && (dirCache[e.path] || []).map((child) => renderEntry(child, depth + 1))}
      </React.Fragment>
    )
  }

  return (
    <div className="tree">
      <div className="sb-section-head">
        <span className="cap ellipsis" title={workspace}>
          {workspace.split(/[\\/]/).filter(Boolean).pop()}
        </span>
        <span className="spacer" />
        <button className="icon-btn" data-tip={t('side.newFile')} onClick={() => void doAction('new-file', null)} style={{ width: 20, height: 20 }}>
          <Icon name="file-plus" size={12} />
        </button>
        <button className="icon-btn" data-tip={t('side.newFolder')} onClick={() => void doAction('new-folder', null)} style={{ width: 20, height: 20 }}>
          <Icon name="folder" size={12} />
        </button>
        <button className="icon-btn" data-tip={t('side.addFolderTip')} onClick={() => void addRoot()} style={{ width: 20, height: 20 }}>
          <Icon name="plus" size={11} />
        </button>
        <button className="icon-btn" data-tip={t('common.refresh')} onClick={() => void refreshTree()} style={{ width: 20, height: 20 }}>
          <Icon name="refresh" size={11} />
        </button>
      </div>
      <div className="tree-filter">
        <Icon name="search" size={11} className="faint" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('side.filterFiles')}
          spellCheck={false}
        />
        {filter && (
          <button className="icon-btn" style={{ width: 16, height: 16 }} onClick={() => setFilter('')}>
            <Icon name="close" size={10} />
          </button>
        )}
      </div>
      <div className="tree-scroll">
        {filter
          ? filtered.slice(0, 300).map((e) => (
              <div
                key={e.path}
                className="tree-row flat"
                data-active={activeTabPath === e.path}
                onClick={() => (e.isDir ? void toggleDir(e.path) : void openFile(e.path, e.rel))}
                title={e.rel}
              >
                {e.isDir ? <FolderIcon open={false} /> : <FileIcon name={e.name} />}
                <span className="tree-name ellipsis">
                  <span className="ghost">{e.rel.split('/').slice(0, -1).join('/')}{e.rel.includes('/') ? '/' : ''}</span>
                  {e.name}
                </span>
              </div>
            ))
          : rootEntries.map((e) => renderEntry(e, 0))}
        {!filter && !rootEntries.length && <div className="t-xs ghost" style={{ padding: 12 }}>{t('side.emptyFolder')}</div>}

        {/* extra folders the agent may also touch */}
        {extraRoots.map((root) => {
          const entries = dirCache[root] || []
          const label = root.split(/[\\/]/).filter(Boolean).pop() || root
          return (
            <div key={root} className="tree-extra-root">
              <div className="sb-section-head">
                <Icon name="folder" size={11} className="faint" />
                <span className="cap ellipsis" title={root}>{label}</span>
                <span className="spacer" />
                <button
                  className="icon-btn"
                  data-tip={t('side.removeFolder')}
                  style={{ width: 20, height: 20 }}
                  onClick={() => void removeRoot(root)}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
              {entries.map((e) => renderEntry(e, 0))}
              {!entries.length && (
                <div className="t-xs ghost" style={{ padding: '4px 12px 8px' }}>{t('side.emptyFolder')}</div>
              )}
            </div>
          )
        })}
      </div>
      {ctxMenu && (
        <>
          <div className="backdrop" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }} />
          <div className="menu ctx" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button className="menu-item" onClick={() => void doAction('new-file', ctxMenu.entry)}>
              <Icon name="file-plus" size={12} /> {t('side.newFile')}
            </button>
            <button className="menu-item" onClick={() => void doAction('new-folder', ctxMenu.entry)}>
              <Icon name="folder" size={12} /> {t('side.newFolder')}
            </button>
            {ctxMenu.entry && (
              <>
                <div className="divider" />
                <button className="menu-item" onClick={() => void doAction('rename', ctxMenu.entry)}>
                  <Icon name="edit" size={12} /> {t('common.rename')}
                </button>
                {!ctxMenu.entry.isDir && (
                  <button className="menu-item" onClick={() => void describeFileNow(ctxMenu.entry!.path)}>
                    <Icon name="zap" size={12} /> {t('side.describeFile')}
                  </button>
                )}
                {ctxMenu.entry.isDir && (
                  <button className="menu-item" onClick={() => void describeDir(ctxMenu.entry!.path)}>
                    <Icon name="zap" size={12} /> {t('side.describeFolder')}
                  </button>
                )}
                <button className="menu-item" onClick={() => void doAction('copy-path', ctxMenu.entry)}>
                  <Icon name="copy" size={12} /> {t('side.copyPath')}
                </button>
                <button className="menu-item" onClick={() => void doAction('reveal', ctxMenu.entry)}>
                  <Icon name="external" size={12} /> {t('side.revealInFolder')}
                </button>
                <div className="divider" />
                <button className="menu-item danger" onClick={() => void doAction('delete', ctxMenu.entry)}>
                  <Icon name="trash" size={12} /> {t('common.delete')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const EXT_COLOR: Record<string, string> = {
  ts: '#6aa9ef',
  tsx: '#6aa9ef',
  js: '#e9c46a',
  jsx: '#e9c46a',
  json: '#a5c261',
  md: '#b6b6b6',
  css: '#d98fd8',
  scss: '#d98fd8',
  html: '#e78a80',
  py: '#6dcf8a',
  rs: '#e09a6e',
  go: '#7fd6c9',
  java: '#e78a80',
  c: '#8fc9e0',
  cpp: '#8fc9e0',
  sh: '#9dbf6a',
  yml: '#d98fd8',
  yaml: '#d98fd8',
  svg: '#e9b949',
  png: '#e9b949',
  jpg: '#e9b949',
  lock: '#6f6a5d'
}

function FileIcon({ name }: { name: string }): React.ReactElement {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const color = EXT_COLOR[ext] || 'var(--fg-3)'
  return (
    <span className="file-icon" style={{ color }}>
      <Icon name="file" size={12} strokeWidth={1.4} />
    </span>
  )
}

function FolderIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <span className="file-icon" style={{ color: open ? 'var(--accent)' : 'var(--fg-3)' }}>
      <Icon name="folder" size={12} strokeWidth={1.4} />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function SearchPanel(): React.ReactElement {
  const t = useT()
  const workspace = useStore((s) => s.workspace)
  const openFile = useStore((s) => s.openFile)
  const [query, setQuery] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCase] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!workspace || !query.trim()) {
      setHits([])
      return
    }
    setBusy(true)
    const t = setTimeout(async () => {
      try {
        const res = (await window.comb.fs.search(workspace, query, { regex, caseSensitive, max: 400 })) as SearchHit[]
        setHits(res)
      } finally {
        setBusy(false)
      }
    }, 220)
    return () => clearTimeout(t)
  }, [query, regex, caseSensitive, workspace])

  const grouped = useMemo(() => {
    const map = new Map<string, SearchHit[]>()
    for (const h of hits) {
      const arr = map.get(h.rel) || []
      arr.push(h)
      map.set(h.rel, arr)
    }
    return [...map.entries()]
  }, [hits])

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="sb-section-head">
        <span className="cap">{t('side.searchTitle')}</span>
        <span className="spacer" />
        {busy && <span className="spinner" />}
        <span className="t-xs faint">{hits.length ? `${hits.length} hits` : ''}</span>
      </div>
      <div className="search-box">
        <div className="search-input-wrap">
          <input
            ref={inputRef}
            className="search-input"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('side.searchPlaceholder')}
          />
          <button className="search-toggle" data-active={caseSensitive} onClick={() => setCase((v) => !v)} data-tip={t('side.matchCase')}>
            Aa
          </button>
          <button className="search-toggle" data-active={regex} onClick={() => setRegex((v) => !v)} data-tip={t('side.regex')}>
            .*
          </button>
        </div>
      </div>
      <div className="search-results">
        {grouped.map(([rel, fileHits]) => (
          <div key={rel} className="search-file">
            <div className="search-file-head" onClick={() => void openFile(fileHits[0].path, rel)}>
              <FileIcon name={rel} />
              <span className="ellipsis" title={rel}>{rel}</span>
              <span className="pill" style={{ marginLeft: 'auto' }}>{fileHits.length}</span>
            </div>
            {fileHits.slice(0, 12).map((h) => (
              <div key={`${h.line}:${h.column}`} className="search-hit" onClick={() => void openFile(h.path, rel)}>
                <span className="search-line">{h.line}</span>
                <span className="search-text ellipsis">{h.text.trim()}</span>
              </div>
            ))}
          </div>
        ))}
        {query && !busy && !hits.length && <div className="t-xs ghost" style={{ padding: 12 }}>{t('side.noResults')}</div>}
        {!workspace && <div className="t-xs ghost" style={{ padding: 12 }}>Open a folder first</div>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */

function GitPanel(): React.ReactElement {
  const t = useT()
  const git = useStore((s) => s.git)
  const workspace = useStore((s) => s.workspace)
  const refresh = useStore((s) => s.refreshGit)
  const openFile = useStore((s) => s.openFile)
  const toast = useStore((s) => s.toast)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  if (!workspace) return <div className="t-xs ghost" style={{ padding: 12 }}>{t('side.openFolderFirst')}</div>
  if (!git?.isRepo) {
    return (
      <div className="col gap-4" style={{ padding: 14, alignItems: 'flex-start' }}>
        <div className="t-sm dim">{t('side.notGitRepo')}</div>
        <button
          className="btn sm"
          onClick={async () => {
            const res = await window.comb.git.init(workspace)
            toast(res.ok ? 'ok' : 'err', res.ok ? t('side.repoInitialised') : t('side.gitInitFailed'))
            await refresh()
          }}
        >
          <Icon name="git" size={12} /> {t('side.gitInit')}
        </button>
      </div>
    )
  }

  const staged = git.files.filter((f) => f.index !== ' ' && f.index !== '?')
  const unstaged = git.files.filter((f) => f.index === ' ' || f.index === '?')

  const fileRow = (f: GitFile, isStaged: boolean): React.ReactElement => (
    <div key={`${isStaged}-${f.path}`} className="git-row" onClick={() => void openFile(`${workspace}/${f.path}`, f.path)}>
      <span className={`git-flag ${f.index === '?' ? 'new' : isStaged ? 'staged' : 'mod'}`}>
        {f.index === '?' ? 'U' : f.worktree !== ' ' ? f.worktree : f.index}
      </span>
      <span className="ellipsis" title={f.path}>
        {f.path.split('/').pop()}
        <span className="ghost t-xs"> {f.path.includes('/') ? `· ${f.path.split('/').slice(0, -1).join('/')}` : ''}</span>
      </span>
      <button
        className="icon-btn"
        style={{ width: 18, height: 18 }}
        data-tip={isStaged ? t('side.unstage') : t('side.stage')}
        onClick={async (e) => {
          e.stopPropagation()
          if (isStaged) await window.comb.git.unstage(workspace, [f.path])
          else await window.comb.git.stage(workspace, [f.path])
          await refresh()
        }}
      >
        <Icon name={isStaged ? 'minus' : 'plus'} size={11} />
      </button>
    </div>
  )

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="sb-section-head">
        <Icon name="git" size={12} className="faint" />
        <span className="ellipsis mono t-xs">{git.branch || 'HEAD'}</span>
        {git.ahead > 0 && <span className="pill" data-tip="ahead">↑{git.ahead}</span>}
        {git.behind > 0 && <span className="pill" data-tip="behind">↓{git.behind}</span>}
        <span className="spacer" />
        <button className="icon-btn" style={{ width: 20, height: 20 }} data-tip={t('common.refresh')} onClick={() => void refresh()}>
          <Icon name="refresh" size={11} />
        </button>
      </div>
      <div className="git-scroll">
        <div className="commit-box">
          <textarea
            className="textarea commit-input"
            rows={2}
            placeholder={t('side.commitPlaceholder')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="btn primary sm"
            disabled={!message.trim() || !git.files.length || busy}
            onClick={async () => {
              setBusy(true)
              try {
                const res = await window.comb.git.commit(workspace, message)
                toast(res.ok ? 'ok' : 'err', res.ok ? t('side.committed') : t('side.commitFailed'), res.out.split('\n')[0])
                if (res.ok) setMessage('')
                await refresh()
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <span className="spinner" /> : <Icon name="check" size={11} />} {t('side.commit', { n: git.files.length })}
          </button>
        </div>
        {!!staged.length && (
          <>
            <div className="git-group">{t('side.staged')} · {staged.length}</div>
            {staged.map((f) => fileRow(f, true))}
          </>
        )}
        {!!unstaged.length && (
          <>
            <div className="git-group">{t('side.changes')} · {unstaged.length}</div>
            {unstaged.map((f) => fileRow(f, false))}
          </>
        )}
        {!git.files.length && <div className="t-xs ghost" style={{ padding: '8px 12px' }}>{t('side.workingTreeClean')}</div>}
        {!!git.log.length && (
          <>
            <div className="git-group" style={{ marginTop: 8 }}>{t('side.recentCommits')}</div>
            {git.log.map((l) => (
              <div key={l.hash} className="commit-row" title={l.subject}>
                <span className="mono t-xs acc">{l.hash}</span>
                <span className="ellipsis t-xs">{l.subject}</span>
                <span className="t-xs ghost">{l.date}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Threads                                                             */
/* ------------------------------------------------------------------ */

function ThreadsPanel(): React.ReactElement {
  const t = useT()
  const threads = useStore((s) => s.threads)
  const activeId = useStore((s) => s.activeThreadId)
  const select = useStore((s) => s.selectThread)
  const remove = useStore((s) => s.deleteThread)
  const newThread = useStore((s) => s.newThread)
  const [q, setQ] = useState('')
  const filtered = q ? threads.filter((t) => t.title.toLowerCase().includes(q.toLowerCase())) : threads

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="sb-section-head">
        <span className="cap">{t('side.sessions')}</span>
        <span className="spacer" />
        <button className="icon-btn" style={{ width: 20, height: 20 }} data-tip={t('side.newSession')} onClick={() => newThread()}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      <div className="tree-filter">
        <Icon name="search" size={11} className="faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('side.searchSessions')} />
      </div>
      <div className="tree-scroll">
        {filtered.map((thread) => (
          <div key={thread.id} className="thread-row" data-active={thread.id === activeId} onClick={() => select(thread.id)}>
            <Icon name="chat" size={12} className={thread.id === activeId ? 'acc' : 'faint'} />
            <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
              <span className="ellipsis t-sm">{thread.title}</span>
              <span className="t-xs ghost">
                {t('side.msgs', { n: thread.messages.filter((m) => m.role === 'user').length })} · {timeAgo(thread.updatedAt)}
              </span>
            </div>
            <button
              className="icon-btn"
              style={{ width: 18, height: 18 }}
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(t('side.deleteSession'))) void remove(thread.id)
              }}
            >
              <Icon name="trash" size={11} />
            </button>
          </div>
        ))}
        {!filtered.length && <div className="t-xs ghost" style={{ padding: 12 }}>{t('side.noSessions')}</div>}
      </div>
    </div>
  )
}
