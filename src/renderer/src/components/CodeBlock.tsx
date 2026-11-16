import React, { useMemo, useState } from 'react'
import { highlightLine } from '../lib/highlight'
import { Icon } from './Icon'
import { useStore } from '../store'

export function CodeBlock({
  code,
  lang,
  file,
  maxHeight,
  lineNumbers = true,
  showHeader = true
}: {
  code: string
  lang: string
  file?: string
  maxHeight?: number
  lineNumbers?: boolean
  showHeader?: boolean
}): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const toast = useStore((s) => s.toast)
  const lines = useMemo(() => code.replace(/\r\n/g, '\n').split('\n'), [code])
  const html = useMemo(() => lines.map((l) => highlightLine(l, lang)), [lines, lang])

  const copy = (): void => {
    window.comb.clipboard.write(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const insertIntoFile = async (): Promise<void> => {
    const active = useStore.getState().tabs.find((t) => t.path === useStore.getState().activeTabPath)
    if (!active) {
      toast('warn', 'Open a file first')
      return
    }
    const res = window.confirm(`Replace the contents of ${active.rel} with this block?`)
    if (!res) return
    useStore.getState().setTabContent(active.path, code)
    await useStore.getState().saveTab(active.path)
    toast('ok', `Written to ${active.rel}`)
  }

  const long = lines.length > 26

  return (
    <div className="code-block">
      {showHeader && (
        <div className="code-head">
          <span className="code-lang">{lang || 'text'}</span>
          {file && <span className="code-file">{file}</span>}
          <span className="spacer" />
          <span className="faint t-xs">{lines.length} lines</span>
          <div className="code-actions">
            {file && (
              <button className="code-action" onClick={() => void insertIntoFile()} data-tip="Write into the open file">
                <Icon name="save" size={10} /> write
              </button>
            )}
            <button className="code-action" onClick={copy}>
              <Icon name={copied ? 'check' : 'copy'} size={10} /> {copied ? 'copied' : 'copy'}
            </button>
          </div>
        </div>
      )}
      <div
        className="code-body"
        style={{
          maxHeight: collapsed ? 120 : maxHeight || (long ? 420 : undefined),
          overflowY: long && !collapsed ? 'auto' : 'visible'
        }}
      >
        {html.map((h, i) => (
          <div className="code-line" key={i}>
            {lineNumbers && <span className="ln">{i + 1}</span>}
            <span className="lc" dangerouslySetInnerHTML={{ __html: h || ' ' }} />
          </div>
        ))}
      </div>
      {long && (
        <button className="code-expand" onClick={() => setCollapsed((v) => !v)}>
          <Icon name={collapsed ? 'chevron-down' : 'chevron-down'} size={10} style={{ transform: collapsed ? 'none' : 'rotate(180deg)' }} />
          {collapsed ? `show all ${lines.length} lines` : 'collapse'}
        </button>
      )}
    </div>
  )
}

/** Side-by-side / unified diff view. */
export function DiffView({
  before,
  after,
  rel,
  maxHeight = 460
}: {
  before: string
  after: string
  rel: string
  maxHeight?: number
}): React.ReactElement {
  const [mode, setMode] = useState<'unified' | 'split'>('unified')
  const lang = rel.split('.').pop() || 'text'

  const unified = useMemo(() => {
    const a = before.replace(/\r\n/g, '\n').split('\n')
    const b = after.replace(/\r\n/g, '\n').split('\n')
    return buildUnified(a, b)
  }, [before, after])

  const stats = useMemo(() => {
    let add = 0
    let del = 0
    for (const row of unified) {
      if (row.type === 'add') add++
      if (row.type === 'del') del++
    }
    return { add, del }
  }, [unified])

  return (
    <div className="diff-view">
      {mode === 'unified' ? (
        <div className="code-body diff-body" style={{ maxHeight, overflowY: 'auto' }}>
          {unified.map((row, i) => (
            <div className={`code-line ${row.type === 'add' ? 'added' : row.type === 'del' ? 'removed' : ''}`} key={i}>
              <span className="ln">{row.oldLine ?? ''}</span>
              <span className="ln">{row.newLine ?? ''}</span>
              <span className="marker">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}</span>
              <span className="lc" dangerouslySetInnerHTML={{ __html: highlightLine(row.text, lang) || ' ' }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="diff-split" style={{ maxHeight }}>
          <div className="diff-split-col">
            <div className="diff-split-head">before</div>
            <div className="code-body">
              {before.split('\n').map((l, i) => (
                <div className="code-line" key={i}>
                  <span className="ln">{i + 1}</span>
                  <span className="lc" dangerouslySetInnerHTML={{ __html: highlightLine(l, lang) || ' ' }} />
                </div>
              ))}
            </div>
          </div>
          <div className="diff-split-col">
            <div className="diff-split-head">after</div>
            <div className="code-body">
              {after.split('\n').map((l, i) => (
                <div className="code-line" key={i}>
                  <span className="ln">{i + 1}</span>
                  <span className="lc" dangerouslySetInnerHTML={{ __html: highlightLine(l, lang) || ' ' }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="diff-foot">
        <span className="ok">+{stats.add}</span>
        <span className="err">−{stats.del}</span>
        <span className="spacer" />
        <div className="segmented">
          <button data-active={mode === 'unified'} onClick={() => setMode('unified')}>
            unified
          </button>
          <button data-active={mode === 'split'} onClick={() => setMode('split')}>
            split
          </button>
        </div>
      </div>
    </div>
  )
}

export interface DiffRow {
  type: 'ctx' | 'add' | 'del'
  text: string
  oldLine?: number
  newLine?: number
}

/** Simple LCS-based unified diff, collapsed to hunks with 3 context lines. */
export function buildUnified(a: string[], b: string[], context = 3): DiffRow[] {
  const n = a.length
  const m = b.length
  // trim common prefix/suffix
  let start = 0
  while (start < n && start < m && a[start] === b[start]) start++
  let endA = n
  let endB = m
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  // LCS DP on the changed middle (bounded to keep it fast)
  const rows: DiffRow[] = []
  for (let i = 0; i < start; i++) rows.push({ type: 'ctx', text: a[i], oldLine: i + 1, newLine: i + 1 })

  if (midA.length * midB.length > 4_000_000) {
    // too big: naive block diff
    midA.forEach((line, i) => rows.push({ type: 'del', text: line, oldLine: start + i + 1 }))
    midB.forEach((line, i) => rows.push({ type: 'add', text: line, newLine: start + i + 1 }))
  } else {
    const dp: number[][] = Array.from({ length: midA.length + 1 }, () => new Array(midB.length + 1).fill(0))
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        rows.push({ type: 'ctx', text: midA[i], oldLine: start + i + 1, newLine: start + j + 1 })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        rows.push({ type: 'del', text: midA[i], oldLine: start + i + 1 })
        i++
      } else {
        rows.push({ type: 'add', text: midB[j], newLine: start + j + 1 })
        j++
      }
    }
    while (i < midA.length) {
      rows.push({ type: 'del', text: midA[i], oldLine: start + i + 1 })
      i++
    }
    while (j < midB.length) {
      rows.push({ type: 'add', text: midB[j], newLine: start + j + 1 })
      j++
    }
  }
  for (let k = 0; k < n - endA; k++) {
    rows.push({ type: 'ctx', text: a[endA + k], oldLine: endA + k + 1, newLine: endB + k + 1 })
  }
  return rows
}
