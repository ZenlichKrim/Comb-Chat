import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { useStore, useActiveThread, formatCost, formatTokens, timeAgo } from '../store'
import { useT } from '../lib/i18n'
import type { Attachment, ChatMessage, ApprovalPolicy } from '../../../shared/types'
import { MODELS } from '../../../shared/types'

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
      const full = (file as File & { path?: string }).path
      if (!full) continue
      const rel = workspace && full.startsWith(workspace) ? full.slice(workspace.length + 1).replace(/\\/g, '/') : full.split(/[\\/]/).pop() || full
      const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(full)
      let content = ''
      try {
        content = isImage ? '' : (await window.comb.fs.read(full)).content
      } catch {
        st.toast('err', t('chat.couldNotRead', { rel }))
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
            {running && <div className="thinking-row"><span className="spinner" /> <span className="faint t-xs">{t('chat.working')}</span></div>}
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
                  ? t('chat.placeholderWorking')
                  : t('chat.placeholderReady')
                : t('chat.placeholderNoFolder')
            }
            rows={1}
            spellCheck={false}
            disabled={running}
          />
          <div className="composer-bar">
            <button
              className="composer-chip"
              data-tip={t('chat.approvalPolicy')}
              onClick={() => {
                const order: ApprovalPolicy[] = ['ask', 'auto-edit', 'yolo']
                const next = order[(order.indexOf(settings.approvalPolicy) + 1) % order.length]
                void setSettings({ approvalPolicy: next })
              }}
            >
              <Icon name={settings.approvalPolicy === 'yolo' ? 'zap' : settings.approvalPolicy === 'auto-edit' ? 'edit' : 'shield'} size={11} className={settings.approvalPolicy === 'yolo' ? 'err' : settings.approvalPolicy === 'auto-edit' ? 'warn' : 'ok'} />
              {settings.approvalPolicy === 'ask' ? t('chat.policyAsk') : settings.approvalPolicy === 'auto-edit' ? t('chat.policyAuto') : t('chat.policyYolo')}
            </button>
            <button className="composer-chip" data-tip={t('chat.contextTip')} onClick={() => void setSettings({ autoContext: !settings.autoContext })}>
              <Icon name="layers" size={11} className={settings.autoContext ? 'acc' : 'faint'} />
              {settings.autoContext ? t('chat.contextOn') : t('chat.contextOff')}
            </button>
            <button className="composer-chip" onClick={() => setBottomPanel(bottomPanel === 'terminal' ? 'none' : 'terminal')} data-tip={t('chat.terminalTip')}>
              <Icon name="terminal" size={11} />
              {t('chat.terminal')}
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
                {changed.length === 1 ? t('chat.filesChanged', { n: 1 }) : t('chat.filesChangedPlural', { n: changed.length })}
              </span>
            )}
            {running ? (
              <button className="send-btn stop" onClick={() => void stopRun()} data-tip={t('chat.stopTip')}>
                <Icon name="stop" size={11} />
              </button>
            ) : (
              <button className="send-btn" onClick={() => void submit()} disabled={!input.trim()} data-tip={t('chat.sendTip')}>
                <Icon name="arrow-up" size={13} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
        <div className="composer-foot">
          <span className="t-xs ghost">
            {model.label} · {t(settings.model === 'deepseek-reasoner' ? 'model.blurbReasoner' : 'model.blurbChat')}
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
              <span>{t('chat.thoughtFor', { n: (msg.reasoning.length / 4).toFixed(0) })}</span>
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
