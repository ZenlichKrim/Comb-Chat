import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { useStore, useActiveThread, formatTokens, formatCost, timeAgo } from '../store'
import type { Checkpoint } from '../../../shared/types'
import { useT } from '../lib/i18n'

export function RightPanel(): React.ReactElement {
  const t = useT()
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
          <Icon name="check-circle" size={12} /> {t('rp.plan')}
        </button>
        <button className="rp-tab" data-active={panel === 'context'} onClick={() => setPanel('context')}>
          <Icon name="layers" size={12} /> {t('rp.context')}
        </button>
        <button className="rp-tab" data-active={panel === 'history'} onClick={() => setPanel('history')}>
          <Icon name="history" size={12} /> {t('rp.history')}
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => setPanel('none')} data-tip={t('rp.hide')}>
          <Icon name="close" size={11} />
        </button>
      </div>

      {panel === 'plan' && (
        <div className="rp-body">
          <div className="rp-section">
            <div className="rp-head">
              <span className="cap">{t('rp.taskPlan')}</span>
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
                      {/* `text` is the shape the agent sends; older threads and
                          the main process both used `content`, and a todo row
                          without a label rendered as a bare checkbox. */}
                      <span className={`todo-text ${t.status === 'done' ? 'done' : ''}`}>
                        {(t as { text?: string; content?: string }).text ||
                          (t as { content?: string }).content ||
                          ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="rp-empty">
                <span className="t-xs faint">{t('rp.noPlan')}</span>
                <span className="t-xs ghost" style={{ lineHeight: 1.6 }}>
                  {t('rp.noPlanBody')}
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
  const t = useT()
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
          <span className="cap">{t('rp.runStats')}</span>
        </div>
        <div className="stat-grid">
          <Stat label={t('rp.steps')} value={thread ? String(thread.messages.filter((m) => m.role === 'assistant').length) : '0'} />
          <Stat label={t('rp.toolCalls')} value={String((thread?.messages || []).reduce((a, m) => a + (m.tools?.length || 0), 0))} />
          <Stat label={t('rp.tokens')} value={formatTokens((thread?.usage.promptTokens || 0) + (thread?.usage.completionTokens || 0))} />
          <Stat label={t('rp.cost')} value={formatCost(thread?.usage.cost || 0)} />
        </div>
        <div className="rp-kv">
          <span className="faint">{t('rp.policy')}</span>
          <span className="mono">{settings.approvalPolicy}</span>
        </div>
        <div className="rp-kv">
          <span className="faint">{t('rp.model')}</span>
          <span className="mono">{settings.model}</span>
        </div>
        <div className="rp-kv">
          <span className="faint">{t('rp.maxSteps')}</span>
          <span className="mono">{settings.maxAgentSteps}</span>
        </div>
      </div>

      <div className="rp-section grow">
        <div className="rp-head">
          <span className="cap">{t('rp.changedThisRun')}</span>
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
          <span className="t-xs ghost">{t('rp.nothingChanged')}</span>
        )}
        {!!git?.files.length && (
          <div className="rp-note">
            <Icon name="git" size={10} />
            <span className="t-xs faint">{t('rp.uncommitted', { n: git.files.length })}</span>
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
  const t = useT()
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
          <span className="cap">{t('rp.openInEditor')}</span>
          <span className="spacer" />
          <span className="t-xs faint">{tabs.length}</span>
        </div>
        {tabs.length ? (
          tabs.map((tab) => (
            <div key={tab.path} className="ctx-row">
              <Icon name="file" size={11} className={tab.dirty ? 'warn' : 'faint'} />
              <span className="ellipsis t-xs" title={tab.rel}>{tab.rel}</span>
              <button
                className="icon-btn"
                style={{ width: 16, height: 16 }}
                data-tip={t('rp.attachToPrompt')}
                onClick={() => {
                  addContext({ id: `f_${Date.now()}`, kind: 'file', path: tab.path, rel: tab.rel, name: tab.rel.split('/').pop() || tab.rel, content: tab.content })
                  toast('ok', t('rp.attached'))
                }}
              >
                <Icon name="plus" size={10} />
              </button>
            </div>
          ))
        ) : (
          <span className="t-xs ghost">{t('rp.noFilesOpen')}</span>
        )}
      </div>

      <div className="rp-section">
        <div className="rp-head">
          <span className="cap">{t('rp.attachedToNext')}</span>
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
          <span className="t-xs ghost">{t('rp.attachHint')}</span>
        )}
      </div>

      <div className="rp-section grow">
        <div className="rp-head">
          <span className="cap">{t('rp.projectInstructions')}</span>
          <span className="spacer" />
          {instructions !== settings.customInstructions && (
            <button className="link t-xs" onClick={() => void setSettings({ customInstructions: instructions })}>
              {t('common.save')}
            </button>
          )}
        </div>
        <textarea
          className="textarea rp-textarea"
          value={instructions}
          spellCheck={false}
          placeholder={t('rp.instructionsPlaceholder')}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() => {
            if (instructions !== settings.customInstructions) void setSettings({ customInstructions: instructions })
          }}
        />
        <div className="rp-kv" style={{ marginTop: 8 }}>
          <span className="faint">{t('rp.workspace')}</span>
          <span className="mono ellipsis t-xs" title={workspace || ''}>{workspace ? workspace.split(/[\\/]/).pop() : '—'}</span>
        </div>
        <div className="rp-kv">
          <span className="faint">{t('rp.contextBudget')}</span>
          <span className="mono t-xs">{Math.round((settings.model.includes('reasoner') ? 131072 : 131072) / 1024)}k</span>
        </div>
        <span className="hidden">{model}</span>
      </div>
    </div>
  )
}

function HistoryPanel(): React.ReactElement {
  const t = useT()
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
          <span className="cap">{t('rp.checkpoints')}</span>
          <span className="spacer" />
          <span className="t-xs faint">{merged.length}</span>
        </div>
        <span className="t-xs ghost" style={{ lineHeight: 1.6, marginBottom: 8, display: 'block' }}>
          {t('rp.checkpointsHint')}
        </span>
        {merged.map((c) => (
          <div key={c.id} className="checkpoint-row">
            <Icon name="history" size={11} className="faint" />
            <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
              <span className="t-xs ellipsis">{c.label}</span>
              <span className="t-xs ghost">{timeAgo(c.createdAt)} · {t('rp.fileCount', { n: c.files.length })}</span>
            </div>
            <button
              className="btn ghost sm"
              onClick={async () => {
                await restore(c.id)
                toast('ok', t('rp.restoredToast'))
              }}
            >
              {t('rp.restoreShort')}
            </button>
          </div>
        ))}
        {!merged.length && <span className="t-xs ghost">{t('rp.noCheckpoints')}</span>}
      </div>
    </div>
  )
}
