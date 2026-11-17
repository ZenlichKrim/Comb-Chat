import React, { useState } from 'react'
import type { ToolResultView } from '../../../shared/types'
import { Icon, type IconName } from './Icon'
import { DiffView } from './CodeBlock'
import { useStore } from '../store'
import { useT } from '../lib/i18n'
import type { DictKey } from '../../../shared/i18n'

/** label/verb are dictionary keys so the card follows the UI language. */
const TOOL_META: Record<string, { icon: IconName; label: DictKey; verb: DictKey }> = {
  read_file: { icon: 'file', label: 'tool.read', verb: 'tool.verbReading' },
  write_file: { icon: 'save', label: 'tool.write', verb: 'tool.verbWriting' },
  edit_file: { icon: 'edit', label: 'tool.edit', verb: 'tool.verbEditing' },
  multi_edit: { icon: 'edit', label: 'tool.multiEdit', verb: 'tool.verbEditing' },
  list_dir: { icon: 'folder', label: 'tool.list', verb: 'tool.verbListing' },
  glob: { icon: 'search', label: 'tool.glob', verb: 'tool.verbMatching' },
  grep: { icon: 'search', label: 'tool.grep', verb: 'tool.verbSearching' },
  run_command: { icon: 'terminal', label: 'tool.run', verb: 'tool.verbRunning' },
  delete_path: { icon: 'trash', label: 'tool.delete', verb: 'tool.verbDeleting' },
  move_path: { icon: 'arrow-right', label: 'tool.move', verb: 'tool.verbMoving' },
  todo_write: { icon: 'check', label: 'tool.plan', verb: 'tool.verbPlanning' },
  ask_user: { icon: 'chat', label: 'tool.ask', verb: 'tool.verbAsking' },
  notify_user: { icon: 'bell', label: 'tool.notify', verb: 'tool.verbNotifying' },
  suggest: { icon: 'sparkles', label: 'tool.suggest', verb: 'tool.verbSuggestion' },
  leave_note: { icon: 'sticky', label: 'tool.note', verb: 'tool.verbNote' },
  attach_file: { icon: 'paperclip', label: 'tool.attach_file', verb: 'tool.verbAttaching' },
  finish: { icon: 'check-circle', label: 'tool.done', verb: 'tool.verbFinishing' }
}

function summarise(call: ToolResultView, t: (k: DictKey, v?: Record<string, string | number>) => string): string {
  const a = call.args || {}
  switch (call.name) {
    case 'read_file':
      return a.path || ''
    case 'write_file':
    case 'edit_file':
    case 'multi_edit':
      return a.path || (a.edits ? t('tool.edits', { n: a.edits.length }) : '')
    case 'list_dir':
      return a.path || '.'
    case 'glob':
      return a.pattern || ''
    case 'grep':
      return `/${a.pattern}/` + (a.glob ? ` in ${a.glob}` : '')
    case 'run_command':
      return a.command || ''
    case 'delete_path':
      return a.path || ''
    case 'move_path':
      return `${a.from} → ${a.to}`
    case 'todo_write':
      return t('tool.steps', { n: (a.todos || []).length })
    case 'finish':
      return t('tool.summary')
    default:
      return ''
  }
}

function statusPill(
  status: ToolResultView['status'],
  t: (k: DictKey, v?: Record<string, string | number>) => string
): React.ReactElement {
  switch (status) {
    case 'running':
      return (
        <span className="tool-status running">
          <span className="spinner" />
        </span>
      )
    case 'awaiting-approval':
      return <span className="tool-status warn">{t('tool.needsApproval')}</span>
    case 'ok':
      return (
        <span className="tool-status ok">
          <Icon name="check" size={10} />
        </span>
      )
    case 'error':
      return (
        <span className="tool-status err">
          <Icon name="x-circle" size={10} />
        </span>
      )
    case 'denied':
      return <span className="tool-status err">{t('tool.denied')}</span>
    case 'aborted':
      return <span className="tool-status faint">{t('tool.stopped')}</span>
    default:
      return <span className="tool-status faint">{t('tool.queued')}</span>
  }
}

