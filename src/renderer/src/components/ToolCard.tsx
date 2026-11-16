import React, { useState } from 'react'
import type { ToolResultView } from '../../../shared/types'
import { Icon, type IconName } from './Icon'
import { DiffView } from './CodeBlock'
import { useStore } from '../store'

const TOOL_META: Record<string, { icon: IconName; label: string; verb: string }> = {
  read_file: { icon: 'file', label: 'Read', verb: 'reading' },
  write_file: { icon: 'save', label: 'Write', verb: 'writing' },
  edit_file: { icon: 'edit', label: 'Edit', verb: 'editing' },
  multi_edit: { icon: 'edit', label: 'Multi-edit', verb: 'editing' },
  list_dir: { icon: 'folder', label: 'List', verb: 'listing' },
  glob: { icon: 'search', label: 'Glob', verb: 'matching' },
  grep: { icon: 'search', label: 'Grep', verb: 'searching' },
  run_command: { icon: 'terminal', label: 'Run', verb: 'running' },
  delete_path: { icon: 'trash', label: 'Delete', verb: 'deleting' },
  move_path: { icon: 'arrow-right', label: 'Move', verb: 'moving' },
  todo_write: { icon: 'check', label: 'Plan', verb: 'planning' },
  ask_user: { icon: 'chat', label: 'Ask', verb: 'asking' },
  finish: { icon: 'check-circle', label: 'Done', verb: 'finishing' }
}

function summarise(call: ToolResultView): string {
  const a = call.args || {}
  switch (call.name) {
    case 'read_file':
      return a.path || ''
    case 'write_file':
    case 'edit_file':
    case 'multi_edit':
      return a.path || (a.edits ? `${a.edits.length} edits` : '')
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
      return `${(a.todos || []).length} steps`
    case 'finish':
      return 'summary'
    default:
      return ''
  }
}

function statusPill(status: ToolResultView['status']): React.ReactElement {
  switch (status) {
    case 'running':
      return (
        <span className="tool-status running">
          <span className="spinner" />
        </span>
      )
    case 'awaiting-approval':
      return <span className="tool-status warn">needs approval</span>
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
      return <span className="tool-status err">denied</span>
    case 'aborted':
      return <span className="tool-status faint">stopped</span>
    default:
      return <span className="tool-status faint">queued</span>
  }
}

export function ToolCard({ call }: { call: ToolResultView }): React.ReactElement {
  const meta = TOOL_META[call.name] || { icon: 'zap' as IconName, label: call.name, verb: call.name }
  const [open, setOpen] = useState(false)
  const hasDiff = !!call.diff?.length
  const wantsOpen = call.status === 'error' || call.status === 'awaiting-approval'
  const expanded = open || wantsOpen
  const settings = useStore((s) => s.settings)
  const openFile = useStore((s) => s.openFile)
  const workspace = useStore((s) => s.workspace)
  const diff = call.diff?.reduce((a, d) => ({ add: a.add + d.additions, del: a.del + d.deletions }), { add: 0, del: 0 })

  return (
    <div className="tool-card" data-status={call.status}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={9} className="tool-caret" />
        <Icon name={meta.icon} size={11} className="tool-icon" />
        <span className="tool-label">{meta.label}</span>
        <span className="tool-arg ellipsis">{summarise(call)}</span>
        {diff && (diff.add > 0 || diff.del > 0) && (
          <span className="tool-stats">
            <span className="ok">+{diff.add}</span>
            <span className="err">−{diff.del}</span>
          </span>
        )}
        {call.durationMs ? <span className="tool-time faint">{call.durationMs < 1000 ? `${call.durationMs}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}</span> : null}
        {statusPill(call.status)}
      </button>

      {expanded && (
        <div className="tool-body">
          {call.status === 'awaiting-approval' && <ApprovalInline call={call} />}
          {call.status === 'denied' && <div className="tool-note err">Action denied by you.</div>}

          {hasDiff ? (
            (call.diff || []).map((d, i) => (
              <div key={i} className="tool-diff">
                <div className="tool-diff-head">
                  <span className={`pill ${d.kind === 'create' ? 'ok' : d.kind === 'delete' ? 'err' : 'acc'}`}>
                    {d.kind === 'create' ? 'new file' : d.kind === 'delete' ? 'deleted' : 'modified'}
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
                    data-tip="Show full diff"
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
            <pre className="tool-output">{call.output.length > 6000 ? call.output.slice(0, 6000) + '\n… truncated' : call.output}</pre>
          ) : null}
          {call.error && <pre className="tool-error">{call.error}</pre>}
          {call.status === 'running' && <div className="tool-running"><span className="spinner" /> {meta.verb}…</div>}
        </div>
      )}
    </div>
  )
}

function ApprovalInline({ call }: { call: ToolResultView }): React.ReactElement {
  const approve = useStore((s) => s.approve)
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="approval">
      <div className="approval-head">
        <Icon name="shield" size={13} className="warn" />
        <span className="t-sm">
          Comb wants to <strong>{(TOOL_META[call.name]?.verb || 'run').replace('…', '')}</strong> — review before allowing.
        </span>
      </div>
      {call.name === 'run_command' && <pre className="approval-code">$ {String(call.args.command || '')}</pre>}
      {(call.name === 'write_file') && (
        <pre className="approval-code">
          {String(call.args.path || '')} · {String(call.args.content || '').split('\n').length} lines
        </pre>
      )}
      {(call.name === 'edit_file' || call.name === 'multi_edit') && !expanded && (
        <pre className="approval-code">
          {call.args.edits
            ? `${call.args.edits.length} edits in ${new Set(call.args.edits.map((e: any) => e.path)).size} file(s)`
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
          <Icon name="check" size={11} /> Allow <kbd style={{ opacity: 0.6 }}>↵</kbd>
        </button>
        <button className="btn sm" onClick={() => void approve('allow-always')}>
          Always allow {call.name}
        </button>
        <button className="btn danger sm" onClick={() => void approve('deny')}>
          Deny
        </button>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'less' : 'details'}
        </button>
      </div>
    </div>
  )
}
