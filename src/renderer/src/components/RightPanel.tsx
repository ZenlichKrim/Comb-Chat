import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { useStore, useActiveThread, formatTokens, formatCost, timeAgo } from '../store'
import type { Checkpoint } from '../../../shared/types'

export function RightPanel(): React.ReactElement {
  const panel = useStore((s) => s.rightPanel)
  const setPanel = useStore((s) => s.setRightPanel)
  const thread = useActiveThread()
  const todos = thread?.todos || []
  const doneCount = todos.filter((t) => t.status === 'done').length
  const pct = todos.length ? Math.round((doneCount / todos.length) * 100) : 0

  return (
    <aside className="right-panel">
      <div className="rp-tabs">
        <button className="rp-tab" data-active={panel === 'plan'} onClick={() => setPanel('plan')}>
          <Icon name="check-circle" size={12} /> plan
        </button>
        <button className="rp-tab" data-active={panel === 'context'} onClick={() => setPanel('context')}>
          <Icon name="layers" size={12} /> context
        </button>
        <button className="rp-tab" data-active={panel === 'history'} onClick={() => setPanel('history')}>
          <Icon name="history" size={12} /> history
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => setPanel('none')} data-tip="Hide panel">
          <Icon name="close" size={11} />
        </button>
      </div>

      {panel === 'plan' && (
        <div className="rp-body">
          <div className="rp-section">
            <div className="rp-head">
              <span className="cap">task plan</span>
              <span className="spacer" />
              <span className="t-xs faint">{doneCount}/{todos.length}</span>
            </div>
            {todos.length ? (
              <>
                <div className="progress">
                  <span style={{ width: `${pct}%` }} />
                </div>
                <div className="todos">
                  {todos.map((t) => (
                    <div key={t.id} className="todo" data-status={t.status}>
                      <span className="todo-check">
                        {t.status === 'done' ? (
                          <Icon name="check" size={9} />
                        ) : t.status === 'in_progress' ? (
                          <span className="spinner" style={{ width: 8, height: 8 }} />
                        ) : null}
                      </span>
                      <span className={`todo-text ${t.status === 'done' ? 'done' : ''}`}>{t.text}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="rp-empty">
                <span className="t-xs faint">No plan yet.</span>
                <span className="t-xs ghost" style={{ lineHeight: 1.6 }}>
                  The agent writes a plan here for multi-step tasks so you can see exactly where it is.
                </span>
              </div>
            )}
          </div>
          <PlanStats />
        </div>
      )}

      {panel === 'context' && <ContextPanel />}
      {panel === 'history' && <HistoryPanel />}
    </aside>
  )
}

function PlanStats(): React.ReactElement {
  const thread = useActiveThread()
  const settings = useStore((s) => s.settings)
  const changed = useStore((s) => s.changedFiles)
  const diffPreview = useStore((s) => s.setDiffPreview)
  const workspace = useStore((s) => s.workspace)
  const openFile = useStore((s) => s.openFile)
  const git = useStore((s) => s.git)

  return (
    <>
      <div className="rp-section">
        <div className="rp-head">
          <span className="cap">run stats</span>
        </div>
        <div className="stat-grid">
          <Stat label="steps" value={thread ? String(thread.messages.filter((m) => m.role === 'assistant').length) : '0'} />
          <Stat label="tool calls" value={String((thread?.messages || []).reduce((a, m) => a + (m.tools?.length || 0), 0))} />
          <Stat label="tokens" value={formatTokens((thread?.usage.promptTokens || 0) + (thread?.usage.completionTokens || 0))} />
          <Stat label="cost" value={formatCost(thread?.usage.cost || 0)} />
        </div>
        <div className="rp-kv">
          <span className="faint">policy</span>
          <span className="mono">{settings.approvalPolicy}</span>
        </div>
        <div className="rp-kv">
          <span className="faint">model</span>
          <span className="mono">{settings.model}</span>
        </div>
        <div className="rp-kv">
          <span className="faint">max steps</span>
          <span className="mono">{settings.maxAgentSteps}</span>
        </div>
      </div>

      <div className="rp-section grow">
        <div className="rp-head">
          <span className="cap">changed this run</span>
          <span className="spacer" />
          <span className="t-xs faint">{changed.length}</span>
        </div>
        {changed.length ? (
          changed.map((rel) => (
            <button
              key={rel}
              className="changed-row"
              onClick={() => {
                if (!workspace) return
                const path = `${workspace.replace(/\\/g, '/')}/${rel}`
                void openFile(path, rel)
              }}
            >
              <Icon name="file" size={11} className="acc" />
              <span className="ellipsis">{rel}</span>
            </button>
          ))
        ) : (
          <span className="t-xs ghost">Nothing yet — the agent's edits will appear here.</span>
        )}
        {!!git?.files.length && (
          <div className="rp-note">
            <Icon name="git" size={10} />
            <span className="t-xs faint">{git.files.length} uncommitted in working tree</span>
          </div>
        )}
        <span className="hidden">{String(!!diffPreview)}{String(!!thread)}</span>
      </div>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  )
}

function ContextPanel(): React.ReactElement {
  const tabs = useStore((s) => s.tabs)
  const settings = useStore((s) => s.settings)
  const workspace = useStore((s) => s.workspace)
  const contextFiles = useStore((s) => s.contextFiles)
  const remove = useStore((s) => s.removeContextFile)
  const addContext = useStore((s) => s.addContextFile)
  const toast = useStore((s) => s.toast)
  const model = settings.model
  const [instructions, setInstructions] = useState(settings.customInstructions)
  const setSettings = useStore((s) => s.setSettings)

  useEffect(() => setInstructions(settings.customInstructions), [settings.customInstructions])

  return (
    <div className="rp-body">
      <div className="rp-section">
        <div className="rp-head">
          <span className="cap">open in editor</span>
          <span className="spacer" />
          <span className="t-xs faint">{tabs.length}</span>
        </div>
        {tabs.length ? (
          tabs.map((t) => (
            <div key={t.path} className="ctx-row">
              <Icon name="file" size={11} className={t.dirty ? 'warn' : 'faint'} />
              <span className="ellipsis t-xs" title={t.rel}>{t.rel}</span>
              <button
                className="icon-btn"
                style={{ width: 16, height: 16 }}
                data-tip="Attach to prompt"
                onClick={() => {
                  addContext({ id: `f_${Date.now()}`, kind: 'file', path: t.path, rel: t.rel, name: t.rel.split('/').pop() || t.rel, content: t.content })
                  toast('ok', 'Attached')
                }}
              >
                <Icon name="plus" size={10} />
              </button>
            </div>
          ))
        ) : (
          <span className="t-xs ghost">No files open</span>
        )}
      </div>

      <div className="rp-section">
        <div className="rp-head">
          <span className="cap">attached to next prompt</span>
          <span className="spacer" />
          <span className="t-xs faint">{contextFiles.length}</span>
        </div>
        {contextFiles.length ? (
          contextFiles.map((c) => (
            <div key={c.id} className="ctx-row">
              <Icon name={c.kind === 'selection' ? 'diff' : 'file'} size={11} className="acc" />
              <span className="ellipsis t-xs" title={c.name}>{c.name}</span>
              <button className="icon-btn" style={{ width: 16, height: 16 }} onClick={() => remove(c.id)}>
                <Icon name="close" size={9} />
              </button>
            </div>
          ))
        ) : (
          <span className="t-xs ghost">Select code → attach (⌘⇧A)</span>
        )}
      </div>

      <div className="rp-section grow">
        <div className="rp-head">
          <span className="cap">project instructions</span>
          <span className="spacer" />
          {instructions !== settings.customInstructions && (
            <button className="link t-xs" onClick={() => void setSettings({ customInstructions: instructions })}>
              save
            </button>
          )}
        </div>
        <textarea
          className="textarea rp-textarea"
          value={instructions}
          spellCheck={false}
          placeholder={`Rules for this project, e.g.\n- Use pnpm, never npm\n- Tests: pnpm vitest\n- Never touch src/legacy`}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() => {
            if (instructions !== settings.customInstructions) void setSettings({ customInstructions: instructions })
          }}
        />
        <div className="rp-kv" style={{ marginTop: 8 }}>
          <span className="faint">workspace</span>
          <span className="mono ellipsis t-xs" title={workspace || ''}>{workspace ? workspace.split(/[\\/]/).pop() : '—'}</span>
        </div>
        <div className="rp-kv">
          <span className="faint">context budget</span>
          <span className="mono t-xs">{Math.round((settings.model.includes('reasoner') ? 131072 : 131072) / 1024)}k</span>
        </div>
        <span className="hidden">{model}</span>
      </div>
    </div>
  )
}

function HistoryPanel(): React.ReactElement {
  const checkpoints = useStore((s) => s.checkpoints)
  const restore = useStore((s) => s.restoreCheckpoint)
  const toast = useStore((s) => s.toast)
  const [items, setItems] = useState<Checkpoint[]>([])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const id = useStore.getState().activeThreadId
      if (!id) return setItems([])
      const list = (await window.comb.checkpoints.list(id)) as Checkpoint[]
      if (!cancelled) setItems(list)
    }
    void load()
    const t = setInterval(load, 4000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [checkpoints])

  const merged = useMemo(() => {
    const map = new Map<string, Checkpoint>()
    for (const c of [...checkpoints, ...items]) map.set(c.id, c)
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt)
  }, [checkpoints, items])

  return (
    <div className="rp-body">
      <div className="rp-section grow">
        <div className="rp-head">
          <span className="cap">checkpoints</span>
          <span className="spacer" />
          <span className="t-xs faint">{merged.length}</span>
        </div>
        <span className="t-xs ghost" style={{ lineHeight: 1.6, marginBottom: 8, display: 'block' }}>
          Every agent edit round is snapshotted. Restore puts the previous file contents back.
        </span>
        {merged.map((c) => (
          <div key={c.id} className="checkpoint-row">
            <Icon name="history" size={11} className="faint" />
            <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
              <span className="t-xs ellipsis">{c.label}</span>
              <span className="t-xs ghost">{timeAgo(c.createdAt)} · {c.files.length} files</span>
            </div>
            <button
              className="btn ghost sm"
              onClick={async () => {
                await restore(c.id)
                toast('ok', 'Checkpoint restored')
              }}
            >
              restore
            </button>
          </div>
        ))}
        {!merged.length && <span className="t-xs ghost">No checkpoints in this session yet.</span>}
      </div>
    </div>
  )
}
