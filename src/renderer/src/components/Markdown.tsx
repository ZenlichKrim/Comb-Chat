import React, { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { CodeBlock } from './CodeBlock'
import { useStore } from '../store'

export function Markdown({ text }: { text: string }): React.ReactElement {
  const segments = useMemo(() => renderMarkdown(text), [text])
  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    // a path mentioned by the agent opens in the editor, at the right line
    const ref = (e.target as HTMLElement).closest('a.code-ref') as HTMLAnchorElement | null
    if (ref) {
      e.preventDefault()
      const file = ref.getAttribute('data-file') || ''
      const line = Number(ref.getAttribute('data-line') || 0)
      void openRef(file, line)
      return
    }
    const target = (e.target as HTMLElement).closest('a[data-href]') as HTMLAnchorElement | null
    if (target) {
      e.preventDefault()
      const href = target.getAttribute('data-href') || ''
      if (/^https?:/i.test(href)) window.comb.app.openExternal(href)
    }
  }
  return (
    <div className="md" onClick={onClick}>
      {segments.map((s, i) =>
        s.kind === 'code' ? (
          <CodeBlock key={i} code={s.code || ''} lang={s.lang || 'text'} file={s.file} />
        ) : (
          <div key={i} dangerouslySetInnerHTML={{ __html: s.html || '' }} />
        )
      )}
    </div>
  )
}

/**
 * Resolve a path the agent wrote against the open roots and show it.
 * Links only ever point at files, so a miss is a quiet no-op rather than a toast
 * storm when the model names something outside the project.
 */
async function openRef(file: string, line: number): Promise<void> {
  const st = useStore.getState()
  const roots = [st.workspace, ...st.extraRoots].filter((r): r is string => !!r)
  if (!roots.length) return
  for (const root of roots) {
    const abs = `${root.replace(/[\\/]+$/, '')}/${file}`
    const exists = await window.comb.fs.exists(abs).catch(() => false)
    if (!exists) continue
    await st.openFile(abs, file)
    if (line > 0) {
      // the editor mounts asynchronously after the tab opens
      setTimeout(() => window.dispatchEvent(new CustomEvent('comb:goto-line', { detail: { line } })), 120)
    }
    return
  }
}
