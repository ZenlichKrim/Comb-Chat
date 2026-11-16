import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { useStore, useActiveThread, formatCost, formatTokens, timeAgo } from '../store'
import type { Attachment, ChatMessage, ApprovalPolicy } from '../../../shared/types'
import { MODELS } from '../../../shared/types'

export function ChatPane(): React.ReactElement {
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
      const full = (file as File & { path?: string }).path
      if (!full) continue
      const rel = workspace && full.startsWith(workspace) ? full.slice(workspace.length + 1).replace(/\\/g, '/') : full.split(/[\\/]/).pop() || full
      const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(full)
      let content = ''
      try {
        content = isImage ? '' : (await window.comb.fs.read(full)).content
      } catch {
        st.toast('err', `Could not read ${rel}`)
        continue
      }
      if (!isImage && content.length > 200_000) content = content.slice(0, 200_000) + '\n… [truncated]'
      st.addContextFile({
        id: `drop_${Date.now()}_${attached}`,
        kind: isImage ? 'image' : 'file',
        path: full,
        rel,
        name: rel.split('/').pop() || rel,
        content
      })
      attached += 1
    }
    if (attached) st.toast('ok', `${attached} file${attached > 1 ? 's' : ''} attached to context`)
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

  const [input, setInput] = useState('')
  const [historyIdx, setHistoryIdx] = useState(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pinnedBottom = useRef(true)
  const messages = thread?.messages || []
  const model = MODELS.find((m) => m.id === settings.model) || MODELS[0]

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

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  }

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (!text || running) return
    setInput('')
    setHistoryIdx(-1)
    pinnedBottom.current = true
    await sendMessage(text, contextFiles)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Enter') {
      if (settings.sendOnEnter ? !e.shiftKey && !mod : mod) {
        e.preventDefault()
        void submit()
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
          <h2 className="t-lg" style={{ fontWeight: 700 }}>No session</h2>
          <button className="btn primary" onClick={() => newThread()}>
            <Icon name="plus" size={12} /> Start a session
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
            <span className="t-sm">Drop files to add them to the agent context</span>
          </div>
        </div>
      )}
      <div className="chat-head">
        <div className="col" style={{ minWidth: 0, gap: 1 }}>
          <span className="t-sm ellipsis" style={{ fontWeight: 600, color: 'var(--fg-0)' }}>
            {thread.title}
          </span>
          <span className="t-xs ghost">
            {timeAgo(thread.createdAt)} · {messages.filter((m) => m.role === 'user').length} turns
            {usage && usage.completionTokens > 0 ? ` · ${formatTokens(usage.promptTokens + usage.completionTokens)} tok · ${formatCost(usage.cost)}` : ''}
          </span>
        </div>
        <span className="spacer" />
        {checkpoints.length > 0 && (
          <button className="btn ghost sm" data-tip="Undo the last agent changes" onClick={() => void undoLastRun()}>
            <Icon name="undo" size={11} /> undo run
          </button>
        )}
        <button className="btn ghost sm" onClick={() => newThread()} data-tip="New session (Ctrl+N)">
          <Icon name="plus" size={11} /> new
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
            {running && <div className="thinking-row"><span className="spinner" /> <span className="faint t-xs">comb is working…</span></div>}
          </div>
        )}
      </div>

      {pendingApproval && (
        <div className="approval-bar">
          <Icon name="shield" size={13} className="warn" />
          <span className="approval-label">
            <span className="t-sm" style={{ fontWeight: 600 }}>{pendingApproval.name}</span>
            <span className="t-xs dim ellipsis">
              {pendingApproval.args?.command
                ? String(pendingApproval.args.command).slice(0, 90)
                : pendingApproval.args?.path || 'no arguments'}
            </span>
          </span>
          <span className="spacer" />
          {!!pendingApproval.diff?.length && (
            <button
              className="btn ghost sm"
              data-tip="Review the full diff"
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
              <Icon name="diff" size={11} /> review
            </button>
          )}
          <button className="btn primary sm" onClick={() => void approve('allow')}>
            <Icon name="check" size={11} /> allow
          </button>
          <button className="btn sm" onClick={() => void approve('allow-always')}>
            always
          </button>
          <button className="btn danger sm" onClick={() => void approve('deny')}>
            deny
          </button>
        </div>
      )}

      <div className="composer-wrap">
        <div className="composer" data-running={running}>
          {contextFiles.length > 0 && (
            <div className="composer-context">
              {contextFiles.map((c) => (
                <span key={c.id} className="ctx-chip">
                  <Icon name={c.kind === 'selection' ? 'diff' : 'file'} size={10} />
                  {c.name}
                  <button onClick={() => removeContextFile(c.id)}>
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
            placeholder={
              workspace
                ? running
                  ? 'comb is working — press escape to stop…'
                  : 'Describe a task, paste an error, or ask about the code…'
                : 'Open a folder to let comb edit files, or ask a question…'
            }
            rows={1}
            spellCheck={false}
            disabled={running}
          />
          <div className="composer-bar">
            <button
              className="composer-chip"
              data-tip="Approval policy"
              onClick={() => {
                const order: ApprovalPolicy[] = ['ask', 'auto-edit', 'yolo']
                const next = order[(order.indexOf(settings.approvalPolicy) + 1) % order.length]
                void setSettings({ approvalPolicy: next })
              }}
            >
              <Icon name={settings.approvalPolicy === 'yolo' ? 'zap' : settings.approvalPolicy === 'auto-edit' ? 'edit' : 'shield'} size={11} className={settings.approvalPolicy === 'yolo' ? 'err' : settings.approvalPolicy === 'auto-edit' ? 'warn' : 'ok'} />
              {settings.approvalPolicy === 'ask' ? 'ask first' : settings.approvalPolicy === 'auto-edit' ? 'auto-edit' : 'yolo'}
            </button>
            <button className="composer-chip" data-tip="Toggle workspace context" onClick={() => void setSettings({ autoContext: !settings.autoContext })}>
              <Icon name="layers" size={11} className={settings.autoContext ? 'acc' : 'faint'} />
              context {settings.autoContext ? 'on' : 'off'}
            </button>
            <button className="composer-chip" onClick={() => setBottomPanel(bottomPanel === 'terminal' ? 'none' : 'terminal')} data-tip="Terminal (Ctrl+`)">
              <Icon name="terminal" size={11} />
              terminal
            </button>
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
                {changed.length} file{changed.length > 1 ? 's' : ''} changed
              </span>
            )}
            {running ? (
              <button className="send-btn stop" onClick={() => void stopRun()} data-tip="Stop (Esc)">
                <Icon name="stop" size={11} />
              </button>
            ) : (
              <button className="send-btn" onClick={() => void submit()} disabled={!input.trim()} data-tip="Send (Enter)">
                <Icon name="arrow-up" size={13} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
        <div className="composer-foot">
          <span className="t-xs ghost">
            {model.label} · {MODELS.find((m) => m.id === settings.model)?.blurb}
          </span>
          <span className="spacer" />
          <span className="t-xs ghost">
            {settings.sendOnEnter ? (
              <>
                <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
              </>
            ) : (
              <>
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> send
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function MessageRow({ msg, isLast, index }: { msg: ChatMessage; isLast: boolean; index: number }): React.ReactElement {
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
              {msg.attachments.map((a) => (
                <span key={a.id} className="ctx-chip">
                  <Icon name={a.kind === 'selection' ? 'diff' : 'file'} size={10} /> {a.name}
                </span>
              ))}
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
          <div className="reasoning">
            <button className="reasoning-toggle" onClick={() => setShowReasoning((v) => !v)}>
              <Icon name={showReasoning ? 'chevron-down' : 'chevron-right'} size={9} />
              <Icon name="sparkles" size={10} className="acc" />
              <span>thought for {(msg.reasoning.length / 4).toFixed(0)}s</span>
              {msg.streaming && <span className="spinner" style={{ marginLeft: 4 }} />}
            </button>
            {showReasoning && <div className="reasoning-body chat-text">{msg.reasoning}</div>}
          </div>
        )}

        {tools.map((t) => (
          <ToolCard key={t.id} call={t} />
        ))}

        {msg.error && (
          <div className="msg-error">
            <Icon name="alert" size={12} />
            <div className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 600 }}>Request failed</span>
              <span className="t-sm dim selectable">{msg.error}</span>
              {/api key|401|auth/i.test(msg.error) && (
                <button className="link t-xs" onClick={() => useStore.setState({ settingsOpen: true })}>
                  open settings →
                </button>
              )}
            </div>
          </div>
        )}

        {hasText && <Markdown text={msg.content} />}

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
              <button className="msg-action" onClick={copy} data-tip="Copy">
                <Icon name="copy" size={11} />
              </button>
            )}
            {isLast && (
              <button className="msg-action" onClick={regenerate} data-tip="Regenerate">
                <Icon name="refresh" size={11} />
              </button>
            )}
            {msg.usage && msg.usage.completionTokens > 0 && (
              <span className="msg-usage t-xs ghost">
                {formatTokens(msg.usage.promptTokens)} in · {formatTokens(msg.usage.completionTokens)} out
                {msg.usage.cachedTokens > 0 ? ` · ${formatTokens(msg.usage.cachedTokens)} cached` : ''}
                {reasoningTokens > 0 ? ` · ${formatTokens(reasoningTokens)} reasoning` : ''}
                {` · ${formatCost(msg.usage.cost)}`}
              </span>
            )}
            {msg.stopped && <span className="pill warn">stopped</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Onboarding({ workspace, onOpen }: { workspace: string | null; onOpen: () => void }): React.ReactElement {
  const sendMessage = useStore((s) => s.sendMessage)
  const prompts = [
    { icon: 'search' as const, title: 'Explain this codebase', body: 'Map the architecture, entry points and the 5 most important files.', prompt: 'Explore this repository and explain its architecture: entry points, main modules, data flow, and the five files I should read first. Point out anything surprising or risky.' },
    { icon: 'zap' as const, title: 'Fix a bug', body: 'Paste a stack trace or describe broken behaviour.', prompt: '' },
    { icon: 'sparkles' as const, title: 'Build a feature', body: 'Describe it — the agent plans, edits and verifies.', prompt: '' },
    { icon: 'shield' as const, title: 'Review my changes', body: 'Audit the working tree for bugs and regressions.', prompt: 'Review my uncommitted changes (use git diff). Report real bugs, edge cases and regressions only — no style nitpicks. Then fix the important ones.' }
  ]
  return (
    <div className="onboarding">
      <div className="onb-head">
        <span className="onb-mark">
          <Icon name="bee" size={22} />
        </span>
        <div className="col" style={{ gap: 2 }}>
          <h2 className="onb-title">What are we building?</h2>
          <span className="t-sm faint">
            {workspace ? 'Comb has full access to this folder.' : 'Open a folder for edits, or ask anything.'}
          </span>
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
              else useStore.getState().toast('info', 'Type your request below')
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
          void sendMessage(
            'Scaffold this empty folder into a working project. First inspect what is already there (list_dir). If it is essentially empty, ask me one question about the stack only if my message did not say — otherwise pick a sensible stack, create the project skeleton, install dependencies, add a README and one passing test, then run the test suite and report the result.'
          )
        }}
      >
        <Icon name="sparkles" size={12} className="acc" />
        <span className="t-sm">Start a project from an empty folder</span>
        <span className="spacer" />
        <Icon name="arrow-right" size={12} className="faint" />
      </button>
      <div className="onb-foot t-xs faint">
        comb edits files in place, runs your tests, and asks before anything destructive.
        <br />
        Every run is checkpointed — <kbd>undo run</kbd> puts your files back.
      </div>
    </div>
  )
}
