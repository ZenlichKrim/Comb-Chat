import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { VoteCard, GuardNote, Suggestions } from './AgentNotes'
import { NotePin, NotesPanel } from './Notes'
import { useStore, useActiveThread, formatCost, formatTokens, timeAgo } from '../store'
import { useT } from '../lib/i18n'
import type { Attachment, ChatMessage, ApprovalPolicy } from '../../../shared/types'
import { MODELS } from '../../../shared/types'

/** One permission switch: a label and three words, the chosen one lit. */
function PermRow({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}): React.ReactElement {
  return (
    <div className="perm-row">
      <span className="perm-label">{label}</span>
      <span className="perm-seg">
        {options.map((o) => (
          <button key={o.value} className="perm-opt" data-on={value === o.value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </span>
    </div>
  )
}

export function ChatPane(): React.ReactElement {
  const t = useT()
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  const onDragEnter = (e: React.DragEvent): void => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const st = useStore.getState()
    let attached = 0
    for (const file of Array.from(e.dataTransfer.files).slice(0, 12)) {
      // Electron 32+ dropped File.path: ask the preload for the real path, and if
      // it cannot give one, still attach the bytes by name instead of skipping.
      const full = window.comb.dropPath(file) || (file as File & { path?: string }).path || ''
      if (!full) {
        st.toast('err', t('chat.dropNoPath'), file.name)
        continue
      }
      const rel = workspace && full.startsWith(workspace) ? full.slice(workspace.length + 1).replace(/\\/g, '/') : full.split(/[\\/]/).pop() || full
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(full)
      const isVector = /\.svg$/i.test(full)
      let content = ''
      try {
        if (isImage) {
          // vision models need the bytes, not a path — send a data: URL
          const img = await window.comb.fs.readImage(full)
          if (!img?.ok || !img.dataUrl) {
            st.toast('err', img?.error || t('chat.couldNotRead', { rel }))
            continue
          }
          content = img.dataUrl
        } else {
          content = (await window.comb.fs.read(full)).content
        }
      } catch {
        st.toast('err', t('chat.couldNotRead', { rel }))
        continue
      }
      if (!isImage && content.length > 200_000) content = content.slice(0, 200_000) + '\n… [truncated]'
      st.addContextFile({
        id: `drop_${Date.now()}_${attached}`,
        kind: isImage ? 'image' : 'file',
        vector: isVector,
        path: full,
        rel,
        name: rel.split('/').pop() || rel,
        content
      })
      attached += 1
    }
    if (attached) st.toast('ok', t('chat.attached', { n: attached }))
  }

  const thread = useActiveThread()
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const running = useStore((s) => s.running)
  const stopRun = useStore((s) => s.stopRun)
  const sendMessage = useStore((s) => s.sendMessage)
  const pendingApproval = useStore((s) => s.pendingApproval)
  const approve = useStore((s) => s.approve)
  const setDiffPreview = useStore((s) => s.setDiffPreview)
  const contextFiles = useStore((s) => s.contextFiles)
  const removeContextFile = useStore((s) => s.removeContextFile)
  const workspace = useStore((s) => s.workspace)
  const openWorkspace = useStore((s) => s.openWorkspace)
  const newThread = useStore((s) => s.newThread)
  const undoLastRun = useStore((s) => s.undoLastRun)
  const checkpoints = useStore((s) => s.checkpoints)
  const setBottomPanel = useStore((s) => s.setBottomPanel)
  const bottomPanel = useStore((s) => s.bottomPanel)

  const activity = useStore((s) => s.activity)
  const activeRole = useStore((s) => s.activeRole)
  const lastPrompt = useStore((s) => s.lastPrompt)
  const changedFiles = useStore((s) => s.changedFiles)
  const [elapsed, setElapsed] = useState(0)
  const [approvalAge, setApprovalAge] = useState(0)
  const [input, setInput] = useState('')
  const [menu, setMenu] = useState(false)
  const [launcher, setLauncher] = useState(false)
  const queued = useStore((s) => s.queued)
  const dropQueued = useStore((s) => s.dropQueued)
  const [historyIdx, setHistoryIdx] = useState(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pinnedBottom = useRef(true)
  const messages = thread?.messages || []
  const model = MODELS.find((m) => m.id === settings.model) || MODELS[0]
  const caps = settings.capabilities || { edit: 'ask', run: 'ask', planner: 'auto' }

  // seconds spent on the current step, so a long read does not look frozen
  useEffect(() => {
    if (!activity) {
      setElapsed(0)
      return
    }
    const id = setInterval(() => setElapsed(Math.max(0, Math.round((Date.now() - activity.since) / 1000))), 500)
    return () => clearInterval(id)
  }, [activity])

  // tick the countdown while an approval waits
  useEffect(() => {
    if (!pendingApproval) {
      setApprovalAge(0)
      return
    }
    const started = Date.now()
    const id = setInterval(() => setApprovalAge(Date.now() - started), 1000)
    return () => clearInterval(id)
  }, [pendingApproval])

  // approve with Enter when a approval is pending
  useEffect(() => {
    if (!pendingApproval) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
        e.preventDefault()
        void approve('allow')
      }
      if (e.key === 'Escape') void approve('deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingApproval, approve])

  // autoscroll while streaming, but respect the user scrolling up
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (pinnedBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, pendingApproval])

  const steer = useStore((s) => s.steer)
  const setNotesOpen = useStore((s) => s.setNotesOpen)
  const notesCount = useStore((s) => s.notes.filter((n) => n.status !== 'done').length)
  const retryInfo = useStore((s) => s.retryInfo)

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  }

  const submit = async (opts?: { fromHistory?: boolean; queueInstead?: boolean }): Promise<void> => {
    // Recalled from history with ↑ and sent: it has been sent before, so it is
    // in the transcript already — do not leave a copy in the box.
    const text = input.trim()
    if (!text) return
    // The composer is not an archive: the message lives in the transcript from
    // now on, so the box empties the moment it is sent — before the run even
    // starts, and whether or not the agent is already busy.
    setInput('')
    setHistoryIdx(-1)
    pinnedBottom.current = true
    const queueInstead = opts?.queueInstead === true
    if (running) {
      // talking to a running agent: the note is injected into the live run, so a
      // correction lands in the middle of the work instead of queueing behind it.
      // `+` in the menu (or Shift on the chip) puts it in the queue instead.
      if (queueInstead) {
        useStore.getState().queueMessage(text)
        return
      }
      if ((await steer(text)) === false) {
        useStore.getState().queueMessage(text)
      }
      return
    }
    try {
      const sent = await sendMessage(text, contextFiles)
      // `false` means the store refused it (a run is already going): the text is
      // not anywhere else, so it goes back into the box.
      if (sent === false && !opts?.fromHistory) setInput(text)
      inputRef.current?.focus()
    } catch (e) {
      // nothing was sent: give the words back instead of eating them
      setInput(text)
      useStore.getState().toast('err', t('chat.sendFailed'))
    }
  }

  // Ctrl+V a screenshot straight from the clipboard — the fastest way to ask
  // "why does this look broken?"
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = Array.from(e.clipboardData?.items || [])
    const imageItem = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'))
    if (!imageItem) return
    const file = imageItem.getAsFile()
    if (!file) return
    e.preventDefault()
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      if (!dataUrl) return
      const st = useStore.getState()
      st.addContextFile({
        id: `paste_${Date.now()}`,
        kind: 'image',
        name: `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`,
        content: dataUrl
      })
      st.toast('ok', t('chat.pasteImage'))
    }
    reader.readAsDataURL(file)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Escape' && running) {
      // panic stop: Esc in the composer aborts the run instead of doing nothing
      e.preventDefault()
      void stopRun()
      return
    }
    if (e.key === 'Enter') {
      const willSend = settings.sendOnEnter ? !e.shiftKey && !mod : mod
      // Shift+Enter while the agent is busy: do not interrupt the run, queue the
      // message for the moment it finishes.
      if (!willSend && running && (e.shiftKey || mod)) {
        e.preventDefault()
        void submit({ fromHistory: historyIdx >= 0, queueInstead: true })
        return
      }
      if (willSend) {
        e.preventDefault()
        void submit({ fromHistory: historyIdx >= 0, queueInstead: mod && running })
      }
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      useStore.getState().setPalette({ open: true, mode: 'commands' })
    }
    if (e.key === 'ArrowUp' && !input && messages.length) {
      e.preventDefault()
      const userMsgs = messages.filter((m) => m.role === 'user').map((m) => m.content)
      const idx = historyIdx < 0 ? userMsgs.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(idx)
      setInput(userMsgs[idx] || '')
    }
    if (e.key === 'ArrowDown' && historyIdx >= 0) {
      e.preventDefault()
      const userMsgs = messages.filter((m) => m.role === 'user').map((m) => m.content)
      const idx = historyIdx + 1
      if (idx >= userMsgs.length) {
        setHistoryIdx(-1)
        setInput('')
      } else {
        setHistoryIdx(idx)
        setInput(userMsgs[idx])
      }
    }
  }

  // auto-grow textarea
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [input])

  const usage = thread?.usage
  const contextPct = useMemo(() => {
    if (!usage) return 0
    return Math.min(100, Math.round((usage.promptTokens / model.contextWindow) * 100))
  }, [usage, model.contextWindow])

  if (!thread) {
    return (
      <div className="chat-pane empty">
        <div className="empty-grid">
          <Icon name="bee" size={36} className="ghost" />
          <h2 className="t-lg" style={{ fontWeight: 700 }}>{t('chat.noSession')}</h2>
          <button className="btn primary" onClick={() => newThread()}>
            <Icon name="plus" size={12} /> {t('chat.startSession')}
          </button>
        </div>
      </div>
    )
  }

  const isEmpty = messages.length === 0
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const changed = useStore.getState().changedFiles

  return (
    <div
      className="chat-pane"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      {dragging && (
        <div className="drop-veil">
          <div className="drop-card">
            <Icon name="file-plus" size={16} className="acc" />
            <span className="t-sm">{t('chat.dropFiles')}</span>
          </div>
        </div>
      )}
      <div className="chat-head">
        <div className="col" style={{ minWidth: 0, gap: 1 }}>
          <span className="t-sm ellipsis" style={{ fontWeight: 600, color: 'var(--fg-0)' }}>
            {thread.title}
          </span>
          <span className="t-xs ghost">
            {timeAgo(thread.createdAt)} · {t('chat.turns', { n: messages.filter((m) => m.role === 'user').length })}
            {usage && usage.completionTokens > 0 ? ` · ${formatTokens(usage.promptTokens + usage.completionTokens)} tok · ${formatCost(usage.cost)}` : ''}
          </span>
        </div>
        <span className="spacer" />
        {checkpoints.length > 0 && (
          <button className="btn ghost sm" data-tip={t('chat.undoRun')} onClick={() => void undoLastRun()}>
            <Icon name="undo" size={11} /> {t('chat.undoRunShort')}
          </button>
        )}
        <button className="btn ghost sm" onClick={() => newThread()} data-tip={t('chat.newTip')}>
          <Icon name="plus" size={11} /> {t('chat.new')}
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {isEmpty ? (
          <div className="chat-empty">
            <Onboarding workspace={workspace} onOpen={() => void openWorkspace()} />
          </div>
        ) : (
          <div className="messages">
            {messages.map((m, i) => (
              <MessageRow key={m.id} msg={m} isLast={i === messages.length - 1} index={i} />
            ))}
            {retryInfo && (
              <div className="retry-row">
                <Icon name="refresh" size={11} className="warn spin-slow" />
                <span className="t-xs">{t('chat.retrying')}</span>
                <span className="t-xs faint">{t('chat.retryAttempt', { n: retryInfo.attempt, max: retryInfo.max })}</span>
                <span className="spacer" />
                <span className="t-xs faint">{t('chat.retryHint')}</span>
              </div>
            )}
            {running && (
              <div className="thinking-row">
                <span className="spinner" />
                {activeRole && (
                  <span className="role-chip" data-role={activeRole}>
                    {activeRole === 'author' ? t('chat.roleAuthor') : t('chat.roleBuilder')}
                  </span>
                )}
                <span className="faint t-xs ellipsis" style={{ minWidth: 0 }}>
                  {activity ? `${t('chat.stepLabel', { n: activity.step })} · ${activity.label}` : t('chat.working')}
                </span>
                {lastPrompt && (
                  <span className="faint t-xs ellipsis thinking-goal" title={lastPrompt}>
                    ← {lastPrompt}
                  </span>
                )}
                {changedFiles.length > 0 && (
                  <span className="pill acc t-xs">{t('chat.filesTouched', { n: changedFiles.length })}</span>
                )}
                {activity && (
                  <span className="faint t-xs tabular" title={t('chat.runClockHint')}>
                    {activity.thoughtMs ? t('chat.thoughtShort', { n: Math.round(activity.thoughtMs / 1000) }) + ' · ' : ''}
                    {elapsed}s
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {pendingApproval && (
        <div className="approval-bar" data-sticky>
          <Icon name="shield" size={13} className="warn" />
          <span className="approval-label">
            <span className="t-sm" style={{ fontWeight: 600 }}>{pendingApproval.name}</span>
            <span className="t-xs dim ellipsis">
              {pendingApproval.args?.command
                ? String(pendingApproval.args.command).slice(0, 90)
                : pendingApproval.args?.path || t('common.noArguments')}
            </span>
          </span>
          <span className="spacer" />
          {!!pendingApproval.diff?.length && (
            <button
              className="btn ghost sm"
              data-tip={t('chat.reviewTip')}
              onClick={() =>
                setDiffPreview({
                  path: pendingApproval.diff![0].path,
                  rel: pendingApproval.diff![0].rel,
                  before: pendingApproval.diff![0].before ?? '',
                  after: pendingApproval.diff![0].after ?? '',
                  kind: pendingApproval.diff![0].kind
                })
              }
            >
              <Icon name="diff" size={11} /> {t('chat.review')}
            </button>
          )}
          <button className="btn primary sm" onClick={() => void approve('allow')}>
            <Icon name="check" size={11} /> {t('chat.allow')}
          </button>
          <button className="btn sm" onClick={() => void approve('allow-always')}>
            {t('chat.always')}
          </button>
          <button className="btn danger sm" onClick={() => void approve('deny')}>
            {t('chat.deny')}
          </button>
          {/* A countdown makes it obvious the bar is not going away on its own,
              which is what made the old one feel like it "blinked". */}
          <span className="approval-timer" title={t('chat.approvalStays')}>
            {Math.max(0, Math.round((15 * 60 * 1000 - approvalAge) / 1000))}s
          </span>
        </div>
      )}
      {!!contextFiles.length && (
        <div className="composer-notes">
          {contextFiles.map((c) => (
            <span key={`n_${c.id}`} className="ctx-note">
              <Icon name="sticky" size={9} className="acc" />
              <span className="ctx-note-file ellipsis">{c.name}</span>
              <NotePin target={c.rel || c.name} label={c.name} />
            </span>
          ))}
          <span className="t-xs ghost" style={{ alignSelf: 'center' }}>
            {t('note.pinnedRow')}
          </span>
        </div>
      )}

      {launcher && (
        <div className="launcher-anchor" onClick={() => setLauncher(false)}>
          <div className="launcher-card" onClick={(e) => e.stopPropagation()}>
            <div className="launcher-head">
              <Icon name="sparkles" size={10} className="acc" />
              {t('launcher.title')}
              <span className="spacer" />
              <button className="icon-btn" onClick={() => setLauncher(false)} data-tip={t('common.close')}>
                <Icon name="close" size={11} />
              </button>
            </div>
            <div className="launcher-grid">
              <button
                className="launcher-tile"
                onClick={async () => {
                  setLauncher(false)
                  const st = useStore.getState()
                  const picked = await window.comb.fs.pickFiles()
                  for (const full of (picked || []).slice(0, 12)) {
                    const rel = workspace && full.startsWith(workspace) ? full.slice(workspace.length + 1).replace(/\\/g, '/') : full.split(/[\\/]/).pop() || full
                    try {
                      const fc = await window.comb.fs.read(full)
                      st.addContextFile({ id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, kind: 'file', name: rel, rel, path: full, content: fc.content })
                    } catch {
                      st.toast('err', t('chat.couldNotRead', { rel }))
                    }
                  }
                }}
              >
                <span className="launcher-glyph">
                  <Icon name="file" size={16} />
                </span>
                <span className="launcher-label">{t('launcher.files')}</span>
                <span className="launcher-sub">{t('launcher.filesSub')}</span>
              </button>
              <button
                className="launcher-tile"
                onClick={() => {
                  setLauncher(false)
                  setBottomPanel(bottomPanel === 'terminal' ? 'none' : 'terminal')
                }}
                data-on={bottomPanel === 'terminal'}
              >
                <span className="launcher-glyph">
                  <Icon name="terminal" size={16} />
                </span>
                <span className="launcher-label">{t('chat.terminal')}</span>
                <span className="launcher-sub">{t('launcher.terminalSub')}</span>
              </button>
              <button
                className="launcher-tile"
                onClick={() => {
                  setLauncher(false)
                  setNotesOpen(true)
                }}
                data-on={notesCount > 0}
              >
                <span className="launcher-glyph">
                  <Icon name="sticky" size={16} />
                </span>
                <span className="launcher-label">
                  {t('note.chip')} {notesCount > 0 ? `· ${notesCount}` : ''}
                </span>
                <span className="launcher-sub">{t('launcher.notesSub')}</span>
              </button>
              <button
                className="launcher-tile"
                onClick={() => {
                  setLauncher(false)
                  useStore.setState({ sidebarOpen: !useStore.getState().sidebarOpen })
                }}
              >
                <span className="launcher-glyph">
                  <Icon name="folder" size={16} />
                </span>
                <span className="launcher-label">{t('launcher.project')}</span>
                <span className="launcher-sub">{t('launcher.projectSub')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <NotesPanel />

      <div className="composer-wrap">
        {queued.length > 0 && (
          <div className="composer-queue">
            {queued.map((q, i) => (
              <div className="queued" key={`${i}-${q.slice(0, 12)}`}>
                <Icon name="clock" size={10} className="faint" />
                <span className="queued-text" title={q}>
                  {q}
                </span>
                <span className="t-xs ghost">{t('chat.queuedHint')}</span>
                <button className="queued-x" onClick={() => dropQueued(i)} data-tip={t('common.delete')}>
                  <Icon name="close" size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer" data-running={running}>
          {contextFiles.length > 0 && (
            <div className="composer-context">
              {contextFiles.map((c) => (
                <span
                  key={c.id}
                  className="ctx-chip attach-chip"
                  data-image={c.kind === 'image' ? 'true' : undefined}
                  title={`${c.rel || c.name}${c.content ? ` · ${Math.max(1, Math.round(c.content.length / 1024))} KB` : ''}`}
                >
                  {c.kind === 'image' && c.content ? (
                    // the picture itself, so an attachment is not a filename you
                    // have to trust
                    <img className="attach-thumb" src={c.content} alt="" />
                  ) : (
                    <Icon name={c.kind === 'selection' ? 'diff' : 'file'} size={10} />
                  )}
                  <span className="attach-name ellipsis">{c.name}</span>
                  {c.path && (
                    <button
                      className="attach-act"
                      title={t('chat.attachOpen')}
                      onClick={(e) => {
                        e.stopPropagation()
                        window.comb.app.showItemInFolder(c.path!)
                      }}
                    >
                      <Icon name="external" size={9} />
                    </button>
                  )}
                  <button className="attach-act" title={t('common.delete')} onClick={() => removeContextFile(c.id)}>
                    <Icon name="close" size={9} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="composer-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={
              workspace
                ? running
                  ? t('chat.placeholderSteer')
                  : t('chat.placeholderReady')
                : t('chat.placeholderNoFolder')
            }
            rows={1}
            spellCheck={false}
          />
          {input.trim().length > 0 && (
            <div className="composer-estimate" title={t('chat.estimateHint')}>
              <span className="mono">~{Math.max(1, Math.round(input.trim().length / 3.6))} {t('chat.tokens')}</span>
              <span className="ghost">·</span>
              <span className="mono acc">{(() => {
                const cost = (Math.max(1, Math.round(input.trim().length / 3.6)) / 1_000_000) * 0.3
                return cost < 0.0001 ? '<$0.0001' : `$${cost.toFixed(4)}`
              })()}</span>
            </div>
          )}
          <div className="composer-bar">
            {/* One "+" instead of five chips shouting at once: the composer should
                read as a text box, not a control panel. */}
            <div className="composer-menu-wrap">
              <button
                className="composer-plus"
                data-on={launcher}
                data-tip={t('chat.attachTip')}
                aria-label={t('chat.attachTip')}
                onClick={() => setLauncher(true)}
              >
                <Icon name="plus" size={12} strokeWidth={2} />
              </button>
              {menu && (
                <>
                  <div className="composer-menu-sheet" onClick={() => setMenu(false)} />
                  <div className="composer-menu" role="menu">
                    <button
                      className="composer-menu-item"
                      onClick={async () => {
                        setMenu(false)
                        const st = useStore.getState()
                        const picked = await window.comb.fs.pickFiles()
                        for (const full of (picked || []).slice(0, 12)) {
                          const rel = workspace && full.startsWith(workspace) ? full.slice(workspace.length + 1).replace(/\\/g, '/') : full.split(/[\\/]/).pop() || full
                          try {
                            const fc = await window.comb.fs.read(full)
                            st.addContextFile({ id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, kind: 'file', name: rel, rel, path: full, content: fc.content })
                          } catch {
                            st.toast('err', t('chat.couldNotRead', { rel }))
                          }
                        }
                      }}
                    >
                      <Icon name="file" size={12} /> {t('chat.menuFile')}
                      <span className="kbd">Ctrl V</span>
                    </button>
                    <button
                      className="composer-menu-item"
                      onClick={async () => {
                        setMenu(false)
                        const st = useStore.getState()
                        try {
                          const img = await navigator.clipboard.readText()
                          if (!img) return
                          st.addContextFile({ id: `t_${Date.now()}`, kind: 'selection', name: t('chat.menuTextPaste'), content: img })
                        } catch {
                          st.toast('warn', t('chat.cloudUnreachable'))
                        }
                      }}
                    >
                      <Icon name="copy" size={12} /> {t('chat.menuPasteText')}
                    </button>
                    <div className="composer-menu-sep" />
                    <button
                      className="composer-menu-item"
                      data-on={settings.autoContext}
                      onClick={() => {
                        setMenu(false)
                        void setSettings({ autoContext: !settings.autoContext })
                      }}
                    >
                      <Icon name="layers" size={12} className={settings.autoContext ? 'acc' : 'faint'} />
                      {t('chat.menuContext')}
                      <span className="composer-menu-state">{settings.autoContext ? t('common.on') : t('common.off')}</span>
                    </button>
                    <button
                      className="composer-menu-item"
                      data-on={notesCount > 0}
                      onClick={() => {
                        setMenu(false)
                        setNotesOpen(true)
                      }}
                    >
                      <Icon name="sticky" size={12} className={notesCount > 0 ? 'acc' : 'faint'} />
                      {t('note.chip')}
                      {notesCount > 0 && <span className="composer-menu-state acc">{notesCount}</span>}
                    </button>
                    <button
                      className="composer-menu-item"
                      onClick={() => {
                        setMenu(false)
                        setBottomPanel(bottomPanel === 'terminal' ? 'none' : 'terminal')
                      }}
                    >
                      <Icon name="terminal" size={12} /> {t('chat.terminal')}
                    </button>
                    <div className="composer-menu-sep" />
                    {/* Three switches in words, not three cryptic modes. Each one
                        states its consequence right there: what may be written,
                        what may be run, and whether someone thinks first. */}
                    <div className="composer-menu-label">{t('chat.permTitle')}</div>
                    <PermRow
                      label={t('chat.permEdit')}
                      value={caps.edit}
                      options={[
                        { value: 'ask', label: t('chat.permAsk') },
                        { value: 'auto', label: t('chat.permAuto') },
                        { value: 'off', label: t('chat.permOff') }
                      ]}
                      onChange={(v) => void setSettings({ capabilities: { ...caps, edit: v as 'ask' | 'auto' | 'off' } })}
                    />
                    <PermRow
                      label={t('chat.permRun')}
                      value={caps.run}
                      options={[
                        { value: 'ask', label: t('chat.permAsk') },
                        { value: 'auto', label: t('chat.permAuto') },
                        { value: 'off', label: t('chat.permOff') }
                      ]}
                      onChange={(v) => void setSettings({ capabilities: { ...caps, run: v as 'ask' | 'auto' | 'off' } })}
                    />
                    <PermRow
                      label={t('chat.permPlanner')}
                      value={caps.planner}
                      options={[
                        { value: 'auto', label: t('chat.permPlannerAuto') },
                        { value: 'always', label: t('chat.permPlannerAlways') },
                        { value: 'off', label: t('chat.permPlannerOff') }
                      ]}
                      onChange={(v) => void setSettings({ capabilities: { ...caps, planner: v as 'auto' | 'always' | 'off' } })}
                    />
                    <div className="composer-menu-sep" />
                    <button
                      className="composer-menu-item"
                      data-on={settings.stableMode}
                      onClick={() => {
                        setMenu(false)
                        void setSettings({ stableMode: !settings.stableMode })
                      }}
                    >
                      <Icon name="shield" size={12} className={settings.stableMode ? 'ok' : 'faint'} />
                      {t('chat.stableTip')}
                      <span className="composer-menu-state">{settings.stableMode ? t('common.on') : t('common.off')}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
            {/* what is switched on stays visible, quietly: two tiny dots, not a row of pills */}
            <span className="composer-state" data-tip={t('chat.stateTip')}>
              {settings.stableMode && <Icon name="shield" size={10} className="ok" />}
              {settings.approvalPolicy !== 'ask' && (
                <Icon name={settings.approvalPolicy === 'yolo' ? 'zap' : 'edit'} size={10} className={settings.approvalPolicy === 'yolo' ? 'err' : 'warn'} />
              )}
              {notesCount > 0 && <span className="composer-state-badge">{notesCount}</span>}
            </span>
            <span className="spacer" />
            {usage && usage.promptTokens > 0 && (
              <span className="ctx-meter" data-tip={`${formatTokens(usage.promptTokens)} / ${formatTokens(model.contextWindow)} context`}>
                <span className="ctx-meter-bar">
                  <span style={{ width: `${contextPct}%` }} data-full={contextPct > 80} />
                </span>
                <span className="t-xs faint">{contextPct}%</span>
              </span>
            )}
            {changed.length > 0 && !running && (
              <span className="pill ok" data-tip={changed.join('\n')}>
                {changed.length === 1 ? t('chat.filesChanged', { n: 1 }) : t('chat.filesChangedPlural', { n: changed.length })}
              </span>
            )}
            {running ? (
              <>
                <button
                  className="send-btn"
                  onClick={() => void submit()}
                  disabled={!input.trim()}
                  data-tip={t('chat.steerTip')}
                >
                  <Icon name="arrow-up" size={13} strokeWidth={2} />
                </button>
                <button className="send-btn stop" onClick={() => void stopRun()} data-tip={t('chat.stopTip')}>
                  <Icon name="stop" size={11} />
                </button>
              </>
            ) : (
              <button className="send-btn" onClick={() => void submit()} disabled={!input.trim()} data-tip={t('chat.sendTip')}>
                <Icon name="arrow-up" size={13} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
        <div className="composer-foot">
          <span className="t-xs ghost">
            {model.label} · {t(model.blurbKey)}
          </span>
          <span className="spacer" />
          <span className="t-xs ghost">
            {settings.sendOnEnter ? (
              <>
                <kbd>Enter</kbd> {t('chat.sendHintEnter')} · <kbd>Shift</kbd>+<kbd>Enter</kbd> {t('chat.newlineHint')}
              </>
            ) : (
              <>
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> {t('chat.sendHintCtrl')}
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * The agent's own commentary, one line per action, folded into a nested timeline
 * instead of scattered paragraphs. Each row is "what I am doing" with the tool
 * that did it underneath — the shape of the work, not a wall of text.
 */
/** Reads are one line each: a row of file pills, not a card per file. */
function ReadCard({ call }: { call: NonNullable<ChatMessage['tools']>[number] }): React.ReactElement {
  const name = String(call.args?.path || call.args?.rel || '')
  const short = name.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
  const ext = short.includes('.') ? short.slice(short.lastIndexOf('.')) : ''
  return (
    <span className="read-card" data-tip={name}>
      <Icon name="file" size={10} className="faint" />
      <span className="read-card-name">{short.replace(ext, '')}</span>
      <span className="read-card-ext">{ext}</span>
      {call.status === 'error' && <Icon name="alert" size={10} className="err" />}
    </span>
  )
}

const QUIET_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir'])

/**
 * The work, as a readable list.
 *
 * Each row is one step: the agent's own line about what it is doing, and the
 * tool it used, one under the other. Silent rows are folded into a single
 * "посмотрел: a, b, c" line instead of a card each — the point of this panel is
 * to be understood at a glance, not to log every call.
 */
function StepNotes({ tools, live }: { tools: ChatMessage['tools']; live: boolean }): React.ReactElement | null {
  const t = useT()
  const [open, setOpen] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const { rows, quietGroups, count } = useMemo(() => {
    type Tool = NonNullable<ChatMessage['tools']>[number]
    const steps: { key: string; text: string; tool?: Tool }[] = []
    const quiet: Tool[] = []
    for (const tool of tools || []) {
      // ask_user renders as a vote card, finish as the answer itself
      if (tool.name === 'ask_user' || tool.name === 'finish') continue
      const line = typeof tool.args?.note === 'string' ? tool.args.note.trim() : ''
      if (line) steps.push({ key: tool.id, text: line, tool })
      else if (QUIET_TOOLS.has(tool.name)) quiet.push(tool)
      else steps.push({ key: tool.id, text: '', tool })
    }
    return {
      rows: steps,
      quietGroups: quiet.length ? [quiet] : [],
      count: steps.length + (quiet.length ? 1 : 0)
    }
  }, [tools])

  if (!count) return null
  const limit = showAll ? rows.length : 6
  const hidden = rows.length - limit

  return (
    <div className="steps">
      <button className="steps-head" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={9} />
        <span>{open ? t('steps.done', { n: count }) : t('steps.show', { n: count })}</span>
        {!open && live && <span className="spinner" style={{ marginLeft: 2 }} />}
      </button>
      {open && (
        <div className="steps-body">
          {rows.slice(0, limit).map((r, i) => (
            <div className="step-row" key={r.key} style={{ animationDelay: `${Math.min(i, 8) * 22}ms` }}>
              <span className="step-dot" data-quiet={r.text ? undefined : 'true'} />
              <div className="step-content">
                {r.text && <div className="step-say chat-text">{r.text}</div>}
                {r.tool &&
                  (QUIET_TOOLS.has(r.tool.name) ? (
                    <ReadCard call={r.tool} />
                  ) : (
                    <ToolCard call={r.tool} compact />
                  ))}
              </div>
            </div>
          ))}
          {quietGroups.map((group) => (
            <div className="step-row" key={`q-${group[0].id}`}>
              <span className="step-dot" data-quiet="true" />
              <div className="step-content">
                <div className="step-quiet-line">
                  <span className="step-quiet-label">{t('steps.looked')}:</span>
                  {group.slice(0, 8).map((c) => (
                    <ReadCard key={c.id} call={c} />
                  ))}
                  {group.length > 8 && <span className="t-xs faint">+{group.length - 8}</span>}
                </div>
              </div>
            </div>
          ))}
          {hidden > 0 && (
            <button className="step-more" onClick={() => setShowAll(true)}>
              {t('steps.more', { n: hidden })}
            </button>
          )}
          {showAll && hidden > 0 && (
            <button className="step-more" onClick={() => setShowAll(false)}>
              {t('steps.less')}
            </button>
          )}
          {live && (
            <div className="step-row step-live">
              <span className="step-dot" data-live="true" />
              <span className="step-caret" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One step of work, the way the user asked for it:
 *
 *   >>  the agent says what it is about to do in this step
 *   |>  action, with an icon that matches what the action is
 *   |>  action
 *
 * The sentence is the model's own words, not a label assembled by us — that is
 * the difference between a log and a train of thought.
 */
const ACTION_ICON: Record<string, IconName> = {
  read_file: 'file',
  list_dir: 'folder',
  glob: 'search',
  grep: 'search',
  write_file: 'save',
  edit_file: 'edit',
  multi_edit: 'edit',
  run_command: 'terminal',
  delete_path: 'trash',
  move_path: 'external',
  todo_write: 'check',
  leave_note: 'sticky',
  notify_user: 'bell',
  attach_file: 'paperclip',
  ask_user: 'chat',
  suggest: 'sparkles',
  finish: 'check'
}

function actionLabel(name: string, args?: Record<string, any>): string {
  const p = String(args?.path || args?.rel || args?.command || args?.pattern || '')
  const short = p.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
  return short || name.replace(/_/g, ' ')
}

function StepTrace({ steps, live }: { steps: NonNullable<ChatMessage['steps']>; live: boolean }): React.ReactElement {
  const t = useT()
  // Closed by default. A run is 10-40 steps; printing every paragraph of them
  // turns the transcript into a wall you have to scroll past to reach the answer.
  const [open, setOpen] = useState(false)
  const [wide, setWide] = useState<Set<string>>(new Set())
  const actions = steps.reduce((n, s) => n + s.actions.length, 0)
  const last = steps[steps.length - 1]
  const visible = open ? steps : last ? [last] : []

  const toggleWide = (id: string): void =>
    setWide((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="trace" data-open={open}>
      <button className="trace-head" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={9} />
        <span>{t('trace.summary', { n: steps.length, m: actions })}</span>
        {live && <span className="spinner" />}
      </button>
      <div className="trace-body" data-compact={open ? undefined : 'true'}>
        {visible.map((s) => (
          <div className="trace-step" key={s.id}>
            {s.say && (
              <div
                className="trace-say"
                data-wide={wide.has(s.id) ? 'true' : undefined}
                onClick={() => open && toggleWide(s.id)}
                title={open ? undefined : t('trace.expand')}
              >
                <span className="trace-caret">&gt;&gt;</span>
                <div className="chat-text">
                  <Markdown text={s.say} />
                </div>
              </div>
            )}
            {!!s.actions.length && (
              <div className="trace-actions">
                {s.actions.map((a) => {
                  const bad = !a.ok
                  return (
                    <span key={a.id} className="trace-chip" data-bad={bad ? 'true' : undefined} title={bad ? a.error : actionLabel(a.name, a.args)}>
                      <Icon name={bad ? 'alert' : (ACTION_ICON[a.name] || 'layers')} size={9} />
                      <span className="trace-chip-name">{actionLabel(a.name, a.args)}</span>
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The deliverable, one click away: every file the run wrote, plus whatever looks
 * like a build artifact (jar, exe, zip…), with "open folder" for the latter.
 */
function ResultFiles({ msg }: { msg: ChatMessage }): React.ReactElement | null {
  const t = useT()
  const openFile = useStore((s) => s.openFile)
  const files = useMemo(() => {
    const set = new Map<string, { rel: string; path?: string; artifact: boolean }>()
    for (const c of msg.tools || []) {
      const diffPaths = (c.diff || []).map((d) => d.path)
      const one = [c.args?.path, c.args?.rel].filter((x) => typeof x === 'string') as string[]
      for (const rel of [...diffPaths, ...one]) {
        if (!rel || /[\\/]$/.test(rel)) continue
        const artifact = /\.(jar|exe|msi|dmg|appimage|deb|zip|apk|aab)$/i.test(rel)
        const mutated = ['write_file', 'edit_file', 'multi_edit', 'move_path'].includes(c.name)
        if (!mutated && !artifact) continue
        set.set(rel, { rel, path: undefined, artifact })
      }
      if (c.attach?.rel) set.set(c.attach.rel, { rel: c.attach.rel, path: c.attach.path, artifact: true })
    }
    return [...set.values()].slice(0, 40)
  }, [msg])
  if (!files.length) return null
  const artifacts = files.filter((f) => f.artifact)
  return (
    <div className="result-files">
      <div className="result-files-head">
        <Icon name="layers" size={10} />
        <span>{t('chat.resultFiles', { n: files.length })}</span>
      </div>
      <div className="result-files-list">
        {files.map((f) => (
          <button
            key={f.rel}
            className="result-file"
            data-artifact={f.artifact ? 'true' : undefined}
            onClick={() => {
              if (f.path) window.comb.app.showItemInFolder(f.path)
              else void openFile(`${useStore.getState().workspace?.replace(/[\\/]+$/, '')}/${f.rel}`, f.rel)
            }}
            title={f.rel}
          >
            <Icon name={f.artifact ? 'download' : 'file'} size={10} />
            <span className="result-file-name">{f.rel.split(/[\\/]/).pop()}</span>
            <span className="result-file-dir">{f.rel.split(/[\\/]/).slice(0, -1).join('/')}</span>
          </button>
        ))}
      </div>
      {artifacts.length > 0 && (
        <div className="result-files-hint">
          <Icon name="folder" size={10} />
          {t('chat.artifactHint')}
        </div>
      )}
    </div>
  )
}

/**
 * The thinking block.
 *
 * Three things went wrong here before: the duration was guessed from the text
 * length (4 chars per second — hence "212 s" after twenty), the collapsed label
 * never moved while the model was still thinking, and the text itself was hidden
 * until you clicked. Now: the number comes from the main process's clock, it ticks
 * while it is live, and the tail of the thought streams in collapsed to a few
 * lines — you see that it is thinking, about what, without a wall of text.
 */
function ReasoningBlock({
  text,
  thinkingMs,
  live
}: {
  text: string
  thinkingMs: number
  live: boolean
}): React.ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // a live think keeps the collapsed preview glued to the last line written
  useEffect(() => {
    if (live && !open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [text, live, open])

  const secs = Math.max(0, Math.round(thinkingMs / 1000))
  // Old threads predate the measured clock: no duration is better than "0 s".
  const label = live
    ? t('chat.thinkingNow')
    : secs > 0
      ? t('chat.thoughtFor', { n: secs })
      : t('chat.thoughtDone')

  return (
    <div className="reasoning" data-live={live || undefined}>
      <button className="reasoning-toggle" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={9} />
        <Icon name="brain" size={11} className={live ? 'acc pulse' : 'acc'} />
        <span>{label}</span>
        {live && <span className="spinner" style={{ marginLeft: 4 }} />}
        <span className="reasoning-count">{t('chat.thoughtTokens', { n: Math.round(text.length / 4) })}</span>
      </button>
      <div
        ref={bodyRef}
        className="reasoning-body chat-text"
        data-collapsed={!open || undefined}
        hidden={!open && !live}
      >
        {text}
      </div>
    </div>
  )
}

function MessageRow({ msg, isLast, index }: { msg: ChatMessage; isLast: boolean; index: number }): React.ReactElement {
  const t = useT()
  const [showReasoning, setShowReasoning] = useState(false)
  const copy = (): void => window.comb.clipboard.write(msg.content)
  const regenerate = (): void => {
    const st = useStore.getState()
    const thread = st.threads.find((t) => t.id === st.activeThreadId)
    if (!thread) return
    const prevUser = [...thread.messages].reverse().find((m) => m.role === 'user')
    if (prevUser) void st.sendMessage(prevUser.content)
  }

  if (msg.role === 'user') {
    return (
      <div className="msg user" style={{ animationDelay: `${Math.min(index, 6) * 20}ms` }}>
        <div className="msg-user-body">
          <div className="chat-text msg-user-text">{msg.content}</div>
          {!!msg.attachments?.length && (
            <div className="msg-attachments">
              {msg.attachments.map((a) =>
                a.kind === 'image' && a.content ? (
                  <a key={a.id} className="msg-image" href="#" onClick={(e) => e.preventDefault()} title={a.name}>
                    <img src={a.content} alt={a.name} />
                  </a>
                ) : (
                  <span key={a.id} className="ctx-chip">
                    <Icon name={a.kind === 'selection' ? 'diff' : 'file'} size={10} /> {a.name}
                  </span>
                )
              )}
            </div>
          )}
        </div>
        <div className="msg-side">
          <span className="t-xs ghost">{new Date(msg.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
    )
  }

  const tools = msg.tools || []
  const hasText = !!msg.content?.trim()
  const reasoningTokens = msg.usage?.reasoningTokens || 0

  return (
    <div className="msg assistant">
      <div className="msg-gutter">
        <span className="msg-avatar">
          <Icon name="bee" size={12} />
        </span>
        <span className="msg-spine" />
      </div>
      <div className="msg-main">
        {msg.reasoning && (
          <ReasoningBlock
            text={msg.reasoning}
            thinkingMs={msg.thinkingMs || 0}
            live={!!msg.streaming && !msg.content?.trim()}
          />
        )}

        {/* The work goes first, the answer after it: you read what happened,
            then what it means. Guards and votes sit under the answer, where a
            decision you have to make belongs. */}
        {(msg.steps?.length || 0) > 0 ? (
          <StepTrace steps={msg.steps!} live={!!msg.streaming} />
        ) : (
          <StepNotes tools={msg.tools} live={!!msg.streaming} />
        )}

        {hasText && <Markdown text={msg.content} />}

        {!!msg.attachments?.length && (
          <div className="msg-attachments">
            {msg.attachments.map((a) => (
              <button
                key={a.id}
                className="ctx-chip acc"
                title={a.path || a.rel || a.name}
                onClick={() => {
                  if (a.path) window.comb.app.showItemInFolder(a.path)
                  else if (a.rel) void useStore.getState().openFile(`${useStore.getState().workspace?.replace(/[\\/]+$/, '')}/${a.rel}`, a.rel)
                }}
              >
                <Icon name="paperclip" size={10} /> {a.name}
              </button>
            ))}
          </div>
        )}

        {/* What the run actually produced, as something you can click. A finished
            task that says "done" and leaves you hunting in the sidebar is a dead
            end; these are the files and the artifact, right under the answer. */}
        {!msg.streaming && (msg.tools?.length || 0) > 0 && <ResultFiles msg={msg} />}

        {(msg.guards || []).map((g) => (
          <GuardNote key={g.id} kind={g.kind} title={g.title} detail={g.detail} />
        ))}

        {msg.vote && <VoteCard vote={msg.vote} />}


        {msg.error && (
          <div className="msg-error">
            <Icon name="alert" size={12} />
            <div className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{t('chat.requestFailed')}</span>
              <span className="t-sm dim selectable">{msg.error}</span>
              {/api key|401|auth/i.test(msg.error) && (
                <button className="link t-xs" onClick={() => useStore.setState({ settingsOpen: true })}>
                  {t('chat.openSettings')}
                </button>
              )}
            </div>
          </div>
        )}

        {!!msg.suggestions?.length && !msg.streaming && <Suggestions items={msg.suggestions} />}

        {msg.streaming && !hasText && !tools.length && (
          <div className="stream-cursor">
            <span className="stream-dot" />
            <span className="stream-dot" />
            <span className="stream-dot" />
          </div>
        )}

        {!msg.streaming && (hasText || tools.length) && (
          <div className="msg-actions">
            {hasText && (
              <button className="msg-action" onClick={copy} data-tip={t('common.copy')}>
                <Icon name="copy" size={11} />
              </button>
            )}
            {isLast && (
              <button className="msg-action" onClick={regenerate} data-tip={t('chat.regenerate')}>
                <Icon name="refresh" size={11} />
              </button>
            )}
            {msg.usage && msg.usage.completionTokens > 0 && (
              <span className="msg-usage t-xs ghost">
                {formatTokens(msg.usage.promptTokens)} {t('chat.usageIn')} · {formatTokens(msg.usage.completionTokens)} {t('chat.usageOut')}
                {msg.usage.cachedTokens > 0 ? ` · ${formatTokens(msg.usage.cachedTokens)} ${t('chat.usageCached')}` : ''}
                {reasoningTokens > 0 ? ` · ${formatTokens(reasoningTokens)} ${t('chat.usageReasoning')}` : ''}
                {` · ${formatCost(msg.usage.cost)}`}
              </span>
            )}
            {msg.stopped && <span className="pill warn">{t('chat.stopped')}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Onboarding({ workspace, onOpen }: { workspace: string | null; onOpen: () => void }): React.ReactElement {
  const t = useT()
  const sendMessage = useStore((s) => s.sendMessage)
  const prompts = [
    { icon: 'search' as const, title: t('onb.explainTitle'), body: t('onb.explainBody'), prompt: t('onb.explainPrompt') },
    { icon: 'zap' as const, title: t('onb.bugTitle'), body: t('onb.bugBody'), prompt: '' },
    { icon: 'sparkles' as const, title: t('onb.featureTitle'), body: t('onb.featureBody'), prompt: '' },
    { icon: 'shield' as const, title: t('onb.reviewTitle'), body: t('onb.reviewBody'), prompt: t('onb.reviewPrompt') }
  ]
  return (
    <div className="onboarding">
      <div className="onb-head">
        <span className="onb-mark">
          <Icon name="bee" size={22} />
        </span>
        <div className="col" style={{ gap: 2 }}>
          <h2 className="onb-title">{t('onb.title')}</h2>
          <span className="t-sm faint">{workspace ? t('onb.subFull') : t('onb.subNoFolder')}</span>
        </div>
      </div>
      <div className="onb-grid">
        {prompts.map((p) => (
          <button
            key={p.title}
            className="onb-card"
            onClick={() => {
              if (!workspace && p.icon !== 'sparkles') onOpen()
              else if (p.prompt) void sendMessage(p.prompt)
              else useStore.getState().toast('info', t('onb.typeRequest'))
            }}
          >
            <Icon name={p.icon} size={13} className="acc" />
            <span className="onb-card-title">{p.title}</span>
            <span className="t-xs faint" style={{ lineHeight: 1.5 }}>{p.body}</span>
          </button>
        ))}
      </div>
      <button
        className="onb-new"
        onClick={async () => {
          const folder = await window.comb.fs.pickFolder()
          if (!folder) return
          await useStore.getState().openWorkspace(folder)
          void sendMessage(t('onb.scaffoldPrompt'))
        }}
      >
        <Icon name="sparkles" size={12} className="acc" />
        <span className="t-sm">{t('onb.scaffold')}</span>
        <span className="spacer" />
        <Icon name="arrow-right" size={12} className="faint" />
      </button>
      <div className="onb-foot t-xs faint">
        {t('onb.foot')}
        <br />
        {t('onb.foot2').split('{undo}')[0]}
        <kbd>{t('onb.footUndo')}</kbd>
        {t('onb.foot2').split('{undo}')[1]}
      </div>
    </div>
  )
}