export function ToolCard({ call }: { call: ToolResultView }): React.ReactElement {
  const t = useT()
  const meta = TOOL_META[call.name] || { icon: 'zap' as IconName, label: call.name as DictKey, verb: call.name as DictKey }
  const [open, setOpen] = useState(false)
  const hasDiff = !!call.diff?.length
  const wantsOpen = call.status === 'error' || call.status === 'awaiting-approval'
  const expanded = open || wantsOpen
  const settings = useStore((s) => s.settings)
  const openFile = useStore((s) => s.openFile)
  const workspace = useStore((s) => s.workspace)
  const diff = call.diff?.reduce((a, d) => ({ add: a.add + d.additions, del: a.del + d.deletions }), { add: 0, del: 0 })

  // a handed-over file renders as a real card, not a collapsible row: the point
  // is that the user can look at it without hunting through the tree
  if (call.name === 'attach_file' && call.attach) {
    return <AttachCard call={call} />
  }

  return (
    <div className="tool-card" data-status={call.status}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={9} className="tool-caret" />
        <Icon name={meta.icon} size={11} className="tool-icon" />
        <span className="tool-label">{TOOL_META[call.name] ? t(meta.label) : meta.label}</span>
        <span className="tool-arg ellipsis">{summarise(call, t)}</span>
        {diff && (diff.add > 0 || diff.del > 0) && (
          <span className="tool-stats">
            <span className="ok">+{diff.add}</span>
            <span className="err">−{diff.del}</span>
          </span>
        )}
        {call.durationMs ? <span className="tool-time faint">{call.durationMs < 1000 ? `${call.durationMs}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}</span> : null}
        {statusPill(call.status, t)}
      </button>

      {expanded && (
        <div className="tool-body">
          {call.status === 'awaiting-approval' && <ApprovalInline call={call} />}
          {call.status === 'denied' && <div className="tool-note err">{t('tool.deniedNote')}</div>}

          {hasDiff ? (
            (call.diff || []).map((d, i) => (
              <div key={i} className="tool-diff">
                <div className="tool-diff-head">
                  <span className={`pill ${d.kind === 'create' ? 'ok' : d.kind === 'delete' ? 'err' : 'acc'}`}>
                    {d.kind === 'create' ? t('tool.newFile') : d.kind === 'delete' ? t('tool.deleted') : t('tool.modified')}
                  </span>
                  <button
                    className="link"
                    onClick={() => {
                      if (workspace) void openFile(d.path, d.rel)
                    }}
                  >
                    {d.rel}
                  </button>
                  <span className="spacer" />
                  <span className="t-xs ok">+{d.additions}</span>
                  <span className="t-xs err">−{d.deletions}</span>
                  <button
                    className="icon-btn"
                    style={{ width: 18, height: 18 }}
                    data-tip={t('tool.showFullDiff')}
                    onClick={() =>
                      useStore.getState().setDiffPreview({
                        path: d.path,
                        rel: d.rel,
                        before: d.before,
                        after: d.after,
                        kind: d.kind
                      })
                    }
                  >
                    <Icon name="external" size={10} />
                  </button>
                </div>
                <DiffView before={d.before} after={d.after} rel={d.rel} maxHeight={settings.alphaFeatures ? 900 : 340} />
              </div>
            ))
          ) : call.output ? (
            <pre className="tool-output">{call.output.length > 6000 ? call.output.slice(0, 6000) + '\n' + t('tool.truncated') : call.output}</pre>
          ) : null}
          {call.error && <pre className="tool-error">{call.error}</pre>}
          {call.locale && (
            <div className="tool-hint">
              <Icon name="info" size={11} />
              <span>{call.locale}</span>
            </div>
          )}
          {call.status === 'running' && <div className="tool-running"><span className="spinner" /> {t(meta.verb)}…</div>}
        </div>
      )}
    </div>
  )
}

function ApprovalInline({ call }: { call: ToolResultView }): React.ReactElement {
  const t = useT()
  const approve = useStore((s) => s.approve)
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="approval">
      <div className="approval-head">
        <Icon name="shield" size={13} className="warn" />
        <span className="t-sm">
          {t('tool.combWants', { verb: TOOL_META[call.name] ? t(TOOL_META[call.name].verb) : t('tool.verbRunning') })}
        </span>
      </div>
      {call.name === 'run_command' && <pre className="approval-code">$ {String(call.args.command || '')}</pre>}
      {(call.name === 'write_file') && (
        <pre className="approval-code">
          {String(call.args.path || '')} · {t('tool.diffLines', { n: String(call.args.content || '').split('\n').length })}
        </pre>
      )}
      {(call.name === 'edit_file' || call.name === 'multi_edit') && !expanded && (
        <pre className="approval-code">
          {call.args.edits
            ? t('tool.editsInFiles', { n: call.args.edits.length, f: new Set(call.args.edits.map((e: any) => e.path)).size })
            : `${String(call.args.path || '')}\n- ${String(call.args.old_string || '').slice(0, 200).split('\n').join('\n- ')}\n+ ${String(call.args.new_string || '').slice(0, 200).split('\n').join('\n+ ')}`}
        </pre>
      )}
      {(call.name === 'delete_path' || call.name === 'move_path') && (
        <pre className="approval-code">
          {call.name === 'delete_path' ? `delete ${call.args.path}` : `${call.args.from} → ${call.args.to}`}
        </pre>
      )}
      <div className="approval-actions">
        <button className="btn primary sm" onClick={() => void approve('allow')}>
          <Icon name="check" size={11} /> {t('tool.allow')} <kbd style={{ opacity: 0.6 }}>↵</kbd>
        </button>
        <button
          className="btn sm"
          data-tip={t('tool.alwaysAllow', { tool: call.name })}
          onClick={() => void approve('allow-always')}
        >
          {t('tool.alwaysShort')}
        </button>
        <button className="btn danger sm" onClick={() => void approve('deny')}>
          {t('tool.deny')}
        </button>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('common.less') : t('common.details')}
        </button>
      </div>
    </div>
  )
}


/** File the agent handed to the user: preview, open, reveal. */
function AttachCard({ call }: { call: ToolResultView }): React.ReactElement {
  const t = useT()
  const setFilePreview = useStore((s) => s.setFilePreview)
  const a = call.attach!
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(a.path)
  const [thumb, setThumb] = useState('')
  React.useEffect(() => {
    if (!isImage) return
    void window.comb.fs.readImage(a.path).then((r) => {
      if (r?.ok && r.dataUrl) setThumb(r.dataUrl)
    })
  }, [a.path, isImage])

  return (
    <div className="attach-card">
      <button className="attach-main" onClick={() => setFilePreview({ path: a.path, rel: a.rel, note: a.note })}>
        <span className="attach-thumb">
          {thumb ? <img src={thumb} alt={a.rel} /> : <Icon name="file" size={16} className="acc" />}
        </span>
        <span className="col" style={{ gap: 2, minWidth: 0, alignItems: 'flex-start' }}>
          <span className="t-sm ellipsis" style={{ fontWeight: 600 }}>{a.rel.split('/').pop()}</span>
          <span className="t-xs faint ellipsis">{a.rel}</span>
          {a.note && <span className="t-xs dim ellipsis">{a.note}</span>}
        </span>
      </button>
      <span className="spacer" />
      <button className="btn ghost sm" onClick={() => window.comb.app.showItemInFolder(a.path)} data-tip={a.path}>
        <Icon name="folder" size={11} /> {t('fp.reveal')}
      </button>
      <button className="btn primary sm" onClick={() => setFilePreview({ path: a.path, rel: a.rel, note: a.note })}>
        {t('fp.preview')}
      </button>
    </div>
  )
}
